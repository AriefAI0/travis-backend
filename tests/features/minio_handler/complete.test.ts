import { Hono } from "hono";
import { afterAll, expect, test } from "bun:test";
// module opens env.DATA_DIR sqlite on import — same side-effect acceptance
// as tracker.test.ts; rows are removed in afterAll so the shared file stays clean.
import { db, tracker } from "../../../src/lib/db/minio_tracker";
import { minioHandlerRoutes } from "../../../src/features/minio_handler/routes";
import { onError } from "../../../src/lib/error";

// app.ts mounts routes with onError — mirror that so AppErrors become responses.
const app = new Hono();
app.onError(onError);
app.route("/", minioHandlerRoutes);

const ids: string[] = [];

const newRecording = () => {
  const id = crypto.randomUUID();
  ids.push(id);
  tracker.createSession({
    id,
    identityString: `app-${id}`,
    projectId: 1,
    sessionId: 1,
    kind: "master",
    bucket: "travis-raw",
    storageStem: `complete-test/${id}`,
  });
  tracker.setRecording(id, `upload-${id}`);
  return id;
};

// flow: seed row > POST complete with etag + covered range
const complete = (id: string, partNumber: number, body: unknown) =>
  app.request(`/api/minio_handler/sessions/${id}/parts/${partNumber}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const MB = 1024 * 1024;

afterAll(() => {
  // flow: tests done > delete only this file's sessions + parts
  if (!ids.length) return;
  db.run(`DELETE FROM parts WHERE session_id IN (${ids.map(() => "?").join(",")})`, ids);
  db.run(`DELETE FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
});

test("happy path: part 1 commits etag, advances durableThrough and counter", async () => {
  const id = newRecording();
  const res = await complete(id, 1, { etag: '"etag-1"', firstIndex: 0, lastIndex: 15, sizeBytes: 16 * MB });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.durableThrough).toBe(15);
  expect(body.data.nextPartNumber).toBe(2);

  const session = tracker.getSession(id)!;
  expect(session.durable_through).toBe(15);
  expect(session.next_part_number).toBe(2);
  expect(tracker.getPart(id, 1)!.etag).toBe('"etag-1"');
});

test("contiguous part 2 continues the ledger", async () => {
  const id = newRecording();
  await complete(id, 1, { etag: '"a"', firstIndex: 0, lastIndex: 15, sizeBytes: 16 * MB });
  const res = await complete(id, 2, { etag: '"b"', firstIndex: 16, lastIndex: 31, sizeBytes: 16 * MB });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.durableThrough).toBe(31);
  expect(body.data.nextPartNumber).toBe(3);
});

test("replay with same etag acks idempotently", async () => {
  const id = newRecording();
  await complete(id, 1, { etag: '"a"', firstIndex: 0, lastIndex: 15, sizeBytes: 16 * MB });
  const res = await complete(id, 1, { etag: '"a"', firstIndex: 0, lastIndex: 15, sizeBytes: 16 * MB });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.durableThrough).toBe(15);
  expect(body.data.nextPartNumber).toBe(2);
  expect(tracker.parts(id)).toHaveLength(1); // no duplicate row
});

test("replay with different etag returns 409 wrong_part etag_mismatch", async () => {
  const id = newRecording();
  await complete(id, 1, { etag: '"a"', firstIndex: 0, lastIndex: 15, sizeBytes: 16 * MB });
  const res = await complete(id, 1, { etag: '"different"', firstIndex: 0, lastIndex: 15, sizeBytes: 16 * MB });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("wrong_part");
  expect(body.reason).toBe("etag_mismatch");
});

test("segment gap returns 409 out_of_order with resync details", async () => {
  const id = newRecording();
  await complete(id, 1, { etag: '"a"', firstIndex: 0, lastIndex: 15, sizeBytes: 16 * MB });
  const res = await complete(id, 2, { etag: '"b"', firstIndex: 17, lastIndex: 31, sizeBytes: 16 * MB });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("out_of_order");
  expect(body.durableThrough).toBe(15);
  expect(body.expected).toBe(16);
  expect(body.received).toBe(17);
});

test("wrong part number returns 409 wrong_part with expected/received", async () => {
  const id = newRecording();
  const res = await complete(id, 3, { etag: '"a"', firstIndex: 0, lastIndex: 15, sizeBytes: 16 * MB });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("wrong_part");
  expect(body.expected).toBe(1);
  expect(body.received).toBe(3);
});

test("small parts are accepted while recording (final drain precedes stop)", async () => {
  const id = newRecording();
  await complete(id, 1, { etag: '"a"', firstIndex: 0, lastIndex: 15, sizeBytes: 16 * MB });

  // the app flushes its sub-threshold tail BEFORE calling stop, while the
  // session is still 'recording' — the size minimum is MinIO's to enforce
  // at MPU complete (EntityTooSmall), not the ledger's
  const small = await complete(id, 2, { etag: '"b"', firstIndex: 16, lastIndex: 18, sizeBytes: 4 * MB });
  expect(small.status).toBe(200);
  expect((await small.json()).data.durableThrough).toBe(18);
});

test("inverted range returns 400 bad_range", async () => {
  const id = newRecording();
  const res = await complete(id, 1, { etag: '"a"', firstIndex: 20, lastIndex: 5, sizeBytes: 16 * MB });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("bad_range");
});

test("complete on a finalizing session returns 409 wrong_state", async () => {
  const id = newRecording();
  tracker.setStatus(id, "finalizing");
  const res = await complete(id, 1, { etag: '"a"', firstIndex: 0, lastIndex: 15, sizeBytes: 16 * MB });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("wrong_state");
});

test("complete on an unknown session returns 404", async () => {
  const res = await complete("does-not-exist", 1, { etag: '"a"', firstIndex: 0, lastIndex: 15, sizeBytes: 16 * MB });
  expect(res.status).toBe(404);
});

test("malformed body returns 400", async () => {
  const id = newRecording();
  const noBody = await app.request(`/api/minio_handler/sessions/${id}/parts/1/complete`, { method: "POST" });
  expect(noBody.status).toBe(400);

  const badPath = await app.request(`/api/minio_handler/sessions/${id}/parts/zero/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ etag: '"a"', firstIndex: 0, lastIndex: 1, sizeBytes: 16 * MB }),
  });
  expect(badPath.status).toBe(400);
});
