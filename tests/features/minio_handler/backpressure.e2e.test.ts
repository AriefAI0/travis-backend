import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { env } from "../../../src/config/env";
import { minio } from "../../../src/lib/minio_storage/clients";
import { generateSegments } from "../../helpers/fixtures";
import { json } from "../../helpers/json";
import { startServer, type TestServer } from "../../helpers/server";
import { tcpProxy, type TcpProxy } from "../../helpers/proxy";

// Outage proofs (spec Testing #5 + #6): MinIO cut mid-session (via a killable
// TCP proxy) → segment POSTs degrade to 503 storage_unavailable, then 503
// backpressure once the RAM cap fills; /health stays 200 while /health/ready
// and session-create go 503; after MinIO returns the session resumes and the
// final object is byte-identical to every segment sent.
const SEG_COUNT = 80; // testsrc segments run ~150KB — need >5MB for a part + cap headroom
const PART = String(5 * 1024 * 1024); // S3 minimum part size
const CAP = String(6 * 1024 * 1024); // crossed mid-outage: 5MB part first, then cap
const DATA_DIR = "./data/test-e2e-backpressure";
const SEG_DIR = "/tmp/travis-e2e-segs-backpressure";

let segBytes: Uint8Array[];
let server: TestServer;
let proxy: TcpProxy;

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

async function postSeg(id: string, idx: number) {
  return fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/segments?index=${idx}`, {
    method: "POST",
    headers: { "content-type": "video/mp2t" },
    body: segBytes[idx],
  });
}

async function getStatus(id: string) {
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}`);
  expect(res.status).toBe(200); // status reads local sqlite — outage must not break it
  return (await json(res)).data;
}

async function pollReady(want: boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const res = await fetch(`${server.baseUrl}/health/ready`);
    const body = await json(res);
    if (body.data.ready === want) return body.data;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`/health/ready did not report ready=${want} within ${ms}ms`);
}

beforeAll(async () => {
  const segPaths = await generateSegments(SEG_DIR, SEG_COUNT);
  segBytes = await Promise.all(segPaths.map(async (p) => new Uint8Array(await Bun.file(p).arrayBuffer())));

  // proxy fronts the real MinIO; the server talks only to the proxy
  const target = new URL(env.MINIO_ENDPOINT);
  proxy = tcpProxy(Number(target.port), target.hostname);
  server = await startServer({
    MINIO_ENDPOINT: `http://127.0.0.1:${proxy.port}`,
    PART_SIZE_BYTES: PART,
    BUFFER_CAP_BYTES: CAP,
    DATA_DIR,
  });
}, 120_000);

afterAll(async () => {
  await server?.stop().catch(() => {});
  proxy?.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(SEG_DIR, { recursive: true, force: true });
});

test(
  "MinIO outage: 503s + bounded buffer, then resume to a byte-identical object",
  async () => {
    // healthy start: open a session and buffer a sub-part prefix
    const createRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "master", projectId: 1, sessionId: 1, recordingId: 401 }),
    });
    expect(createRes.status).toBe(201);
    const id = ((await createRes.json()) as { data: { id: string } }).data.id;

    for (let i = 0; i <= 5; i++) expect((await postSeg(id, i)).status).toBe(200);

    // cut MinIO off — health gates go down but liveness stays up (spec #6)
    proxy.disconnect();
    const alive = await fetch(`${server.baseUrl}/health`);
    expect(alive.status).toBe(200);
    expect((await pollReady(false, 10_000)).ready).toBe(false);
    const createWhileDown = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "master", projectId: 1, sessionId: 1, recordingId: 402 }),
    });
    expect(createWhileDown.status).toBe(503);

    // keep sending: buffer grows past the part threshold (upload attempts fail
    // → 503 storage_unavailable) until the cap is hit → 503 backpressure
    const seen: Record<string, number> = {};
    for (let idx = 6; idx < SEG_COUNT; idx++) {
      const res = await postSeg(id, idx);
      const body = res.status === 200 ? null : ((await res.json()) as { code?: string });
      const code = body?.code ?? "ok";
      seen[code] = (seen[code] ?? 0) + 1;
      if (code === "backpressure") break; // RAM is bounded — stop pumping
    }
    expect(seen.backpressure, JSON.stringify(seen)).toBeGreaterThanOrEqual(1);
    expect(seen.storage_unavailable, JSON.stringify(seen)).toBeGreaterThanOrEqual(1);

    // outage does not corrupt session state — still readable, still recording
    const duringOutage = await getStatus(id);
    expect(duringOutage.status).toBe("recording");

    // MinIO returns: ready flips back, buffered bytes flush, session resumes
    proxy.reconnect();
    await pollReady(true, 10_000);

    // app contract: re-send from durableThrough+1 (replaces buffered slots)
    const durable = (await getStatus(id)).durableThrough as number;
    for (let i = durable + 1; i < SEG_COUNT; i++) {
      const res = await postSeg(id, i);
      expect(res.status, `segment ${i}`).toBe(200);
    }

    const stopRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    const stopBody = await stopRes.text();
    expect(stopRes.status, stopBody).toBe(202);

    // object is byte-identical to the uninterrupted equivalent
    const key = `p1/s1/master_401.ts`;
    const stat = await minio.statObject(env.BUCKET_RAW, key);
    expect(stat.size).toBe(segBytes.reduce((n, b) => n + b.byteLength, 0));
    const objectBytes = new Uint8Array(
      await new Response(await minio.getObject(env.BUCKET_RAW, key)).arrayBuffer(),
    );
    expect(sha256(objectBytes)).toBe(sha256Concat(segBytes));

    // artifacts mint + fetch after finalize — full lifecycle survived the outage
    const end = Date.now() + 180_000;
    for (;;) {
      const st = await getStatus(id);
      if (st.status === "finalized") break;
      if (Date.now() > end) {
        throw new Error(`did not finalize within 180s (status ${st.status})\nserver logs:\n${server.logs().join("\n")}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const arts = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/artifacts`);
    expect(arts.status).toBe(200);
    const manifestUrl = ((await arts.json()) as { data: { hls: { manifest: string } } }).data.hls.manifest;
    const manifest = await (await fetch(manifestUrl)).text();
    expect(manifest).toContain("media.ts");

    const stem = `p1/s1/master_401`;
    await minio.removeObject(env.BUCKET_RAW, `${stem}.ts`);
    await minio.removeObject(env.BUCKET_MEDIA, `${stem}/video.mkv`);
    await minio.removeObject(env.BUCKET_MEDIA, `${stem}/hls/index.m3u8`);
    await minio.removeObject(env.BUCKET_MEDIA, `${stem}/hls/media.ts`);
    await minio.removeObject(env.BUCKET_THUMBNAILS, `${stem}/poster.jpg`);
  },
  300_000,
);
