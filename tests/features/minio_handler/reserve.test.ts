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

// flow: seed row > flip to recording > POST reserve via the real route
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
    storageStem: `reserve-test/${id}`,
  });
  tracker.setRecording(id, `upload-${id}`);
  return id;
};

const reserve = (id: string) =>
  app.request(`/api/minio_handler/sessions/${id}/parts`, { method: "POST" });

afterAll(() => {
  // flow: tests done > delete only this file's sessions
  if (!ids.length) return;
  db.run(`DELETE FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
});

test("first reserve returns part 1 with a presigned PUT ticket", async () => {
  const id = newRecording();
  const res = await reserve(id);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.data.partNumber).toBe(1);
  expect(body.data.expiresInSeconds).toBe(300);
  expect(body.data.url).toContain("partNumber=1");
  expect(body.data.url).toContain(`uploadId=upload-${id}`);
  expect(body.data.url).toContain(`reserve-test/${id}.ts`);
});

test("reserve is sticky: repeated calls return the same part number", async () => {
  const id = newRecording();
  const first = (await (await reserve(id)).json()).data;
  const second = (await (await reserve(id)).json()).data;
  expect(second.partNumber).toBe(first.partNumber); // counter never moves on reserve
  expect(second.url).toBeTruthy(); // fresh ticket each call
});

test("reserve flips a stale session back to recording", async () => {
  const id = newRecording();
  tracker.setStatus(id, "stale");
  const res = await reserve(id);
  expect(res.status).toBe(200);
  expect(tracker.getSession(id)!.status).toBe("recording");
});

test("reserve on a stopping session returns 409 wrong_state", async () => {
  const id = newRecording();
  tracker.setStatus(id, "stopping");
  const res = await reserve(id);
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("wrong_state");
});

test("reserve on an uninitialized upload returns 409 wrong_state", async () => {
  const id = crypto.randomUUID(); // 'created' row: initiate never ran
  ids.push(id);
  tracker.createSession({
    id,
    identityString: `app-${id}`,
    projectId: 1,
    sessionId: 1,
    kind: "master",
    bucket: "travis-raw",
    storageStem: `reserve-test/${id}`,
  });
  const res = await reserve(id);
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("wrong_state");
});

test("reserve on an unknown session returns 404", async () => {
  const res = await reserve("does-not-exist");
  expect(res.status).toBe(404);
});
