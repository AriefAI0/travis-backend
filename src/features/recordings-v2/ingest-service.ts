// Direct ingest: backend-owned identity for one capture attempt.
// flow: validate > create-or-reuse domain row > insert ingest > hand back one ticket

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { db, type DbOrTx } from "../../db/client";
import { AppError, notFound } from "../../lib/error";
import { mediaDatePath } from "../../lib/minio_storage/paths";
import { recordingIngest } from "../../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  createMasterVideoRecord,
  findMasterVideoById,
} from "../../db/repositories/master-video.repository";
import {
  createVideoClipRecord,
  listVideoClipRecordsByResultId,
} from "../../db/repositories/video-clip.repository";
import { findResultById } from "../../db/repositories/result.repository";
import { createSession } from "../../db/services/session.service";

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

// flow: session row > master row > ingest row. The session is minted per master.
const admitMaster = async (
  input: AdmitMasterInput,
  tx: DbOrTx,
): Promise<IngestAdmission> => {
  const startedAt = new Date(input.startEpoch * 1000);
  if (!Number.isFinite(startedAt.getTime())) {
    throw new AppError(400, "validation_error", "startEpoch: expected epoch seconds");
  }

  const session = (await createSession({ projectId: input.projectId }, tx))!;
  const master = (await createMasterVideoRecord(
    { sessionId: session.sessionId, startEpoch: input.startEpoch, recordingStatus: "recording" },
    tx,
  ))!;

  return {
    ...(await insertIngest(
      { kind: "master", masterVideoId: master.masterVideoId, keyDate: mediaDatePath(startedAt) },
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

  // uq_video_clip_result_id: one clip per result, so a re-record reuses the row
  const [existing] = await listVideoClipRecordsByResultId(input.resultId, tx);
  const clip =
    existing ??
    (await createVideoClipRecord(
      {
        resultId: input.resultId,
        masterVideoId: input.masterVideoId,
        startOffsetMs: input.startOffsetMs,
        recordingStatus: "recording",
      },
      tx,
    ))!;

  const open = await findOpenIngestByClip(clip.clipId, tx);
  if (open) {
    throw new AppError(409, "recording_in_progress", "Clip already has an open ingest");
  }

  return {
    ...(await insertIngest(
      {
        kind: "clip",
        clipId: clip.clipId,
        // clip keys reuse the master date, never the clip's own wall clock
        keyDate: mediaDatePath(new Date(master.startEpoch * 1000)),
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
    | { kind: "master"; masterVideoId: number; keyDate: string }
    | { kind: "clip"; clipId: number; keyDate: string },
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
    })
    .returning({ ingestId: recordingIngest.ingestId });

  return { ingestId: row!.ingestId, ticket, segmentTargetMs: SEGMENT_TARGET_MS };
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
