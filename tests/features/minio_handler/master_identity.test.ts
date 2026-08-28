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

type MasterTicket = {
  id: string;
  masterVideoId: number;
  storageStem: string;
  status: string;
  partSizeBytes: number;
  sessionId: number;
  displayNumber: number;
};

const armMaster = (body: Record<string, unknown>) =>
  fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// active sessions cap at 4 — every create must free its slot or later
// creates 429. Zero-part stop aborts the MPU and finalizes empty.
const stopMaster = async (id: string) => {
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
  expect(res.status).toBe(202);
};

// server-owned session identity: arm without sessionId creates the session
test("master create without sessionId creates the session and returns its identity", async () => {
  const res = await armMaster({ kind: "master", projectId: seed.projectId });
  expect(res.status).toBe(201);
  const { data } = await json<{ data: MasterTicket }>(res);

  // seeded session row carries no display number, so the first arm numbers 1
  expect(Number.isInteger(data.sessionId)).toBe(true);
  expect(data.sessionId).not.toBe(seed.sessionId);
  expect(data.displayNumber).toBe(1);
  // stem embeds the NEW session id, not the seeded one
  expect(data.storageStem).toBe(`p${seed.projectId}/s${data.sessionId}/master_${data.masterVideoId}`);

  // the session row exists and is numbered — read it back through the API
  const sessionRes = await fetch(`${server.baseUrl}/api/v1/sessions/${data.sessionId}`);
  expect(sessionRes.status).toBe(200);
  const sessionRow = await json<{ data: { projectId: number; displayNumber: number | null } }>(sessionRes);
  expect(sessionRow.data.projectId).toBe(seed.projectId);
  expect(sessionRow.data.displayNumber).toBe(1);
  await stopMaster(data.id);
});

test("second arm without sessionId increments displayNumber", async () => {
  const first = await json<{ data: MasterTicket }>(await armMaster({ kind: "master", projectId: seed.projectId }));
  const second = await json<{ data: MasterTicket }>(await armMaster({ kind: "master", projectId: seed.projectId }));
  expect(second.data.sessionId).not.toBe(first.data.sessionId);
  expect(second.data.displayNumber).toBe(first.data.displayNumber + 1);
  await stopMaster(first.data.id);
  await stopMaster(second.data.id);
});

test("master create without sessionId on a missing project is 404", async () => {
  const res = await armMaster({ kind: "master", projectId: 99_999_999 });
  expect(res.status).toBe(404);
  const body = await json(res);
  expect(body.title).toContain("project 99999999 not found");
});

test("master create with sessionId still attaches to that session", async () => {
  const res = await armMaster({ kind: "master", projectId: seed.projectId, sessionId: seed.sessionId });
  expect(res.status).toBe(201);
  const { data } = await json<{ data: MasterTicket }>(res);
  expect(data.sessionId).toBe(seed.sessionId);
  expect(data.storageStem).toBe(`p${seed.projectId}/s${seed.sessionId}/master_${data.masterVideoId}`);
  await stopMaster(data.id);
});

// clips need the live master: sessionId stays required on that arm
test("clip create without sessionId is a 400", async () => {
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "clip", projectId: seed.projectId, itemId: seed.itemId, resultId: seed.resultId }),
  });
  expect(res.status).toBe(400);
  const body = await json(res);
  expect(body.code).toBe("bad_request");
});

test("master create without sessionId rejects unknown fields (strict body)", async () => {
  const res = await armMaster({ kind: "master", projectId: seed.projectId, sessionName: "sneaky" });
  expect(res.status).toBe(400);
  const body = await json(res);
  expect(body.title).toContain("sessionName");
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
