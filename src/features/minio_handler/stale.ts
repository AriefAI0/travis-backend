import { env } from "../../config/env";
import { log } from "../../lib/logger";
import { tracker, type SessionRow } from "../../lib/db/minio_tracker";
import { finalizeRecording } from "./service";

// flow: silence > stale at SEGMENT_STALE_SECONDS > no resume > truncate at + RESUME_GRACE_MINUTES
export async function staleTick(now = Date.now()): Promise<void> {
  const graceMs = (env.SEGMENT_STALE_SECONDS + env.RESUME_GRACE_MINUTES * 60) * 1000;

  for (const session of tracker.sessionsByStatuses(["created", "recording", "stale"])) {
    const lastSeen = session.last_seen_at ?? session.created_at ?? now;
    const silentFor = now - lastSeen;

    if (session.status !== "stale" && silentFor > env.SEGMENT_STALE_SECONDS * 1000) {
      tracker.setStatus(session.id, "stale");
      log.warn("session stale", { session: session.id, silentForSec: Math.round(silentFor / 1000) });
      continue;
    }
    if (silentFor > graceMs) {
      await truncateSession(session);
    }
  }
}

// dead app: finalize the contiguous durable prefix, mark truncated (spec D6)
async function truncateSession(session: SessionRow) {
  tracker.setStatus(session.id, "truncating");
  try {
    const res = await finalizeRecording(tracker.getSession(session.id)!, { truncated: true });
    log.warn("session truncated after grace", { session: session.id, result: res.status });
  } catch (err) {
    tracker.setStatus(session.id, "stale"); // retry on a later tick
    log.error("truncate failed, will retry", { session: session.id, err: String(err) });
  }
}

export function startStaleTimer(): () => void {
  // poll at half the stale window (bounded) so detection latency stays small
  const period = Math.min(Math.max((env.SEGMENT_STALE_SECONDS * 1000) / 2, 500), 10_000);
  const handle = setInterval(() => {
    void staleTick().catch((err) => log.error("stale tick failed", { err: String(err) }));
  }, period);
  return () => clearInterval(handle);
}
