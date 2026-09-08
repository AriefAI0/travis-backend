import { createHash } from "node:crypto";
import type { Client } from "minio";

import { db, type DbOrTx } from "../client";
import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { v2SegmentLeaf } from "../../lib/minio_storage/paths";
import { createMasterVideoRecord } from "../repositories/master-video.repository";
import { createVideoClipRecord } from "../repositories/video-clip.repository";
import {
  findRecordingSegment,
  listRecordingSegments,
  updateRecordingUploadById,
} from "../repositories/recording-upload.repository";
import { findResultById } from "../repositories/result.repository";
import { findSessionById } from "../repositories/session.repository";
import {
  admitRecordingUpload,
  commitRecordingSegmentReceipt,
  lookupRecordingUpload,
  reserveRecordingSegment,
} from "./recording-upload.service";
import { scheduleRecordingFinalize } from "./recording-finalize.service";
import type { recordingSegment, recordingUpload } from "../schema";

// spec-locked: upload tickets expire after five minutes
export const SEGMENT_TICKET_TTL_SECONDS = 300;

export type AdmitRecordingBody = {
  recordingId: string;
  kind: "master" | "clip";
  sessionId?: number;
  startEpoch?: number;
  resultId?: number;
  masterVideoId?: number;
  startOffsetMs?: number;
};

export type RecordingDomainIdentity = {
  kind: "master" | "clip";
  masterVideoId?: number;
  clipId?: number;
  sessionId?: number;
  projectId?: number;
  resultId?: number;
};

export type SegmentReceipt = {
  index: number;
  checksum: string;
  sizeBytes: number;
  storedAt: Date | null;
};

const toReceipt = (segment: typeof recordingSegment.$inferSelect): SegmentReceipt => ({
  index: segment.segmentIndex,
  checksum: segment.expectedChecksum,
  sizeBytes: segment.expectedSizeBytes,
  storedAt: segment.storedAt,
});

// canonical JSON text of the admission body — same body = same hash
export function admissionBodyHash(body: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => [k, canonical(v)])
      );
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex");
}

// read back the domain identity attached to an upload row
const loadDomain = async (
  upload: typeof recordingUpload.$inferSelect,
  database: DbOrTx
): Promise<RecordingDomainIdentity> => {
  if (upload.kind === "master") {
    const master = upload.masterVideoId
      ? await database.query.masterVideo.findFirst({
          where: (t, { eq }) => eq(t.masterVideoId, upload.masterVideoId!),
        })
      : null;
    const session = master ? await findSessionById(master.sessionId, database) : null;
    return {
      kind: "master",
      masterVideoId: upload.masterVideoId ?? undefined,
      sessionId: master?.sessionId,
      projectId: session?.projectId,
    };
  }
  const clip = upload.clipId
    ? await database.query.videoClip.findFirst({
        where: (t, { eq }) => eq(t.clipId, upload.clipId!),
      })
    : null;
  const result = clip ? await findResultById(clip.resultId, database) : null;
  return {
    kind: "clip",
    clipId: upload.clipId ?? undefined,
    resultId: clip?.resultId,
    masterVideoId: clip?.masterVideoId,
    sessionId: result?.sessionId,
    projectId: result?.projectId,
  };
};

export type AdmitRecordingResult = {
  recordingId: string;
  admitted: boolean;
  captureState: typeof recordingUpload.$inferSelect.captureState;
  objectPrefix: string;
  domain: RecordingDomainIdentity;
};

