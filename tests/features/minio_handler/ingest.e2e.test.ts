import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import pg from "pg";
import { env } from "../../../src/config/env";
import { minio } from "../../../src/lib/minio_storage/clients";
import { generateSegments } from "../../helpers/fixtures";
import { json } from "../../helpers/json";
import { seedRecordingHierarchy, type SeededHierarchy } from "../../helpers/seed";
import { startServer, type TestServer } from "../../helpers/server";

const SEG_COUNT = 45;
const DATA_DIR = "./data/test-e2e";
const SEG_DIR = "/tmp/travis-e2e-segs";

let server: TestServer;
let segBytes: Uint8Array[];
let seed: SeededHierarchy;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });

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
  seed = await seedRecordingHierarchy();
  server = await startServer({ PART_SIZE_BYTES: String(5 * 1024 * 1024), DATA_DIR });
}, 120_000);

afterAll(async () => {
  await pool.end();
  await server?.stop();
  await seed.cleanup();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(SEG_DIR, { recursive: true, force: true });
});

test(
  "happy path: 45 segments sewn into exactly one object with exact bytes",
  async () => {
    const createRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "master", projectId: seed.projectId, sessionId: seed.sessionId }),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = await json(createRes);
    const id = created.id;
    expect(created.status).toBe("recording");
    // create contract inversion: server assigns the PK and returns the stem
    expect(Number.isInteger(created.masterVideoId)).toBe(true);
    const stem = `p${seed.projectId}/s${seed.sessionId}/master_${created.masterVideoId}`;
    expect(created.storageStem).toBe(stem);

    let midStreamDurable = -1;
    for (let i = 0; i < SEG_COUNT; i++) {
      const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/segments?index=${i}`, {
        method: "POST",
        headers: { "content-type": "video/mp2t" },
        body: segBytes[i],
      });
      expect(res.status).toBe(200);
      const { data } = await json(res);
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
    expect((await json(replay)).data.durableThrough).toBe(midStreamDurable);

    const stopRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    expect(stopRes.status).toBe(202);
    expect((await json(stopRes)).data.status).toBe("finalizing");

    const statusRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}`);
    const status = (await json(statusRes)).data;
    expect(status.status).toBe("finalizing");
    expect(status.durableThrough).toBe(SEG_COUNT - 1);

    const key = `${stem}.ts`;
    const stat = await minio.statObject(env.BUCKET_RAW, key);
    const total = segBytes.reduce((n, b) => n + b.byteLength, 0);
    expect(stat.size).toBe(total);

    // one prefix-list walks the whole recording
    const listed: string[] = [];
    for await (const obj of minio.listObjects(env.BUCKET_RAW, stem, false)) {
      listed.push(obj.name);
    }
    expect(listed).toEqual([key]);

    const objectBytes = new Uint8Array(
      await new Response(await minio.getObject(env.BUCKET_RAW, key)).arrayBuffer(),
    );
    expect(sha256(objectBytes)).toBe(sha256Concat(segBytes));

    await minio.removeObject(env.BUCKET_RAW, key);
  },
  180_000,
);

test(
  "each create gets a fresh server-assigned primary key",
  async () => {
    const first = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "master", projectId: seed.projectId, sessionId: seed.sessionId }),
    });
    expect(first.status).toBe(201);
    const second = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "master", projectId: seed.projectId, sessionId: seed.sessionId }),
    });
    expect(second.status).toBe(201);
    const a = (await json(first)).data;
    const b = (await json(second)).data;
    expect(b.masterVideoId).not.toBe(a.masterVideoId);
    expect(b.storageStem).not.toBe(a.storageStem);
  },
  30_000,
);

test(
  "unknown id → 404 problem+json; bad requests → 400",
  async () => {
    const notFound = await fetch(`${server.baseUrl}/api/minio_handler/sessions/does-not-exist`);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("content-type")).toContain("application/problem+json");

    // create against a session that does not exist → 404, no domain row
    const noSession = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "master", projectId: seed.projectId, sessionId: 99_999_999 }),
    });
    expect(noSession.status).toBe(404);
    expect(noSession.headers.get("content-type")).toContain("application/problem+json");

    // project mismatch with the session row → 400; stems must not lie
    const wrongProject = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "master", projectId: seed.projectId + 1, sessionId: seed.sessionId }),
    });
    expect(wrongProject.status).toBe(400);
    const wrongProjectBody = await json(wrongProject);
    expect(wrongProjectBody.code).toBe("bad_request");

    // clip against a missing result row → 404; the stem needs its type
    const noResult = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "clip",
        projectId: seed.projectId,
        sessionId: seed.sessionId,
        itemId: seed.itemId,
        resultId: 999_999_999,
      }),
    });
    expect(noResult.status).toBe(404);
    expect((await json(noResult)).code).toBe("not_found");

    const createRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "clip",
        projectId: seed.projectId,
        sessionId: seed.sessionId,
        itemId: seed.itemId,
        resultId: seed.resultId,
      }),
    });
    const id = (await json(createRes)).data.id;

    const noIndex = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/segments`, { method: "POST", body: segBytes[0] });
    expect(noIndex.status).toBe(400);

    const emptyBody = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/segments?index=3`, { method: "POST" });
    expect(emptyBody.status).toBe(400);

    const badBody = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "master", projectId: 1 }),
    });
    expect(badBody.status).toBe(400);

    // stop with zero segments: no part may be uploaded → finalized empty
    const stopRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    expect(stopRes.status).toBe(202);
    expect((await json(stopRes)).data.status).toBe("finalized");
    const status = (await json(await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}`))).data;
    expect(status.artifactStatus).toBe("none");
  },
  60_000,
);

test(
  "heartbeat works and reports durableThrough",
  async () => {
    // the out-of-order test already placed a clip on this result; one clip per
    // result (uq_video_clip_result_id), so clear it before minting ours
    await pool.query("delete from video_clip where result_id = $1", [seed.resultId]);

    const createRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "clip",
        projectId: seed.projectId,
        sessionId: seed.sessionId,
        itemId: seed.itemId,
        resultId: seed.resultId,
      }),
    });
    const id = (await json(createRes)).data.id;
    const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/heartbeat`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await json(res)).data.durableThrough).toBe(-1);
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
      body: JSON.stringify({ kind: "master", projectId: seed.projectId, sessionId: seed.sessionId }),
    });
    expect(createRes.status).toBe(201);
    const created2 = (await json(createRes)).data;
    const id = created2.id;
    const stem103 = created2.storageStem;

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

    const key = `${stem103}.ts`;
    const stat = await minio.statObject(env.BUCKET_RAW, key);
    expect(stat.size).toBe(segBytes.reduce((n, b) => n + b.byteLength, 0));

    const objectBytes = new Uint8Array(
      await new Response(await minio.getObject(env.BUCKET_RAW, key)).arrayBuffer(),
    );
    expect(sha256(objectBytes)).toBe(sha256Concat(segBytes)); // each index present exactly once

    await minio.removeObject(env.BUCKET_RAW, key);
  },
  180_000,
);
