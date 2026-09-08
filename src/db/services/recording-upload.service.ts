import { sql } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { AppError } from "../../lib/error";
import { recordingSegment, recordingUpload } from "../schema";
import {
  findRecordingSegment,
  findRecordingUploadById,
  insertRecordingSegment,
  insertRecordingUpload,
  lockRecordingSegment,
  lockRecordingUploadById,
  updateRecordingSegment,
} from "../repositories/recording-upload.repository";
import {
  findBackendIdentity,
  insertBackendIdentity,
  updateBackendIdentity,
} from "../repositories/backend-identity.repository";
import { insertRecordingFinalizeJob } from "../repositories/recording-finalize-job.repository";
import { insertRecordingDiscardAudit } from "../repositories/recording-discard-audit.repository";

// wire protocol version for the v2 recording surface
export const RECORDING_PROTOCOL_VERSION = 2;

export type AdmitRecordingUploadInput = {
  recordingId: string;
  backendInstanceId: string;
  admissionHash: string;
  kind: "master" | "clip";
  masterVideoId?: number | null;
  clipId?: number | null;
  objectPrefix: string;
};

export type AdmitRecordingUploadResult = {
  upload: typeof recordingUpload.$inferSelect;
  admitted: boolean;
};

// admit one recording UUID idempotently; same identity replays, changed identity conflicts
// flow: lock row > replay-or-409 > insert
export const admitRecordingUpload = async (
  input: AdmitRecordingUploadInput,
  database?: DbOrTx
): Promise<AdmitRecordingUploadResult> => {
  const run = async (tx: DbOrTx): Promise<AdmitRecordingUploadResult> => {
    // lock first — a lost-response retry must land on the same row
    const existing = await lockRecordingUploadById(input.recordingId, tx);
    if (existing) {
      const sameIdentity =
        existing.admissionHash === input.admissionHash &&
        existing.kind === input.kind &&
        existing.protocolVersion === RECORDING_PROTOCOL_VERSION;
      if (!sameIdentity) {
        throw new AppError(
          409,
          "identity_conflict",
          `Recording id already admitted with a different identity: ${input.recordingId}`
        );
      }
      return { upload: existing, admitted: false };
    }
    const created = await insertRecordingUpload(
      {
        recordingId: input.recordingId,
        protocolVersion: RECORDING_PROTOCOL_VERSION,
        backendInstanceId: input.backendInstanceId,
        admissionHash: input.admissionHash,
        kind: input.kind,
        masterVideoId: input.masterVideoId ?? null,
        clipId: input.clipId ?? null,
        objectPrefix: input.objectPrefix,
        captureState: "recording",
      },
      tx
    );
    return { upload: created!, admitted: true };
  };
  return database ? run(database) : db.transaction(run);
};

export type ReserveRecordingSegmentInput = {
  recordingId: string;
  segmentIndex: number;
  checksum: string;
  sizeBytes: number;
  objectKey: string;
};

export type ReserveRecordingSegmentResult = {
  outcome: "reserved" | "stored";
  segment: typeof recordingSegment.$inferSelect;
};

// reserve one segment before its PUT; stored receipts replay, changed content conflicts
// flow: lock upload > read segment > replay-or-409-or-insert
export const reserveRecordingSegment = async (
  input: ReserveRecordingSegmentInput,
  database?: DbOrTx
): Promise<ReserveRecordingSegmentResult> => {
  const run = async (tx: DbOrTx): Promise<ReserveRecordingSegmentResult> => {
    const upload = await lockRecordingUploadById(input.recordingId, tx);
    if (!upload) {
      throw new AppError(404, "not_found", `Recording not found: ${input.recordingId}`);
    }
    const existing = await findRecordingSegment(
      input.recordingId,
      input.segmentIndex,
      tx
    );
    if (existing) {
      const sameContent =
        existing.expectedChecksum === input.checksum &&
        existing.expectedSizeBytes === input.sizeBytes;
      if (!sameContent) {
        throw new AppError(
          409,
          "segment_conflict",
          `Segment ${input.segmentIndex} of recording ${input.recordingId} exists with different content`
        );
      }
      // same identity replays either receipt state — no new row
      return {
        outcome: existing.receiptState === "stored" ? "stored" : "reserved",
        segment: existing,
      };
    }
    const created = await insertRecordingSegment(
      {
        recordingId: input.recordingId,
        segmentIndex: input.segmentIndex,
        expectedChecksum: input.checksum,
        expectedSizeBytes: input.sizeBytes,
        objectKey: input.objectKey,
        receiptState: "reserved",
      },
      tx
    );
    return { outcome: "reserved", segment: created! };
  };
  return database ? run(database) : db.transaction(run);
};