// admit one recording: domain row + upload row commit together, replays reuse rows
// flow: lookup > replay-or-create-domain > admit upload (one tx)
// note: two CONCURRENT admissions of one UUID can leak an orphan domain row
// (check-then-insert race); the single-writer app never does this.
export const admitRecording = async (
  body: AdmitRecordingBody,
  backendInstanceId: string,
  database?: DbOrTx
): Promise<AdmitRecordingResult> => {
  const run = async (tx: DbOrTx): Promise<AdmitRecordingResult> => {
    const admissionHash = admissionBodyHash(body);
    const existing = await lookupRecordingUpload(body.recordingId, tx);
    if (existing) {
      const sameIdentity =
        existing.admissionHash === admissionHash && existing.kind === body.kind;
      if (!sameIdentity) {
        throw new AppError(
          409,
          "identity_conflict",
          `Recording id already admitted with a different identity: ${body.recordingId}`
        );
      }
      return {
        recordingId: body.recordingId,
        admitted: false,
        captureState: existing.captureState,
        objectPrefix: existing.objectPrefix,
        domain: await loadDomain(existing, tx),
      };
    }
    let domain: RecordingDomainIdentity;
    if (body.kind === "master") {
      if (body.sessionId === undefined || body.startEpoch === undefined) {
        throw new AppError(
          400,
          "validation_error",
          "master admission requires sessionId and startEpoch"
        );
      }
      const created = (await createMasterVideoRecord(
        {
          sessionId: body.sessionId,
          startEpoch: body.startEpoch,
          recordingStatus: "recording",
        },
        tx
      ))!;
      const session = await findSessionById(created.sessionId, tx);
      domain = {
        kind: "master",
        masterVideoId: created.masterVideoId,
        sessionId: created.sessionId,
        projectId: session?.projectId,
      };
    } else {
      if (
        body.resultId === undefined ||
        body.masterVideoId === undefined ||
        body.startOffsetMs === undefined
      ) {
        throw new AppError(
          400,
          "validation_error",
          "clip admission requires resultId, masterVideoId and startOffsetMs"
        );
      }
      const created = (await createVideoClipRecord(
        {
          resultId: body.resultId,
          masterVideoId: body.masterVideoId,
          startOffsetMs: body.startOffsetMs,
          recordingStatus: "recording",
        },
        tx
      ))!;
      const result = await findResultById(created.resultId, tx);
      domain = {
        kind: "clip",
        clipId: created.clipId,
        resultId: created.resultId,
        masterVideoId: created.masterVideoId,
        sessionId: result?.sessionId,
        projectId: result?.projectId,
      };
    }
    const { upload } = await admitRecordingUpload(
      {
        recordingId: body.recordingId,
        backendInstanceId,
        admissionHash,
        kind: body.kind,
        masterVideoId: domain.masterVideoId ?? null,
        clipId: domain.clipId ?? null,
        objectPrefix: `recordings/${body.recordingId}/segments`,
      },
      tx
    );
    return {
      recordingId: body.recordingId,
      admitted: true,
      captureState: upload.captureState,
      objectPrefix: upload.objectPrefix,
      domain,
    };
  };
  return database ? run(database) : db.transaction(run);
};

export type SegmentTicketOutcome =
  | {
      action: "upload";
      url: string;
      objectKey: string;
      headers: Record<string, string>;
      expiresInSeconds: number;
    }
  | { action: "stored"; receipt: SegmentReceipt };

// checksum hex -> base64 form the x-amz-checksum-sha256 header wants
const checksumHeader = (hex: string) => Buffer.from(hex, "hex").toString("base64");

// reserve the segment, then hand back a presigned PUT bound to the checksum;
// stored receipts short-circuit. MinIO enforces the header at PUT time
// (verified against the deployment), so matching bytes land or nothing does.
// flow: reserve > stored-receipt-or-presign
export const issueSegmentTicket = async (
  recordingId: string,
  segmentIndex: number,
  checksumHex: string,
  sizeBytes: number,
  storage: Client,
  database?: DbOrTx
): Promise<SegmentTicketOutcome> => {
  const leaf = v2SegmentLeaf(recordingId, segmentIndex);
  const reservation = await reserveRecordingSegment(
    {
      recordingId,
      segmentIndex,
      checksum: checksumHex,
      sizeBytes,
      objectKey: leaf.key,
    },
    database
  );
  if (reservation.outcome === "stored") {
    return { action: "stored", receipt: toReceipt(reservation.segment) };
  }
  const url = await storage.presignedUrl("PUT", leaf.bucket, leaf.key, SEGMENT_TICKET_TTL_SECONDS);
  return {
    action: "upload",
    url,
    objectKey: leaf.key,
    headers: { "x-amz-checksum-sha256": checksumHeader(checksumHex) },
    expiresInSeconds: SEGMENT_TICKET_TTL_SECONDS,
  };
};

