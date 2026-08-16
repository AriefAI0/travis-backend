import { env } from "../../config/env";
import { log } from "../logger";
import { tracker, type JobRow } from "../db/minio_tracker";

// Heavy work never blocks a request: routes enqueue, this loop works the queue.
export type JobHandler = (job: JobRow) => Promise<void>;

const handlers = new Map<string, JobHandler>();
const MAX_ATTEMPTS = 3;
const POLL_MS = 1000;

// features register their job types at boot; dispatch is by type name.
export function registerJobHandler(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

// claim > dispatch > settle. True when a job ran (caller keeps draining).
async function workOnce(): Promise<boolean> {
  const job = tracker.claimNextJob();
  if (!job) return false;

  const handler = handlers.get(job.type);
  if (!handler) {
    tracker.finishJob(job.id, "failed", `no handler for job type ${job.type}`);
    log.error("job type has no handler", { job: job.id, type: job.type });
    return true;
  }

  try {
    await handler(job);
    tracker.finishJob(job.id, "done");
    log.info("job done", { job: job.id, type: job.type, session: job.session_id });
  } catch (err) {
    const msg = String(err).slice(0, 500);
    if (job.attempts >= MAX_ATTEMPTS) {
      tracker.finishJob(job.id, "failed", msg);
      log.error("job failed permanently", { job: job.id, type: job.type, session: job.session_id, err: msg });
    } else {
      tracker.requeueJob(job.id, msg);
      log.warn("job failed, retry queued", { job: job.id, type: job.type, session: job.session_id, attempt: job.attempts, err: msg });
    }
  }
  return true;
}

// flow: requeue crashed runs > start N workers > each drains then polls.
export function startQueueWorker() {
  tracker.requeueRunningJobs();

  for (let w = 0; w < env.FFMPEG_CONCURRENCY; w++) {
    void (async () => {
      for (;;) {
        let ran = false;
        try {
          ran = await workOnce();
        } catch (err) {
          log.error("queue worker error", { err: String(err) }); // claim/DB hiccup: sleep and retry
        }
        if (!ran) await new Promise((r) => setTimeout(r, POLL_MS));
      }
    })();
  }
  log.info("queue worker started", { workers: env.FFMPEG_CONCURRENCY });
}