export type CommitRecordingSegmentResult = {
  segment: typeof recordingSegment.$inferSelect;
  revisionBumped: boolean;
};

// commit a stored receipt; replays stay stored, revision moves only on the first commit
// flow: lock segment > replay-or-store > bump revision
export const commitRecordingSegmentReceipt = async (
  recordingId: string,
  segmentIndex: number,
  database?: DbOrTx
): Promise<CommitRecordingSegmentResult> => {
  const run = async (tx: DbOrTx): Promise<CommitRecordingSegmentResult> => {
    const segment = await lockRecordingSegment(recordingId, segmentIndex, tx);
    if (!segment) {
      throw new AppError(
        404,
        "not_found",
        `Segment ${segmentIndex} of recording ${recordingId} has no reservation`
      );
    }
    if (segment.receiptState === "stored") {
      return { segment, revisionBumped: false };
    }
    const stored = await updateRecordingSegment(
      recordingId,
      segmentIndex,
      { receiptState: "stored", storedAt: new Date() },
      tx
    );
    // revision counts new stored receipts — reconciliation must not inflate it
    await tx
      .update(recordingUpload)
      .set({ segmentRevision: sql`${recordingUpload.segmentRevision} + 1` })
      .where(sql`${recordingUpload.recordingId} = ${recordingId}`);
    return { segment: stored!, revisionBumped: true };
  };
  return database ? run(database) : db.transaction(run);
};

// authoritative primary-database lookup for recovery — row or null
export const lookupRecordingUpload = (recordingId: string, database: DbOrTx = db) =>
  findRecordingUploadById(recordingId, database);

// ensure the singleton identity row exists; returns the stable deployment identity
// flow: read > insert-or-ignore > re-read on race
export const bootstrapBackendIdentity = async (database?: DbOrTx) => {
  const run = async (tx: DbOrTx) => {
    const existing = await findBackendIdentity(tx);
    if (existing) return existing;
    const created = await insertBackendIdentity({ singletonId: 1 }, tx);
    if (created) return created;
    // parallel boot lost the insert race — the winner's row is committed already
    const raced = await findBackendIdentity(tx);
    if (!raced) {
      throw new AppError(500, "identity_bootstrap_failed", "Backend identity bootstrap failed");
    }
    return raced;
  };
  return database ? run(database) : db.transaction(run);
};

// flip the recovery-authority flag on the bootstrapped singleton
export const setRecoveryAuthority = async (enabled: boolean, database?: DbOrTx) => {
  const run = async (tx: DbOrTx) => {
    const updated = await updateBackendIdentity({ recoveryAuthorityEnabled: enabled }, tx);
    if (!updated) {
      throw new AppError(404, "not_found", "Backend identity is not bootstrapped");
    }
    return updated;
  };
  return database ? run(database) : db.transaction(run);
};

// enqueue finalization for one recording revision; repeats collapse into one row
export const enqueueRecordingFinalizeJob = async (
  recordingId: string,
  targetRevision: number,
  database: DbOrTx = db
) => insertRecordingFinalizeJob({ recordingId, targetRevision }, database);

export type RecordRecordingDiscardInput = {
  requestId: string;
  recordingId: string;
  backendInstanceId: string;
  reason: string;
};

// commit the discard audit row before any discard directive returns
export const recordRecordingDiscard = async (
  input: RecordRecordingDiscardInput,
  database: DbOrTx = db
) => insertRecordingDiscardAudit(input, database);