// verify stored object bytes against the reservation, then commit the receipt
// flow: read segment > stat object > hash object > commit-or-conflict
// the hash step is the authoritative content gate — a matching size from a
// bypassing PUT (no checksum header) must never be acknowledged (spec 14).
export const completeSegment = async (
  recordingId: string,
  segmentIndex: number,
  storage: Client,
  database?: DbOrTx
) => {
  const segment = await findRecordingSegment(recordingId, segmentIndex, database ?? db);
  if (!segment) {
    throw new AppError(
      404,
      "not_found",
      `Segment ${segmentIndex} of recording ${recordingId} has no reservation`
    );
  }
  let stat: Awaited<ReturnType<Client["statObject"]>>;
  try {
    stat = await storage.statObject(env.BUCKET_RAW, segment.objectKey);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // statObject uses HEAD — missing keys surface as "NotFound", not NoSuchKey
    if (code === "NoSuchKey" || code === "NotFound") {
      throw new AppError(
        409,
        "segment_not_stored",
        `Object for segment ${segmentIndex} of recording ${recordingId} is absent; request another ticket`
      );
    }
    throw new AppError(
      503,
      "storage_unavailable",
      `Object check failed for segment ${segmentIndex} of recording ${recordingId}`
    );
  }
  if (stat.size !== segment.expectedSizeBytes) {
    throw new AppError(
      409,
      "segment_conflict",
      `Object for segment ${segmentIndex} of recording ${recordingId} has size ${stat.size}, expected ${segment.expectedSizeBytes}`
    );
  }
  const stream = await storage.getObject(env.BUCKET_RAW, segment.objectKey);
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  const actualHex = hash.digest("hex");
  if (actualHex !== segment.expectedChecksum) {
    throw new AppError(
      409,
      "segment_conflict",
      `Object for segment ${segmentIndex} of recording ${recordingId} does not match the reserved checksum`
    );
  }
  const { segment: stored, revisionBumped } = await commitRecordingSegmentReceipt(
    recordingId,
    segmentIndex,
    database
  );
  // inactive captures line up their next finalize job on every new receipt
  const state = await lookupRecordingUpload(recordingId, database ?? db);
  if (state && state.captureState !== "recording") {
    await scheduleRecordingFinalize(recordingId, state.segmentRevision, undefined, database ?? db);
  }
  return { action: "stored" as const, receipt: toReceipt(stored), revisionBumped };
};

export type ReconcileDescriptor = {
  index: number;
  checksum: string;
  sizeBytes: number;
};

export type ReconcileSegmentAction = {
  index: number;
  action: "stored" | "upload" | "conflict";
};

// classify one batch of local segment descriptors against the receipt ledger
// flow: load recording > identity check > classify descriptors
export const reconcileRecording = async (
  recordingId: string,
  callerBackendInstanceId: string,
  descriptors: ReconcileDescriptor[],
  database?: DbOrTx
) => {
  const upload = await lookupRecordingUpload(recordingId, database ?? db);
  if (!upload) {
    throw new AppError(404, "not_found", `Recording not found: ${recordingId}`);
  }
  if (upload.backendInstanceId !== callerBackendInstanceId) {
    throw new AppError(
      409,
      "identity_conflict",
      `Recording ${recordingId} belongs to another backend instance`
    );
  }
  const segments = await listRecordingSegments(recordingId, database ?? db);
  const byIndex = new Map(segments.map((s) => [s.segmentIndex, s]));
  const segmentActions: ReconcileSegmentAction[] = descriptors.map((d) => {
    const row = byIndex.get(d.index);
    if (!row) return { index: d.index, action: "upload" };
    const sameContent =
      row.expectedChecksum === d.checksum && row.expectedSizeBytes === d.sizeBytes;
    if (!sameContent) return { index: d.index, action: "conflict" };
    return {
      index: d.index,
      action: row.receiptState === "stored" ? "stored" : "upload",
    };
  });
  return {
    recording: "resume" as const,
    captureState: upload.captureState,
    segmentRevision: upload.segmentRevision,
    publishedRevision: upload.publishedRevision,
    segments: segmentActions,
  };
};

