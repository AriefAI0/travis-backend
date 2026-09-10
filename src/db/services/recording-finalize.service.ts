import { and, asc, eq, gt, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { masterVideo, recordingFinalizeJob, recordingUpload, videoClip } from "../schema";

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

// claim one job while serializing all work for one recording.
export const claimNextRecordingFinalizeJob = async (ownerId: string, database: DbOrTx = db) => {
  return database.transaction(async (tx) => {
    const skipped: string[] = [];
    // flow: lock job > lock upload > check lease
    for (;;) {
    const now = new Date();
    const due = await tx
      .select()
      .from(recordingFinalizeJob)
      .where(
        and(
        skipped.length ? notInArray(recordingFinalizeJob.recordingId, skipped) : undefined,
        or(
          and(
            inArray(recordingFinalizeJob.state, ["pending", "failed"]),
            lte(recordingFinalizeJob.nextAttemptAt, now)
          ),
          and(
            eq(recordingFinalizeJob.state, "running"),
            lt(recordingFinalizeJob.leaseExpiresAt, now)
          )
        ))
      )
      .orderBy(asc(recordingFinalizeJob.nextAttemptAt), asc(recordingFinalizeJob.jobId))
      .limit(1)
      .for("update", { skipLocked: true });

      const job = due[0];
      if (!job) return null;
      skipped.push(job.recordingId);
      const upload = await tx
        .select({ recordingId: recordingUpload.recordingId })
        .from(recordingUpload)
        .where(eq(recordingUpload.recordingId, job.recordingId))
        .for("update", { skipLocked: true })
        .limit(1);
      if (!upload[0]) continue;

      const running = await tx
        .select({ jobId: recordingFinalizeJob.jobId })
        .from(recordingFinalizeJob)
        .where(
          and(
            eq(recordingFinalizeJob.recordingId, job.recordingId),
            eq(recordingFinalizeJob.state, "running"),
            gt(recordingFinalizeJob.leaseExpiresAt, new Date()),
            sql`${recordingFinalizeJob.jobId} <> ${job.jobId}`
          )
        )
        .limit(1);
      if (running[0]) continue;

      const claimed = await tx
        .update(recordingFinalizeJob)
        .set({
          state: "running",
          leaseOwnerId: ownerId,
          leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_SECONDS * 1000),
        })
        .where(eq(recordingFinalizeJob.jobId, job.jobId))
        .returning();
      if (claimed[0]) return claimed[0];
    }
    return null;
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

// facts the finalize worker measured for the revision it built; stamped onto
// the domain row in the same transaction as the pointer so domain readers
// (lists, reports, playback gate) never see finalized without a published
// revision behind it
export type RecordingPublishStamp = {
  durationMs: number | null;
  fileSizeBytes: number | null;
};

// complete the job and move the publication pointer in one transaction.
// The pointer only moves forward — a stale revision can never replace a
// newer published one — and only while the caller still owns the lease.
// Pass publish=null for jobs with nothing to publish (empty capture).
// The domain stamp rides the same forward-only condition as the pointer.
export const completeRecordingFinalizeJob = async (
  jobId: string,
  ownerId: string,
  publish: { recordingId: string; revision: number } | null,
  database: DbOrTx = db,
  stamp?: RecordingPublishStamp
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
    const moved = await tx
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
      )
      .returning({ recordingId: recordingUpload.recordingId });
    if (!moved[0]) return { completed: true as const, published: false as const };
    if (stamp) {
      await stampDomainRowForPublish(publish.recordingId, stamp, tx);
    }
    return { completed: true as const, published: true as const };
  });
};

// v2 publication makes the domain row visible: master/clip flips to finalized
// with the measured duration and size; a clip's end offset is its start plus
// the recovered duration (spec 12). Legacy stems stay untouched — v2 rows
// have no stem, and legacy minters gate on it, so legacy URLs never lie.
const stampDomainRowForPublish = async (
  recordingId: string,
  stamp: RecordingPublishStamp,
  tx: DbOrTx
) => {
  const upload = await tx
    .select({ kind: recordingUpload.kind, masterVideoId: recordingUpload.masterVideoId, clipId: recordingUpload.clipId })
    .from(recordingUpload)
    .where(eq(recordingUpload.recordingId, recordingId))
    .limit(1);
  const row = upload[0];
  if (!row) return;
  if (row.kind === "master" && row.masterVideoId !== null) {
    await tx
      .update(masterVideo)
      .set({
        recordingStatus: "finalized",
        durationMs: stamp.durationMs,
        fileSize: stamp.fileSizeBytes,
        lastUpdatedAt: new Date(),
      })
      .where(eq(masterVideo.masterVideoId, row.masterVideoId));
  } else if (row.kind === "clip" && row.clipId !== null) {
    const clip = await tx
      .select({ startOffsetMs: videoClip.startOffsetMs })
      .from(videoClip)
      .where(eq(videoClip.clipId, row.clipId))
      .limit(1);
    const startOffsetMs = clip[0]?.startOffsetMs ?? 0;
    const durationMs = stamp.durationMs ?? 0;
    await tx
      .update(videoClip)
      .set({
        recordingStatus: "finalized",
        endOffsetMs: startOffsetMs + durationMs,
        fileSize: stamp.fileSizeBytes,
        lastUpdatedAt: new Date(),
      })
      .where(eq(videoClip.clipId, row.clipId));
  }
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
