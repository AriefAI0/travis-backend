import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { recordingFinalizeJob, recordingUpload } from "../schema";

// spec 13: 60s leases renewed every 15s, five attempts, then an operational
// error surfaced with a five-minute retry cadence. Spec 9: a capture with no
// heartbeat for 15s is interrupted. Spec 12: five-second recovery debounce.
export const JOB_LEASE_SECONDS = 60;
export const JOB_LEASE_RENEWAL_SECONDS = 15;
export const JOB_MAX_ATTEMPTS = 5;
export const JOB_RETRY_SECONDS = 300;
export const HEARTBEAT_STALE_SECONDS = 15;
export const RECOVERY_DEBOUNCE_SECONDS = 5;

export type ClaimedFinalizeJob = typeof recordingFinalizeJob.$inferSelect;

// schedule (or retime) one finalize job for recording/revision. Without a
// dueAt an existing row keeps its run time; a dueAt moves it (immediate
// recovery-complete vs debounced receipts).
export const scheduleRecordingFinalize = async (
  recordingId: string,
  targetRevision: number,
  dueAt?: Date,
  database: DbOrTx = db
) => {
  const inserted = await database
    .insert(recordingFinalizeJob)
    .values({ recordingId, targetRevision, nextAttemptAt: new Date() })
    .onConflictDoUpdate({
      target: [recordingFinalizeJob.recordingId, recordingFinalizeJob.targetRevision],
      set: { nextAttemptAt: dueAt ?? sql`${recordingFinalizeJob.nextAttemptAt}` },
    })
    .returning();
  return inserted[0] ?? null;
};

// claim one due job with FOR UPDATE SKIP LOCKED in its own transaction;
// expired leases are reclaimable. Null when nothing is due.
export const claimNextRecordingFinalizeJob = async (ownerId: string, database: DbOrTx = db) => {
  return database.transaction(async (tx) => {
    const now = new Date();
    const due = await tx
      .select()
      .from(recordingFinalizeJob)
      .where(
        or(
          and(
            inArray(recordingFinalizeJob.state, ["pending", "failed"]),
            lte(recordingFinalizeJob.nextAttemptAt, now)
          ),
          and(
            eq(recordingFinalizeJob.state, "running"),
            lt(recordingFinalizeJob.leaseExpiresAt, now)
          )
        )
      )
      .orderBy(asc(recordingFinalizeJob.nextAttemptAt))
      .limit(1)
      .for("update", { skipLocked: true });
    const job = due[0];
    if (!job) return null;
    const claimed = await tx
      .update(recordingFinalizeJob)
      .set({
        state: "running",
        leaseOwnerId: ownerId,
        leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_SECONDS * 1000),
      })
      .where(eq(recordingFinalizeJob.jobId, job.jobId))
      .returning();
    return claimed[0] ?? null;
  });
};

// extend one running job's lease; null when the lease was lost
export const renewRecordingFinalizeLease = async (
  jobId: string,
  ownerId: string,
  database: DbOrTx = db
) => {
  const renewed = await database
    .update(recordingFinalizeJob)
    .set({ leaseExpiresAt: new Date(Date.now() + JOB_LEASE_SECONDS * 1000) })
    .where(
      and(
        eq(recordingFinalizeJob.jobId, jobId),
        eq(recordingFinalizeJob.leaseOwnerId, ownerId),
        eq(recordingFinalizeJob.state, "running")
      )
    )
    .returning();
  return renewed[0] ?? null;
};

// defer a running job: back to pending with a later run time, attempts
// untouched — waiting on capture or a missing range is not an error
export const deferRecordingFinalizeJob = async (
  jobId: string,
  ownerId: string,
  dueAt: Date,
  database: DbOrTx = db
) => {
  const deferred = await database
    .update(recordingFinalizeJob)
    .set({ state: "pending", nextAttemptAt: dueAt, leaseOwnerId: null, leaseExpiresAt: null })
    .where(
      and(
        eq(recordingFinalizeJob.jobId, jobId),
        eq(recordingFinalizeJob.leaseOwnerId, ownerId),
        eq(recordingFinalizeJob.state, "running")
      )
    )
    .returning();
  return deferred[0] ?? null;
};

// release after a processing error: 30s-doubling backoff up to the fifth
// attempt, then a failed verdict that still retries every five minutes
export const failRecordingFinalizeJob = async (
  jobId: string,
  ownerId: string,
  error: string,
  database: DbOrTx = db
) => {
  return database.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(recordingFinalizeJob)
      .where(eq(recordingFinalizeJob.jobId, jobId))
      .for("update");
    const job = locked[0];
    if (!job || job.leaseOwnerId !== ownerId) return null;
    const attempts = job.attempts + 1;
    const exhausted = attempts >= JOB_MAX_ATTEMPTS;
    const backoffSeconds = Math.min(30 * 2 ** (attempts - 1), JOB_RETRY_SECONDS);
    const updated = await tx
      .update(recordingFinalizeJob)
      .set({
        state: exhausted ? "failed" : "pending",
        attempts,
        lastError: error.slice(0, 500),
        nextAttemptAt: new Date(Date.now() + (exhausted ? JOB_RETRY_SECONDS : backoffSeconds) * 1000),
        leaseOwnerId: null,
        leaseExpiresAt: null,
      })
      .where(eq(recordingFinalizeJob.jobId, jobId))
      .returning();
    return updated[0] ?? null;
  });
};

// complete the job and move the publication pointer in one transaction.
// The pointer only moves forward — a stale revision can never replace a
// newer published one — and only while the caller still owns the lease.
// Pass publish=null for jobs with nothing to publish (empty capture).
export const completeRecordingFinalizeJob = async (
  jobId: string,
  ownerId: string,
  publish: { recordingId: string; revision: number } | null,
  database: DbOrTx = db
) => {
  return database.transaction(async (tx) => {
    const completed = await tx
      .update(recordingFinalizeJob)
      .set({ state: "completed", leaseOwnerId: null, leaseExpiresAt: null, lastError: null })
      .where(
        and(
          eq(recordingFinalizeJob.jobId, jobId),
          eq(recordingFinalizeJob.leaseOwnerId, ownerId),
          eq(recordingFinalizeJob.state, "running")
        )
      )
      .returning();
    if (!completed[0]) return { completed: false as const, published: false as const };
    if (!publish) return { completed: true as const, published: false as const };
    await tx
      .update(recordingUpload)
      .set({ publishedRevision: publish.revision })
      .where(
        and(
          eq(recordingUpload.recordingId, publish.recordingId),
          or(
            isNull(recordingUpload.publishedRevision),
            lt(recordingUpload.publishedRevision, publish.revision)
          )
        )
      );
    return { completed: true as const, published: true as const };
  });
};

// flip stale captures to interrupted; returns the rows so the worker can
// line up their first finalize job
export const markStaleRecordingsInterrupted = async (database: DbOrTx = db) => {
  const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_SECONDS * 1000);
  const flipped = await database
    .update(recordingUpload)
    .set({ captureState: "interrupted" })
    .where(
      and(
        eq(recordingUpload.captureState, "recording"),
        or(
          isNull(recordingUpload.lastHeartbeatAt),
          lt(recordingUpload.lastHeartbeatAt, staleBefore)
        )
      )
    )
    .returning();
  return flipped;
};
