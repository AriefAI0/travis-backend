// Direct ingest: backend-owned identity for one capture attempt.
// flow: validate > create-or-reuse domain row > insert ingest > hand back one ticket

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { db, type DbOrTx } from "../../db/client";
import { AppError, notFound } from "../../lib/error";
import { minio } from "../../lib/minio_storage/clients";
import {
  buildClipKeyPrefix,
  buildMasterKeyPrefix,
  mediaDatePath,
  segmentLeafV2,
} from "../../lib/minio_storage/paths";
import { masterVideo, recordingIngest, recordingIngestSegment, videoClip } from "../../db/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  createMasterVideoRecord,
  findMasterVideoById,
} from "../../db/repositories/master-video.repository";
import { findProjectById } from "../../db/repositories/project.repository";
import { findSessionById } from "../../db/repositories/session.repository";
import {
  createVideoClipRecord,
  findVideoClipById,
  listVideoClipRecordsByResultId,
} from "../../db/repositories/video-clip.repository";
import { findResultById } from "../../db/repositories/result.repository";
import { resolveTargetLabel } from "../../db/services/task-structure.service";
import { createSession } from "../../db/services/session.service";
import { enqueueClipStill, enqueueThumbnails } from "./jobs/thumbnails";

// native splitmuxsink target the client aims for; measured durations arrive per segment
export const SEGMENT_TARGET_MS = 2000;

export type AdmitMasterInput = {
  kind: "master";
  projectId: number;
  startEpoch: number;
};

export type AdmitClipInput = {
  kind: "clip";
  resultId: number;
  masterVideoId: number;
  startOffsetMs: number;
};

export type AdmitIngestInput = AdmitMasterInput | AdmitClipInput;

// domain rows the ingest feeds; no client id appears in any of them
export type MasterIngestDomain = {
  kind: "master";
  masterVideoId: number;
  sessionId: number;
  projectId: number;
};

export type ClipIngestDomain = {
  kind: "clip";
  clipId: number;
  resultId: number;
  masterVideoId: number;
  sessionId: number;
  projectId: number;
};

export type IngestDomain = MasterIngestDomain | ClipIngestDomain;

export type IngestAdmission = {
  ingestId: number;
  // returned once, never stored and never logged
  ticket: string;
  domain: IngestDomain;
  segmentTargetMs: number;
};

// 32 random bytes, base64url: opaque and URL-safe, no structure to read
const mintTicket = () => randomBytes(32).toString("base64url");

// only the digest reaches PostgreSQL
export function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

