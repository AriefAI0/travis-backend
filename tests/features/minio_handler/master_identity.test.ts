import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { json } from "../../helpers/json";
import { seedRecordingHierarchy, type SeededHierarchy } from "../../helpers/seed";
import { startServer, type TestServer } from "../../helpers/server";

const DATA_DIR = "./data/test-master-identity";

let server: TestServer;
let seed: SeededHierarchy;

beforeAll(async () => {
  seed = await seedRecordingHierarchy();
  server = await startServer({ DATA_DIR });
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await seed?.cleanup();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// stale client-assigned ids must error loudly, never vanish into a valid create
test("master create with recordingId is a 400 naming the field", async () => {
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "master",
      projectId: seed.projectId,
      sessionId: seed.sessionId,
      recordingId: 999,
    }),
  });
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  const body = await json(res);
  expect(body.code).toBe("bad_request");
  expect(body.title).toContain("recordingId");
});

test("clip create with clipId is a 400 naming the field", async () => {
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "clip",
      projectId: seed.projectId,
      sessionId: seed.sessionId,
      itemId: seed.itemId,
      resultId: seed.resultId,
      clipId: 999,
    }),
  });
  expect(res.status).toBe(400);
  const body = await json(res);
  expect(body.code).toBe("bad_request");
  expect(body.title).toContain("clipId");
});

// response shape the app rewire reads: server-assigned id + derived stem
test("clean master create returns masterVideoId and storageStem", async () => {
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "master", projectId: seed.projectId, sessionId: seed.sessionId }),
  });
  expect(res.status).toBe(201);
  const { ok: envelope, data } = await json<{ ok: boolean; data: { masterVideoId: number; storageStem: string; status: string; partSizeBytes: number } }>(res);
  expect(envelope).toBe(true);
  expect(Number.isInteger(data.masterVideoId)).toBe(true);
  expect(data.storageStem).toBe(`p${seed.projectId}/s${seed.sessionId}/master_${data.masterVideoId}`);
  expect(data.status).toBe("recording");
  expect(data.partSizeBytes).toBeGreaterThan(0);
});
