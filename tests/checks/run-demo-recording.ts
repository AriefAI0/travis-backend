// Run one clean demo recording end to end and LEAVE the objects in MinIO for inspection.
// bun run tests/checks/run-demo-recording.ts
import { rmSync } from "node:fs";
import { masterLeaves } from "../../src/features/minio_handler/paths";
import { generateSegments } from "../helpers/fixtures";
import { json } from "../helpers/json";
import { seedRecordingHierarchy } from "../helpers/seed";
import { startServer } from "../helpers/server";

const SEG_COUNT = 45; // ~90s of video
const PART = String(5 * 1024 * 1024); // small parts so multipart flushes mid-recording
const DATA_DIR = "./data/demo-recording";
const SEG_DIR = "/tmp/travis-demo-segs";

// flow: generate > seed domain rows > create session > feed segments > stop > wait for finalize > print keys
rmSync(DATA_DIR, { recursive: true, force: true });

console.log(`generating ${SEG_COUNT} real ffmpeg segments (~90s)...`);
const segPaths = await generateSegments(SEG_DIR, SEG_COUNT);
const segBytes = await Promise.all(segPaths.map(async (p) => new Uint8Array(await Bun.file(p).arrayBuffer())));
const totalMB = (segBytes.reduce((n, b) => n + b.byteLength, 0) / 1e6).toFixed(1);
console.log(`generated: ${SEG_COUNT} segments, ${totalMB}MB total`);

// create needs a real session row: the server reads the project off it
const seed = await seedRecordingHierarchy();
console.log(`seeded: project ${seed.projectId}, session ${seed.sessionId}`);

const server = await startServer({ PART_SIZE_BYTES: PART, DATA_DIR });
console.log(`server up on ${server.baseUrl}`);

const create = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "master", projectId: seed.projectId, sessionId: seed.sessionId }),
});
if (create.status !== 201) throw new Error(`create failed: ${create.status} ${await create.text()}`);
const ticket = (await json<{ data: { id: string; masterVideoId: number; storageStem: string } }>(create)).data;
const id = ticket.id;
console.log(`session: ${id} (recording), master_video ${ticket.masterVideoId}, stem ${ticket.storageStem}`);

for (let i = 0; i < SEG_COUNT; i++) {
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/segments?index=${i}`, {
    method: "POST",
    headers: { "content-type": "video/mp2t" },
    body: segBytes[i],
  });
  if (!res.ok) throw new Error(`segment ${i} failed: ${res.status} ${await res.text()}`);
  const { data } = await json<{ data: { durableThrough: number } }>(res);
  if (i % 10 === 0 || i === SEG_COUNT - 1) console.log(`  seg ${i + 1}/${SEG_COUNT} durableThrough=${data.durableThrough}`);
}

const stop = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
console.log(`stop: ${stop.status} ${(await stop.text()).slice(0, 120)}`);

// wait for the finalize worker (ffmpeg mkv + hls + thumbnail)
const end = Date.now() + 120_000;
let status: string = "finalizing";
while (Date.now() < end) {
  const { data } = await json<{ data: { status: string } }>(
    await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}`),
  );
  if (data.status !== status) {
    status = data.status;
    console.log(`status: ${status}`);
  }
  if (status === "finalized") break;
  await new Promise((r) => setTimeout(r, 500));
}
if (status !== "finalized") throw new Error("did not finalize within 120s");

const arts = (await json<{ data: any }>(
  await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/artifacts`),
)).data;

// every key derives from the stem the server assigned — no path literals here
const leaves = masterLeaves(ticket.storageStem);
console.log(`\nfinalized in MinIO — duration ${(arts.durationMs / 1000).toFixed(1)}s, objects (left for you):`);
console.log(`  ${leaves.raw.bucket}  ${leaves.raw.key}   raw sewn TS — plays clean in VLC`);
console.log(`  ${leaves.mkv.bucket}  ${leaves.mkv.key}   finalized video — plays anywhere`);
console.log(`  ${leaves.hlsManifest.bucket}  ${leaves.hlsManifest.key}   HLS manifest`);
console.log(`  ${leaves.poster.bucket}  ${leaves.poster.key}   poster frame`);
console.log(`\npresigned URLs (valid 7 days — MinIO console objects never expire):`);
for (const [label, url] of [
  ["mkv", arts.mkv],
  ["thumbnail", arts.thumbnail],
  ["hls manifest", arts.hls.manifest],
] as [string, string][]) {
  console.log(`  ${label}: ${url}`);
}

// seed rows stay: the finalize bridge wrote master_video, and inspecting it is
// the point. Drop by hand when done.
console.log(`\nleft in Postgres — drop with:`);
console.log(`  delete from video_clip where master_video_id in (select mv.master_video_id from master_video mv join session s on s.session_id = mv.session_id where s.project_id = ${seed.projectId});`);
console.log(`  delete from project where project_id = ${seed.projectId};`);

await server.stop();
await seed.disconnect();