// record capture liveness and report storage readiness for the stop latch
// flow: load recording > touch heartbeat > probe minio (postgres proved by this query)
export const heartbeatRecording = async (
  recordingId: string,
  storage: Client,
  database?: DbOrTx
) => {
  const upload = await lookupRecordingUpload(recordingId, database ?? db);
  if (!upload) {
    throw new AppError(404, "not_found", `Recording not found: ${recordingId}`);
  }
  await updateRecordingUploadById(recordingId, { lastHeartbeatAt: new Date() }, database ?? db);
  let minioReady = false;
  try {
    minioReady = await storage.bucketExists(env.BUCKET_RAW);
  } catch {
    minioReady = false;
  }
  return {
    captureState: upload.captureState,
    readiness: { postgres: true, minio: minioReady },
  };
};

// idempotently end capture with the declared final segment index
export const stopRecording = async (
  recordingId: string,
  finalSegmentIndex: number,
  database?: DbOrTx
) => {
  const upload = await lookupRecordingUpload(recordingId, database ?? db);
  if (!upload) {
    throw new AppError(404, "not_found", `Recording not found: ${recordingId}`);
  }
  if (upload.captureState === "interrupted") {
    throw new AppError(
      409,
      "wrong_state",
      `Recording ${recordingId} is interrupted; use recovery-complete`
    );
  }
  if (upload.captureState === "stopped") {
    return { captureState: upload.captureState, finalSegmentIndex: upload.finalSegmentIndex };
  }
  const updated = await updateRecordingUploadById(
    recordingId,
    { captureState: "stopped", finalSegmentIndex },
    database ?? db
  );
  // a declared range schedules finalization immediately
  await scheduleRecordingFinalize(recordingId, upload.segmentRevision, undefined, database ?? db);
  return { captureState: updated!.captureState, finalSegmentIndex: updated!.finalSegmentIndex };
};

// end a late recovery batch; the declared final index only moves forward
export const recoveryCompleteRecording = async (
  recordingId: string,
  finalSegmentIndex: number,
  database?: DbOrTx
) => {
  const upload = await lookupRecordingUpload(recordingId, database ?? db);
  if (!upload) {
    throw new AppError(404, "not_found", `Recording not found: ${recordingId}`);
  }
  if (upload.captureState === "recording") {
    throw new AppError(
      409,
      "wrong_state",
      `Recording ${recordingId} is still recording; call stop first`
    );
  }
  const merged = Math.max(upload.finalSegmentIndex ?? -1, finalSegmentIndex);
  const updated = await updateRecordingUploadById(
    recordingId,
    { finalSegmentIndex: merged },
    database ?? db
  );
  // recovery-complete runs immediately, bypassing the five-second debounce
  await scheduleRecordingFinalize(recordingId, upload.segmentRevision, new Date(), database ?? db);
  return { captureState: updated!.captureState, finalSegmentIndex: updated!.finalSegmentIndex };
};

// lifecycle read: contiguous stored prefix, gaps, and playback revision
// flow: load recording > load segments > compute ranges
export const getRecordingStatus = async (recordingId: string, database?: DbOrTx) => {
  const upload = await lookupRecordingUpload(recordingId, database ?? db);
  if (!upload) {
    throw new AppError(404, "not_found", `Recording not found: ${recordingId}`);
  }
  const segments = await listRecordingSegments(recordingId, database ?? db);
  const storedIndexes = new Set(
    segments.filter((s) => s.receiptState === "stored").map((s) => s.segmentIndex)
  );
  const highestStored = storedIndexes.size ? Math.max(...storedIndexes) : -1;
  let contiguousThrough = -1;
  while (storedIndexes.has(contiguousThrough + 1)) contiguousThrough += 1;
  const missingRanges: Array<[number, number]> = [];
  let cursor = 0;
  while (cursor <= highestStored) {
    if (!storedIndexes.has(cursor)) {
      const start = cursor;
      while (cursor <= highestStored && !storedIndexes.has(cursor)) cursor += 1;
      missingRanges.push([start, cursor - 1]);
    }
    cursor += 1;
  }
  return {
    captureState: upload.captureState,
    finalSegmentIndex: upload.finalSegmentIndex,
    segmentRevision: upload.segmentRevision,
    publishedRevision: upload.publishedRevision,
    contiguousStoredThrough: contiguousThrough,
    missingRanges,
    storedCount: storedIndexes.size,
  };
};
