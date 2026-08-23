import { afterAll, expect, test } from "bun:test";
// module opens env.DATA_DIR sqlite on import — same side-effect acceptance
// as tracker.test.ts; rows are removed in afterAll so the shared file stays clean.
import { db, tracker } from "../../../src/lib/db/minio_tracker";
import { registerJobHandler, workOnce } from "../../../src/lib/jobs/worker";
import { finalizeExhausted } from "../../../src/features/minio_handler/jobs/ffmpeg_finalize";

const ids: string[] = [];
const jobIds: number[] = [];

// flow: seed finalizing session > enqueue failing job > drain 3 attempts
const newFinalizing = () => {
  const id = crypto.randomUUID();
  ids.push(id);
  tracker.createSession({
    id,
    appSessionId: `app-${id}`,
    kind: "master",
    bucket: "travis-raw",
    objectKey: `worker-test/${id}`,
  });
  tracker.setStatus(id, "finalizing");
  return id;
};

afterAll(() => {
  // flow: tests done > delete only this file's sessions + jobs + parts
  if (!ids.length) return;
  db.run(`DELETE FROM jobs WHERE session_id IN (${ids.map(() => "?").join(",")})`, ids);
  db.run(`DELETE FROM parts WHERE session_id IN (${ids.map(() => "?").join(",")})`, ids);
  db.run(`DELETE FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
});

test("job that fails MAX_ATTEMPTS times flips the session to finalization_failed", async () => {
  const id = newFinalizing();
  tracker.enqueueJob(id, "test-always-fails");
  registerJobHandler("test-always-fails", async () => {
    throw new Error("boom");
  }, finalizeExhausted);

  await workOnce(); // attempt 1: requeued
  await workOnce(); // attempt 2: requeued
  await workOnce(); // attempt 3: exhausted -> hook fires

  expect(tracker.getSession(id)!.status).toBe("finalization_failed");

  const job = db.query("SELECT status, error FROM jobs WHERE session_id = ?").get(id) as { status: string; error: string };
  expect(job.status).toBe("failed");
  expect(job.error).toContain("boom");
});

test("exhausted hook leaves non-finalizing sessions untouched", async () => {
  const id = newFinalizing();
  tracker.setStatus(id, "recording"); // not in the finalizing window

  const job = db
    .query("SELECT id FROM jobs WHERE session_id = ?")
    .get(id) as { id: number } | undefined;
  if (job) jobIds.push(job.id);
  finalizeExhausted({ id: job?.id ?? 999, session_id: id, type: "finalize", attempts: 3 });

  expect(tracker.getSession(id)!.status).toBe("recording");
});

test("successful job never triggers the hook", async () => {
  const id = newFinalizing();
  tracker.enqueueJob(id, "test-succeeds");
  registerJobHandler("test-succeeds", async () => {}, finalizeExhausted);

  await workOnce();

  expect(tracker.getSession(id)!.status).toBe("finalizing"); // untouched
  const job = db.query("SELECT status FROM jobs WHERE session_id = ?").get(id) as { status: string };
  expect(job.status).toBe("done");
});
