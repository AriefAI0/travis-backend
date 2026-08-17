// Run one clean demo recording end to end and LEAVE the objects in MinIO for inspection.
// bun run tests/checks/run-demo-recording.ts
import { rmSync } from "node:fs";
import { generateSegments } from "../helpers/fixtures";
import { json } from "../helpers/json";
import { startServer } from "../helpers/server";

const SEG_COUNT = 45; // ~90s of video
const PART = String(5 * 1024 * 1024); // small parts so multipart flushes mid-recording
const DATA_DIR = "./data/demo-recording";
const SEG_DIR = "/tmp/travis-demo-segs";

// flow: generate > create session > feed segments > stop > wait for finalize > print keys
rmSync(DATA_DIR, { recursive: true, force: true });

console.log(`generating ${SEG_COUNT} real ffmpeg segments (~90s)...`);
const segPaths = await generateSegments(SEG_DIR, SEG_COUNT);
const segBytes = await Promise.all(segPaths.map(async (p) => new Uint8Array(await Bun.file(p).arrayBuffer())));
const totalMB = (segBytes.reduce((n, b) => n + b.byteLength, 0) / 1e6).toFixed(1);
console.log(`generated: ${SEG_COUNT} segments, ${totalMB}MB total`);

const server = await startServer({ PART_SIZE_BYTES: PART, DATA_DIR });
console.log(`server up on ${server.baseUrl}`);

const create = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ appSessionId: "demo-recording", kind: "master" }),
});
if (create.status !== 201) throw new Error(`create failed: ${create.status} ${await create.text()}`);
const id = (await json<{ data: { id: string } }>(create)).data.id;
console.log(`session: ${id} (recording)`);

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

console.log(`\nfinalized in MinIO — duration ${(arts.durationMs / 1000).toFixed(1)}s, objects (left for you):`);
console.log(`  travis-media   recordings/${id}/master.ts   raw sewn TS — plays clean in VLC`);
console.log(`  travis-mkv     ${id}.mkv                      finalized video — plays anywhere`);
console.log(`  travis-hls     ${id}/index.m3u8 + ${id}/media.ts`);
console.log(`  travis-thumbs  ${id}.jpg`);
console.log(`\npresigned URLs (valid 7 days — MinIO console objects never expire):`);
for (const [label, url] of [
  ["mkv", arts.mkv],
  ["thumbnail", arts.thumbnail],
  ["hls manifest", arts.hls.manifest],
] as [string, string][]) {
  console.log(`  ${label}: ${url}`);
}

await server.stop();
