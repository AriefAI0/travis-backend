import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { env } from "../../../src/config/env";
import { minio } from "../../../src/lib/minio_storage/clients";
import { generateSegments } from "../../helpers/fixtures";
import { startServer, type TestServer } from "../../helpers/server";

const SEG_COUNT = 45;
const DATA_DIR = "./data/test-e2e";
const SEG_DIR = "/tmp/travis-e2e-segs";

let server: TestServer;
let segBytes: Uint8Array[];

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

beforeAll(async () => {
  const segPaths = await generateSegments(SEG_DIR, SEG_COUNT);
  segBytes = await Promise.all(segPaths.map(async (p) => new Uint8Array(await Bun.file(p).arrayBuffer())));
  server = await startServer({ PART_SIZE_BYTES: String(5 * 1024 * 1024), DATA_DIR });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(SEG_DIR, { recursive: true, force: true });
});

test(
  "happy path: 45 segments sewn into exactly one object with exact bytes",
  async () => {
    const createRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appSessionId: "session-e2e-happy", kind: "master" }),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = await createRes.json();
    const id = created.id;
    expect(created.status).toBe("recording");

    let midStreamDurable = -1;
    for (let i = 0; i < SEG_COUNT; i++) {
      const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/segments?index=${i}`, {
        method: "POST",
        headers: { "content-type": "video/mp2t" },
        body: segBytes[i],
      });
      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.receivedIndex).toBe(i);
      midStreamDurable = Math.max(midStreamDurable, data.durableThrough);
    }
    // ≥1 part (5 MB) must have flushed during ingest, not only at stop
    expect(midStreamDurable).toBeGreaterThanOrEqual(0);

    // idempotent replay of an already-durable index changes nothing
    const replay = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/segments?index=0`, {
      method: "POST",
      headers: { "content-type": "video/mp2t" },
      body: segBytes[0],
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.durableThrough).toBe(midStreamDurable);

    const stopRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    expect(stopRes.status).toBe(202);
    expect((await stopRes.json()).data.status).toBe("finalizing");

    const statusRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}`);
    const status = (await statusRes.json()).data;
    expect(status.status).toBe("finalizing");
    expect(status.durableThrough).toBe(SEG_COUNT - 1);

    const key = `recordings/${id}/master.ts`;
    const stat = await minio.statObject(env.BUCKET_MASTER, key);
    const total = segBytes.reduce((n, b) => n + b.byteLength, 0);
    expect(stat.size).toBe(total);

    const listed: string[] = [];
    for await (const obj of minio.listObjects(env.BUCKET_MASTER, `recordings/${id}/`, false)) {
      listed.push(obj.name);
    }
    expect(listed).toEqual([key]);

    const objectBytes = new Uint8Array(
      await new Response(await minio.getObject(env.BUCKET_MASTER, key)).arrayBuffer(),
    );
    expect(sha256(objectBytes)).toBe(sha256Concat(segBytes));

    await minio.removeObject(env.BUCKET_MASTER, key);
  },
  180_000,
);

test(
  "duplicate create for same appSessionId+kind → 409",
  async () => {
    const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appSessionId: "session-e2e-happy", kind: "master" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("duplicate_session");
  },
  30_000,
);

test(
  "unknown id → 404 problem+json; bad requests → 400",
  async () => {
    const notFound = await fetch(`${server.baseUrl}/api/minio_handler/sessions/does-not-exist`);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("content-type")).toContain("application/problem+json");

    const createRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appSessionId: "session-e2e-validation", kind: "clip" }),
    });
    const id = (await createRes.json()).data.id;

    const noIndex = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/segments`, { method: "POST", body: segBytes[0] });
    expect(noIndex.status).toBe(400);

    const emptyBody = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/segments?index=3`, { method: "POST" });
    expect(emptyBody.status).toBe(400);

    const badBody = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appSessionId: "x" }),
    });
    expect(badBody.status).toBe(400);

    // stop with zero segments: no part may be uploaded → finalized empty
    const stopRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    expect(stopRes.status).toBe(202);
    expect((await stopRes.json()).data.status).toBe("finalized");
    const status = (await (await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}`)).json()).data;
    expect(status.artifactStatus).toBe("none");
  },
  60_000,
);

test(
  "heartbeat works and reports durableThrough",
  async () => {
    const createRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appSessionId: "session-e2e-heartbeat", kind: "clip" }),
    });
    const id = (await createRes.json()).data.id;
    const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/heartbeat`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.durableThrough).toBe(-1);
    await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
  },
  30_000,
);

test(
  "out-of-order + duplicate re-POSTs sew exactly once",
  async () => {
    const createRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appSessionId: "session-e2e-order", kind: "master" }),
    });
    expect(createRes.status).toBe(201);
    const id = (await createRes.json()).data.id;

    // holes hold; a buffered dup replaces its slot; a post-flush dup is discarded
    const order = [0, 2, 4, 5, 6, 2, 3, ...Array.from({ length: SEG_COUNT - 7 }, (_, i) => i + 7), 1, 0];
    for (const i of order) {
      const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/segments?index=${i}`, {
        method: "POST",
        headers: { "content-type": "video/mp2t" },
        body: segBytes[i],
      });
      expect(res.status).toBe(200);
    }

    const stopRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    expect(stopRes.status).toBe(202);

    const key = `recordings/${id}/master.ts`;
    const stat = await minio.statObject(env.BUCKET_MASTER, key);
    expect(stat.size).toBe(segBytes.reduce((n, b) => n + b.byteLength, 0));

    const objectBytes = new Uint8Array(
      await new Response(await minio.getObject(env.BUCKET_MASTER, key)).arrayBuffer(),
    );
    expect(sha256(objectBytes)).toBe(sha256Concat(segBytes)); // each index present exactly once

    await minio.removeObject(env.BUCKET_MASTER, key);
  },
  180_000,
);
