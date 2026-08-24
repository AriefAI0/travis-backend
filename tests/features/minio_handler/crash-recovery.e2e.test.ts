import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { env } from "../../../src/config/env";
import { minio } from "../../../src/lib/minio_storage/clients";
import { generateSegments } from "../../helpers/fixtures";
import { json } from "../../helpers/json";
import { seedRecordingHierarchy, type SeededHierarchy } from "../../helpers/seed";
import { startServer, type TestServer } from "../../helpers/server";

// Crash-recovery proofs (spec Testing #3 + #4): SIGKILL mid-recording then
// restart on the same DATA_DIR resumes the same MPU; a silently abandoned
// session is stale-marked then truncated to its durable prefix.
const SEG_COUNT = 45;
const PART = String(5 * 1024 * 1024); // S3 minimum — smallest legal test part
const DATA_DIR_CRASH = "./data/test-e2e-crash";
const DATA_DIR_STALE = "./data/test-e2e-stale";
const SEG_DIR = "/tmp/travis-e2e-segs-crash";

let segBytes: Uint8Array[];
const servers: TestServer[] = [];
let seed: SeededHierarchy;

function sha256(bytes: Uint8Array) {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return h.digest("hex");
}

function sha256Concat(chunks: Uint8Array[]) {
  const h = new Bun.CryptoHasher("sha256");
  for (const c of chunks) h.update(c);
  return h.digest("hex");
}

async function postSeg(s: TestServer, id: string, idx: number) {
  const res = await fetch(`${s.baseUrl}/api/minio_handler/sessions/${id}/segments?index=${idx}`, {
    method: "POST",
    headers: { "content-type": "video/mp2t" },
    body: segBytes[idx],
  });
  expect(res.status).toBe(200);
  return (await json(res)).data.durableThrough as number;
}

// returns tracker id + server-assigned stem (raw key derives from it)
async function createSession(s: TestServer) {
  const res = await fetch(`${s.baseUrl}/api/minio_handler/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "master", projectId: seed.projectId, sessionId: seed.sessionId }),
  });
  expect(res.status).toBe(201);
  const data = (await json(res)).data;
  return { id: data.id as string, stem: data.storageStem as string };
}

async function pollStatus(s: TestServer, id: string, want: (d: any) => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const data = await json(await fetch(`${s.baseUrl}/api/minio_handler/sessions/${id}`));
    if (want(data.data)) return data.data;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`status did not reach expected state within ${ms}ms`);
}

beforeAll(async () => {
  const segPaths = await generateSegments(SEG_DIR, SEG_COUNT);
  segBytes = await Promise.all(segPaths.map(async (p) => new Uint8Array(await Bun.file(p).arrayBuffer())));
  seed = await seedRecordingHierarchy();
}, 120_000);

afterAll(async () => {
  for (const s of servers) await s.stop().catch(() => {});
  await seed.cleanup();
  rmSync(DATA_DIR_CRASH, { recursive: true, force: true });
  rmSync(DATA_DIR_STALE, { recursive: true, force: true });
  rmSync(SEG_DIR, { recursive: true, force: true });
});

test(
  "SIGKILL mid-recording: restart resumes the same MPU, final object byte-identical",
  async () => {
    const s1 = await startServer({ PART_SIZE_BYTES: PART, DATA_DIR: DATA_DIR_CRASH });
    servers.push(s1);
    const { id, stem } = await createSession(s1);

    // send until at least one part is durable, then stop sending
    let durable = -1;
    for (let i = 0; i < SEG_COUNT && durable < 0; i++) {
      durable = await postSeg(s1, id, i);
    }
    expect(durable).toBeGreaterThanOrEqual(0);

    s1.kill(); // hard crash: RAM buffer gone, tracker + MinIO survive

    const s2 = await startServer({ PART_SIZE_BYTES: PART, DATA_DIR: DATA_DIR_CRASH });
    servers.push(s2);
    const after = await pollStatus(s2, id, (d) => d.status === "recording", 10_000);
    expect(after.durableThrough).toBe(durable); // resume state survived the crash

    // app contract: re-send from durableThrough+1 (buffered-but-undurable segs were lost)
    for (let i = durable + 1; i < SEG_COUNT; i++) await postSeg(s2, id, i);

    const stopRes = await fetch(`${s2.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    const stopBody = await stopRes.text();
    expect(stopRes.status, stopBody).toBe(202);
    expect(JSON.parse(stopBody).data.status).toBe("finalizing");

    const key = `${stem}.ts`;
    const stat = await minio.statObject(env.BUCKET_RAW, key);
    expect(stat.size).toBe(segBytes.reduce((n, b) => n + b.byteLength, 0));

    const objectBytes = new Uint8Array(
      await new Response(await minio.getObject(env.BUCKET_RAW, key)).arrayBuffer(),
    );
    expect(sha256(objectBytes)).toBe(sha256Concat(segBytes)); // seamless vs uninterrupted run

    await minio.removeObject(env.BUCKET_RAW, key);
  },
  180_000,
);

test(
  "abandoned session: stale-marked, then truncated to the durable prefix",
  async () => {
    // short timers: stale at 2s silence, truncate at 2s + 3s grace
    const s = await startServer({
      PART_SIZE_BYTES: PART,
      DATA_DIR: DATA_DIR_STALE,
      SEGMENT_STALE_SECONDS: "2",
      RESUME_GRACE_MINUTES: "0.05",
    });
    servers.push(s);
    const { id, stem } = await createSession(s);

    let durable = -1;
    for (let i = 0; i < SEG_COUNT && durable < 0; i++) {
      durable = await postSeg(s, id, i);
    }
    expect(durable).toBeGreaterThanOrEqual(0);

    // go silent — no stop, no heartbeat. GET is passive (never touches last_seen).
    const final = await pollStatus(s, id, (d) => d.status === "finalizing" || d.status === "finalized", 30_000);
    expect(final.truncatedAt).not.toBeNull();
    expect(final.durableThrough).toBe(durable);

    // object = exactly the durable prefix (RAM-buffered tail was never durable)
    const key = `${stem}.ts`;
    const prefix = segBytes.slice(0, durable + 1);
    const stat = await minio.statObject(env.BUCKET_RAW, key);
    expect(stat.size).toBe(prefix.reduce((n, b) => n + b.byteLength, 0));
    const objectBytes = new Uint8Array(
      await new Response(await minio.getObject(env.BUCKET_RAW, key)).arrayBuffer(),
    );
    expect(sha256(objectBytes)).toBe(sha256Concat(prefix));

    await minio.removeObject(env.BUCKET_RAW, key);
  },
  120_000,
);