// constant-time check of a presented ticket against a stored digest
export function ticketMatches(ticket: string, storedHash: string): boolean {
  const presented = Buffer.from(hashTicket(ticket), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

// flow: project > session row > master row > ingest row. The session is minted per master.
const admitMaster = async (
  input: AdmitMasterInput,
  tx: DbOrTx,
): Promise<IngestAdmission> => {
  const startedAt = new Date(input.startEpoch * 1000);
  if (!Number.isFinite(startedAt.getTime())) {
    throw new AppError(400, "validation_error", "startEpoch: expected epoch seconds");
  }

  // the title is part of the frozen prefix, so the project loads first
  const project = await findProjectById(input.projectId, tx);
  if (!project) throw notFound("Project");

  const session = (await createSession({ projectId: input.projectId }, tx))!;
  const master = (await createMasterVideoRecord(
    { sessionId: session.sessionId, startEpoch: input.startEpoch },
    tx,
  ))!;

  // frozen here: the display numbers exist only once the rows returned
  const keyPrefix = buildMasterKeyPrefix({
    projectNumber: project.displayNumber,
    projectTitle: project.title,
    displayNumber: session.displayNumber ?? session.sessionId,
    startEpoch: input.startEpoch,
  });

  return {
    ...(await insertIngest(
      {
        kind: "master",
        masterVideoId: master.masterVideoId,
        keyDate: mediaDatePath(startedAt),
        keyPrefix,
      },
      tx,
    )),
    domain: {
      kind: "master",
      masterVideoId: master.masterVideoId,
      sessionId: master.sessionId,
      projectId: session.projectId,
    },
  };
};

// flow: result + master checks > clip row (one per result) > open-ingest check > ingest row
const admitClip = async (input: AdmitClipInput, tx: DbOrTx): Promise<IngestAdmission> => {
  const result = await findResultById(input.resultId, tx);
  if (!result) throw notFound("Result");

  const master = await findMasterVideoById(input.masterVideoId, tx);
  if (!master) throw notFound("Master video");

  // the clip folder carries the item label and the inspection type
  const session = await findSessionById(master.sessionId, tx);
  if (!session) throw notFound("Session");
  const project = await findProjectById(session.projectId, tx);
  if (!project) throw notFound("Project");
  // the v2 target label names the clip folder
  const targetLabel = await resolveTargetLabel(result, tx);

  // uq_video_clip_result_id: one clip per result, so a re-record reuses the row
  const [existing] = await listVideoClipRecordsByResultId(input.resultId, tx);
  const clip =
    existing ??
    (await createVideoClipRecord(
      {
        resultId: input.resultId,
        masterVideoId: input.masterVideoId,
        startOffsetMs: input.startOffsetMs,
      },
      tx,
    ))!;

  const open = await findOpenIngestByClip(clip.clipId, tx);
  if (open) {
    throw new AppError(409, "recording_in_progress", "Clip already has an open ingest");
  }

  // frozen here, from the master's start: never the clip's own wall clock
  const keyPrefix = buildClipKeyPrefix({
    projectNumber: project.displayNumber,
    projectTitle: project.title,
    displayNumber: session.displayNumber ?? session.sessionId,
    startEpoch: master.startEpoch,
    resultNumber: result.displayNumber,
    itemLabel: targetLabel,
    inspectionType: result.inspectionTypeCode,
  });

  return {
    ...(await insertIngest(
      {
        kind: "clip",
        clipId: clip.clipId,
        // clip keys reuse the master date, never the clip's own wall clock
        keyDate: mediaDatePath(new Date(master.startEpoch * 1000)),
        keyPrefix,
      },
      tx,
    )),
    domain: {
      kind: "clip",
      clipId: clip.clipId,
      resultId: clip.resultId,
      masterVideoId: clip.masterVideoId,
      sessionId: result.sessionId,
      projectId: result.projectId,
    },
  };
};

// the ingest row is the whole ledger header; the raw ticket stops at the caller
const insertIngest = async (
  target:
    | { kind: "master"; masterVideoId: number; keyDate: string; keyPrefix: string }
    | { kind: "clip"; clipId: number; keyDate: string; keyPrefix: string },
  tx: DbOrTx,
): Promise<{ ingestId: number; ticket: string; segmentTargetMs: number }> => {
  const ticket = mintTicket();
  const [row] = await tx
    .insert(recordingIngest)
    .values({
      kind: target.kind,
      masterVideoId: target.kind === "master" ? target.masterVideoId : null,
      clipId: target.kind === "clip" ? target.clipId : null,
      ticketHash: hashTicket(ticket),
      keyDate: target.keyDate,
      keyPrefix: target.keyPrefix,
    })
    .returning({ ingestId: recordingIngest.ingestId });

  return { ingestId: row!.ingestId, ticket, segmentTargetMs: SEGMENT_TARGET_MS };
};

// rebuild the domain identity of one ingest row from its live parents
const loadDomain = async (
  ingest: typeof recordingIngest.$inferSelect,
  database: DbOrTx,
): Promise<IngestDomain> => {
  if (ingest.kind === "master") {
    const master = await findMasterVideoById(ingest.masterVideoId!, database);
    if (!master) throw notFound("Master video");
    const session = await findSessionById(master.sessionId, database);
    if (!session) throw notFound("Session");
    return {
      kind: "master",
      masterVideoId: master.masterVideoId,
      sessionId: master.sessionId,
      projectId: session.projectId,
    };
  }

  const clip = await findVideoClipById(ingest.clipId!, database);
  if (!clip) throw notFound("Video clip");
  const result = await findResultById(clip.resultId, database);
  if (!result) throw notFound("Result");
  return {
    kind: "clip",
    clipId: clip.clipId,
    resultId: clip.resultId,
    masterVideoId: clip.masterVideoId,
    sessionId: result.sessionId,
    projectId: result.projectId,
  };
};

// the partial unique index is the race guard; this read gives the clear 409 first
export const findOpenIngestByClip = async (clipId: number, database: DbOrTx = db) =>
  (await database.query.recordingIngest.findFirst({
    where: and(
      eq(recordingIngest.clipId, clipId),
      isNull(recordingIngest.closedAt),
      eq(recordingIngest.kind, "clip"),
    ),
  })) ?? null;

// single attempt by contract: a lost response leaves one empty row for the sweep
export const admitIngest = async (
  input: AdmitIngestInput,
  database?: DbOrTx,
): Promise<IngestAdmission> => {
  const run = (tx: DbOrTx) =>
    input.kind === "master" ? admitMaster(input, tx) : admitClip(input, tx);
  return database ? run(database) : db.transaction(run);
};

/* =========================================================
   CLOSE
   One idle rule bounds crash recovery: 15 s without a
   committed segment. Close and segment commit share the row
   lock, so the frozen range is never torn.
========================================================= */

export const INGEST_IDLE_CLOSE_MS = 15_000;

export type IngestCloseResult = {
  ingestId: number;
  // contiguous prefix frozen at close; -1 for an ingest with no segments
  finalSequence: number;
  durationMs: number;
  closedAt: Date;
  replayed: boolean;
};

// the ingest is idle when its last activity sits at or before the cutoff
export const ingestIdleSince = (ingest: typeof recordingIngest.$inferSelect): Date =>
  ingest.lastSegmentAt ?? ingest.openedAt;

// stamp the domain row with the facts the recording ended with
const stampDomainClose = async (
  ingest: typeof recordingIngest.$inferSelect,
  summary: { contiguousSequence: number; durationMs: number },
  tx: DbOrTx,
) => {
  const now = new Date();
  if (ingest.kind === "master") {
    const master = await findMasterVideoById(ingest.masterVideoId!, tx);
    if (!master) return;
    await tx
      .update(masterVideo)
      .set({
        durationMs: summary.durationMs,
        // epoch seconds: the sub-second tail would lie about the media
        endEpoch: master.startEpoch + Math.floor(summary.durationMs / 1000),
        lastUpdatedAt: now,
      })
      .where(eq(masterVideo.masterVideoId, master.masterVideoId));
    return;
  }

  const clip = await findVideoClipById(ingest.clipId!, tx);
  if (!clip) return;
  await tx
    .update(videoClip)
    .set({ endOffsetMs: clip.startOffsetMs + summary.durationMs, lastUpdatedAt: now })
    .where(eq(videoClip.clipId, clip.clipId));
};

// shared close path: explicit close and the sweep differ only in their guard.
// The thumbnail target rides the return so the caller can queue it after the
// transaction commits: a job must never read an uncommitted close.
const runClose = async (
  ingestId: number,
  guard: { ticket?: string; idleCutoff?: Date },
  tx: DbOrTx,
): Promise<{ result: IngestCloseResult; thumbnailMasterVideoId: number | null } | null> => {
  const ingest = await lockIngest(ingestId, tx);
  if (!ingest) throw notFound("Ingest");
  if (guard.ticket !== undefined && !ticketMatches(guard.ticket, ingest.ticketHash)) {
    throw new AppError(401, "unauthorized", "Authorization: ticket does not match this ingest");
  }

  // an equivalent close replays the frozen result instead of re-stamping it
  if (ingest.closedAt !== null) {
    return {
      result: {
        ingestId,
        finalSequence: ingest.finalSequence ?? -1,
        durationMs: ingest.durationMs ?? 0,
        closedAt: ingest.closedAt,
        replayed: true,
      },
      thumbnailMasterVideoId: null,
    };
  }

  // a segment landed after the sweep picked this row: leave it open
  if (guard.idleCutoff && ingestIdleSince(ingest) > guard.idleCutoff) return null;

  const summary = await contiguousSummary(ingestId, tx);
  const closedAt = new Date();
  await tx
    .update(recordingIngest)
    .set({
      closedAt,
      finalSequence: summary.contiguousSequence,
      durationMs: summary.durationMs,
      updatedAt: closedAt,
    })
    .where(eq(recordingIngest.ingestId, ingestId));
  await stampDomainClose(ingest, summary, tx);

  return {
    result: {
      ingestId,
      finalSequence: summary.contiguousSequence,
      durationMs: summary.durationMs,
      closedAt,
      replayed: false,
    },
    // one master close is one thumbnail job; a clip has no filmstrip
    thumbnailMasterVideoId: ingest.kind === "master" ? ingest.masterVideoId : null,
  };
};

// Stills are queued after a close commits. Injectable so tests never run the
// real job: the worker owns MinIO and FFmpeg, and an ingest test should touch
// neither.
export type ThumbnailDispatch = {
  master: (masterVideoId: number) => void;
  clip: (clipId: number) => void;
};

export const defaultThumbnailDispatch: ThumbnailDispatch = {
  master: enqueueThumbnails,
  clip: enqueueClipStill,
};

// explicit close from the client: the ticket proves the caller owns the capture
export const closeIngest = async (
  input: { ingestId: number; ticket: string; dispatch?: ThumbnailDispatch },
  database?: DbOrTx,
): Promise<IngestCloseResult> => {
  const run = async (tx: DbOrTx) =>
    (await runClose(input.ingestId, { ticket: input.ticket }, tx))!;
  const closed = database ? await run(database) : await db.transaction(run);
  if (closed.thumbnailMasterVideoId !== null) {
    (input.dispatch ?? defaultThumbnailDispatch).master(closed.thumbnailMasterVideoId);
  }
  return closed.result;
};

// sweep close: no ticket, and a stale row simply loses the race
export const closeIdleIngest = async (
  ingestId: number,
  idleCutoff: Date,
  database?: DbOrTx,
  dispatch: ThumbnailDispatch = defaultThumbnailDispatch,
): Promise<IngestCloseResult | null> => {
  const run = (tx: DbOrTx) => runClose(ingestId, { idleCutoff }, tx);
  const closed = database ? await run(database) : await db.transaction(run);
  if (closed === null) return null;
  // A swept close mints the same thumbnails an explicit one does.
  if (closed.thumbnailMasterVideoId !== null) {
    dispatch.master(closed.thumbnailMasterVideoId);
  }
  return closed.result;
};

/* =========================================================
   STATUS
   Read-only view of one ingest for the recording client.
========================================================= */

export type IngestStatus = {
  ingestId: number;
  kind: "master" | "clip";
  domain: IngestDomain;
  open: boolean;
  openedAt: Date;
  lastSegmentAt: Date | null;
  closedAt: Date | null;
  contiguousSequence: number;
  finalSequence: number | null;
  durationMs: number | null;
  segmentCount: number;
};

export const getIngestStatus = async (
  ingestId: number,
  ticket: string,
  database?: DbOrTx,
): Promise<IngestStatus> => {
  const handle = database ?? db;
  const ingest = await handle.query.recordingIngest.findFirst({
    where: eq(recordingIngest.ingestId, ingestId),
  });
  if (!ingest) throw notFound("Ingest");
  if (!ticketMatches(ticket, ingest.ticketHash)) {
    throw new AppError(401, "unauthorized", "Authorization: ticket does not match this ingest");
  }

  const stored = await handle
    .select({ sequence: recordingIngestSegment.sequence })
    .from(recordingIngestSegment)
    .where(eq(recordingIngestSegment.ingestId, ingestId));

  return {
    ingestId: ingest.ingestId,
    kind: ingest.kind,
    domain: await loadDomain(ingest, handle),
    open: ingest.closedAt === null,
    openedAt: ingest.openedAt,
    lastSegmentAt: ingest.lastSegmentAt,
    closedAt: ingest.closedAt,
    contiguousSequence: ingest.contiguousSequence,
    finalSequence: ingest.finalSequence,
    durationMs: ingest.durationMs,
    segmentCount: stored.length,
  };
};

/* =========================================================
   SEGMENT STORAGE
   One closed TS segment per request. MinIO first, row second:
   the database never acknowledges a write the storage refused.
========================================================= */

// below the MinIO multipart threshold, so putObject stays a single PUT
export const SEGMENT_MAX_BYTES = 16 * 1024 * 1024;
export const SEGMENT_DURATION_MIN_MS = 100;
export const SEGMENT_DURATION_MAX_MS = 10_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type SegmentHeaders = {
  sequence: number;
  durationMs: number;
  checksumSha256: string;
  discontinuity: boolean;
};

// one integer header with an inclusive range (validation_error on any miss)
const integerHeader = (headers: Headers, name: string, min: number, max: number): number => {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") {
    throw new AppError(400, "validation_error", `${name}: required`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new AppError(400, "validation_error", `${name}: expected an integer`);
  }
  if (value < min || value > max) {
    throw new AppError(400, "validation_error", `${name}: expected ${min} through ${max}`);
  }
  return value;
};

// the segment contract: every field is checked before a body byte is buffered
export function parseSegmentHeaders(headers: Headers): SegmentHeaders {
  const sequence = integerHeader(headers, "x-segment-sequence", 0, Number.MAX_SAFE_INTEGER);
  const durationMs = integerHeader(
    headers,
    "x-segment-duration-ms",
    SEGMENT_DURATION_MIN_MS,
    SEGMENT_DURATION_MAX_MS,
  );

  const checksumSha256 = (headers.get("x-segment-checksum-sha256") ?? "").trim();
  if (!SHA256_HEX.test(checksumSha256)) {
    throw new AppError(
      400,
      "validation_error",
      "x-segment-checksum-sha256: expected 64 lowercase hex characters",
    );
  }

  const rawDiscontinuity = headers.get("x-segment-discontinuity");
  if (rawDiscontinuity !== null && rawDiscontinuity !== "1") {
    throw new AppError(400, "validation_error", "x-segment-discontinuity: expected 1");
  }

  return {
    sequence,
    durationMs,
    checksumSha256,
    discontinuity: rawDiscontinuity === "1",
  };
}

// content-length is required and capped before any byte reaches memory
export function parseSegmentContentLength(headers: Headers): number {
  const raw = headers.get("content-length");
  if (raw === null) {
    throw new AppError(411, "length_required", "content-length: required");
  }
  const length = Number(raw);
  if (!Number.isInteger(length) || length <= 0) {
    throw new AppError(400, "validation_error", "content-length: expected a positive integer");
  }
  if (length > SEGMENT_MAX_BYTES) {
    throw new AppError(
      413,
      "segment_too_large",
      `content-length: ${length} exceeds the ${SEGMENT_MAX_BYTES} byte segment cap`,
    );
  }
  return length;
}

// "Bearer <ticket>"; the ticket appears nowhere else in the request
export function parseBearerToken(authorization: string | null): string {
  const match = /^Bearer (.+)$/.exec(authorization ?? "");
  if (!match) {
    throw new AppError(401, "unauthorized", "Authorization: expected Bearer <ticket>");
  }
  return match[1]!;
}

// narrow seam: tests pass a fake, production passes MinIO
export type SegmentStorage = {
  put(bucket: string, key: string, body: Uint8Array): Promise<void>;
};

export const minioSegmentStorage: SegmentStorage = {
  put: async (bucket, key, body) => {
    await minio.putObject(bucket, key, Buffer.from(body), body.byteLength, {
      "Content-Type": "video/mp2t",
    });
  },
};

export type SegmentStoreOutcome = {
  ingestId: number;
  sequence: number;
  objectKey: string;
  contiguousSequence: number;
  // duration of the contiguous prefix after this commit
  durationMs: number;
  replayed: boolean;
  // The target, so the caller can queue that recording's stills after commit.
  kind: "master" | "clip";
  masterVideoId: number | null;
  clipId: number | null;
};

// every segment and the close stamp freeze on this lock, so they serialize
const lockIngest = async (ingestId: number, tx: DbOrTx) =>
  (await tx.select().from(recordingIngest).where(eq(recordingIngest.ingestId, ingestId)).for("update"))[0] ??
  null;

// walk the stored sequences in order: the prefix stops at the first hole
const contiguousSummary = async (ingestId: number, tx: DbOrTx) => {
  const rows = await tx
    .select({
      sequence: recordingIngestSegment.sequence,
      durationMs: recordingIngestSegment.durationMs,
    })
    .from(recordingIngestSegment)
    .where(eq(recordingIngestSegment.ingestId, ingestId))
    .orderBy(asc(recordingIngestSegment.sequence));

  let contiguous = -1;
  let durationMs = 0;
  for (const row of rows) {
    if (row.sequence !== contiguous + 1) break;
    contiguous = row.sequence;
    durationMs += row.durationMs;
  }
  return { contiguousSequence: contiguous, durationMs };
};

// flow: check body > look up ingest > ticket > replay/conflict > put > row > advance
export const storeIngestSegment = async (
  input: {
    ingestId: number;
    authorization: string | null;
    headers: SegmentHeaders;
    contentLength: number;
    body: Uint8Array;
    storage?: SegmentStorage;
  },
  database?: DbOrTx,
): Promise<SegmentStoreOutcome> => {
  const { headers, body } = input;

  if (body.byteLength > SEGMENT_MAX_BYTES) {
    throw new AppError(413, "segment_too_large", `body: ${body.byteLength} bytes exceeds the cap`);
  }
  if (body.byteLength !== input.contentLength) {
    throw new AppError(
      400,
      "validation_error",
      `content-length: announced ${input.contentLength}, read ${body.byteLength}`,
    );
  }
  const actualChecksum = createHash("sha256").update(body).digest("hex");
  if (actualChecksum !== headers.checksumSha256) {
    throw new AppError(
      400,
      "checksum_mismatch",
      `x-segment-checksum-sha256: announced ${headers.checksumSha256}, computed ${actualChecksum}`,
    );
  }

  const ticket = parseBearerToken(input.authorization);
  const storage = input.storage ?? minioSegmentStorage;

  const run = async (tx: DbOrTx): Promise<SegmentStoreOutcome> => {
    const ingest = await lockIngest(input.ingestId, tx);
    if (!ingest) throw notFound("Ingest");
    if (!ticketMatches(ticket, ingest.ticketHash)) {
      throw new AppError(401, "unauthorized", "Authorization: ticket does not match this ingest");
    }
    if (ingest.closedAt !== null) {
      throw new AppError(
        410,
        "ingest_closed",
        `Ingest ${input.ingestId} closed at sequence ${ingest.finalSequence ?? -1}`,
      );
    }

    const [stored] = await tx
      .select()
      .from(recordingIngestSegment)
      .where(
        and(
          eq(recordingIngestSegment.ingestId, input.ingestId),
          eq(recordingIngestSegment.sequence, headers.sequence),
        ),
      );
    if (stored) {
      if (stored.checksumSha256 !== headers.checksumSha256 || stored.sizeBytes !== body.byteLength) {
        throw new AppError(
          409,
          "segment_conflict",
          `Sequence ${headers.sequence} already holds different bytes`,
        );
      }
      // byte-identical replay: the object stays, the row stays
      return {
        ingestId: input.ingestId,
        sequence: headers.sequence,
        objectKey: stored.objectKey,
        contiguousSequence: ingest.contiguousSequence,
        durationMs: ingest.durationMs ?? 0,
        replayed: true,
        kind: ingest.kind,
        masterVideoId: ingest.masterVideoId,
        clipId: ingest.clipId,
      };
    }

    // the prefix was frozen at admission; the tail is the only thing left to build
    const leaf = segmentLeafV2(ingest.keyPrefix, headers.sequence);

    // one immutable object per segment; the row commits only after this returns
    await storage.put(leaf.bucket, leaf.key, body);

    await tx.insert(recordingIngestSegment).values({
      ingestId: input.ingestId,
      sequence: headers.sequence,
      checksumSha256: headers.checksumSha256,
      sizeBytes: body.byteLength,
      durationMs: headers.durationMs,
      discontinuity: headers.discontinuity,
      objectKey: leaf.key,
    });

    const summary = await contiguousSummary(input.ingestId, tx);
    await tx
      .update(recordingIngest)
      .set({
        contiguousSequence: summary.contiguousSequence,
        durationMs: summary.durationMs,
        lastSegmentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(recordingIngest.ingestId, input.ingestId));

    return {
      ingestId: input.ingestId,
      sequence: headers.sequence,
      objectKey: leaf.key,
      contiguousSequence: summary.contiguousSequence,
      durationMs: summary.durationMs,
      replayed: false,
      kind: ingest.kind,
      masterVideoId: ingest.masterVideoId,
      clipId: ingest.clipId,
    };
  };

  return database ? run(database) : db.transaction(run);
};
