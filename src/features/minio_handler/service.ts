import { env } from "../../config/env";
import { db } from "../../db/client";
import * as sessionService from "../../db/services/session.service";
import * as videoService from "../../db/services/video.service";
import { AppError } from "../../lib/error";
import { log } from "../../lib/logger";
import { tracker, type SessionRow } from "../../lib/db/minio_tracker";
import { PART_UPLOAD_TTL_SECONDS, presignPartUpload, s3parts } from "../../lib/minio_storage/s3sdk";
import { mintGetUrl } from "../../lib/minio_storage/mint";
import { Assembler } from "./assembler";
import {
  clipStem,
  identityString,
  masterLeaves,
  masterStem,
  clipLeaves,
  rawLeaf,
  stemPk,
  type Leaf,
} from "./paths";

const assemblers = new Map<string, Assembler>();

// create request after the inversion: no client-supplied recording ids
export type CreateRecordingSession =
  | { kind: "master"; projectId: number; sessionId: number }
  | { kind: "clip"; projectId: number; sessionId: number; itemId: number; resultId: number };

function assemblerFor(session: ReturnType<typeof tracker.getSession>): Assembler {
  let a = assemblers.get(session!.id);
  if (!a) {
    a = new Assembler(session!);
    assemblers.set(session!.id, a);
  }
  return a;
}

function requireSession(id: string) {
  const session = tracker.getSession(id);
  if (!session) throw new AppError(404, "not_found", `recording ${id} not found`);
  return session;
}

function requireUploadable(session: SessionRow) {
  if (["stopping", "truncating", "finalizing", "finalized"].includes(session.status)) {
    throw new AppError(409, "wrong_state", `recording is ${session.status}`);
  }
  if (session.status === "stale") {
    tracker.setStatus(session.id, "recording"); // app resumed
    log.info("session resumed", { session: session.id });
  }
}

// A dead tracker session must not leave its domain row stuck on 'recording':
// unfinished lists and the clip parent-pick read that status. The stem carries
// the domain PK, so failures map back without extra tracker columns.
export async function markRecordingFailedByStem(stem: string, reason: string) {
  const ref = stemPk(stem);
  if (!ref) return;
  try {
    if (ref.kind === "master") {
      await videoService.markMasterVideoFinalizationFailed(ref.pk, reason);
    } else {
      await videoService.markVideoClipFinalizationFailed(ref.pk, reason);
    }
  } catch (err) {
    log.error("failed to mark domain row finalization_failed", { stem, err: String(err) });
  }
}

// flow: domain row > server PK > stem > tracker row > MPU initiate
// The stem is derived from the database-assigned primary key, so the client
// never coordinates ids; the row carries its key prefix from birth.
export async function createSession(identity: CreateRecordingSession) {
  if (tracker.countActive() >= env.MAX_ACTIVE_SESSIONS) {
    throw new AppError(429, "too_many_sessions", `max ${env.MAX_ACTIVE_SESSIONS} active sessions`);
  }

  const created = await db.transaction(async (tx) => {
    // project comes from the session row, never the body — a stem lying about
    // its project prefix would live forever in a domain row
    const sessionRow = await sessionService.getSessionById(identity.sessionId, tx);
    if (!sessionRow) {
      throw new AppError(404, "not_found", `session ${identity.sessionId} not found`);
    }
    if (sessionRow.projectId !== identity.projectId) {
      throw new AppError(
        400,
        "bad_request",
        `session ${identity.sessionId} belongs to project ${sessionRow.projectId}, not ${identity.projectId}`,
      );
    }
    const projectId = sessionRow.projectId;

    if (identity.kind === "master") {
      // one composited stream per recording (spec): source_index 0, primary
      const video = await videoService.createMasterVideo(
        {
          sessionId: identity.sessionId,
          // NOT NULL placeholder; rewritten to the stem-derived key below in this tx
          fileUrl: "pending",
          startEpoch: Math.floor(Date.now() / 1000),
          recordingStatus: videoService.RECORDING_PERSISTENCE_STATUS.recording,
          sourceIndex: 0,
          isPrimary: true,
          startedAt: new Date(),
        },
        tx,
      );
      if (!video) throw new Error("master video insert returned no row");
      const stem = masterStem(projectId, identity.sessionId, video.masterVideoId);
      await videoService.updateMasterVideo(
        video.masterVideoId,
        { fileUrl: `${stem}.ts`, storageStem: stem },
        tx,
      );
      const identityStr = identityString({
        kind: "master",
        projectId,
        sessionId: identity.sessionId,
        recordingId: video.masterVideoId,
      });
      return { kind: "master" as const, pk: video.masterVideoId, stem, identityString: identityStr };
    }

    // clip: parent master resolved server-side (session's recording master,
    // falling back to its latest); clips cannot exist without one
    const masters = await videoService.listMasterVideosBySessionId(identity.sessionId, tx);
    if (masters.length === 0) {
      throw new AppError(409, "no_master_video", `session ${identity.sessionId} has no master video to clip from`);
    }
    const parent =
      masters.filter((m) => m.recordingStatus === "recording").at(-1) ?? masters.at(-1)!;
    const clip = await videoService.createVideoClip(
      {
        resultId: identity.resultId,
        masterVideoId: parent.masterVideoId,
        startOffsetMs: 0,
        endOffsetMs: null,
        clipFileUrl: null,
        thumbnailUrl: null,
        recordingStatus: videoService.RECORDING_PERSISTENCE_STATUS.recording,
      },
      tx,
    );
    if (!clip) throw new Error("video clip insert returned no row");
    const stem = clipStem(projectId, identity.sessionId, clip.clipId);
    await videoService.updateVideoClip(
      clip.clipId,
      { clipFileUrl: `${stem}.ts`, storageStem: stem },
      tx,
    );
    const identityStr = identityString({
      kind: "clip",
      projectId,
      sessionId: identity.sessionId,
      itemId: identity.itemId,
      clipId: clip.clipId,
    });
    return { kind: "clip" as const, pk: clip.clipId, stem, identityString: identityStr };
  });

  const id = crypto.randomUUID();
  tracker.createSession({
    id,
    identityString: created.identityString,
    kind: identity.kind,
    bucket: env.BUCKET_RAW,
    storageStem: created.stem,
    projectId: identity.projectId,
    sessionId: identity.sessionId,
  });

  let uploadId: string;
  try {
    uploadId = await s3parts.initiate(env.BUCKET_RAW, rawLeaf(created.stem).key);
  } catch (err) {
    // The client never received this id, so nothing can resume it: fail the
    // domain row now instead of leaving a phantom 'recording' row behind.
    log.error("initiate failed", { session: id, err: String(err) });
    await markRecordingFailedByStem(created.stem, "create failed: storage unreachable");
    throw new AppError(503, "storage_unavailable", "MinIO unreachable");
  }
  tracker.setRecording(id, uploadId);
  log.info("session opened", { session: id, kind: identity.kind, identity: created.identityString });
  return created.kind === "master"
    ? { id, masterVideoId: created.pk, storageStem: created.stem, status: "recording" as const, partSizeBytes: env.PART_SIZE_BYTES }
    : { id, clipId: created.pk, storageStem: created.stem, status: "recording" as const, partSizeBytes: env.PART_SIZE_BYTES };
}

export async function appendSegment(id: string, idx: number, bytes: Uint8Array) {
  const session = requireSession(id);
  requireUploadable(session);
  tracker.touch(id);
  const assembler = assemblerFor(session);
  await assembler.append(idx, bytes);
  return { durableThrough: assembler.durableThrough, receivedIndex: idx };
}

// heartbeat drives staleness: touching here is what keeps a session live,
// even when no bytes flow (parts are large, uploads are bursty)
export function heartbeat(id: string) {
  const session = requireSession(id);
  requireUploadable(session);
  tracker.touch(id);
  return { durableThrough: session.durable_through };
}

// flow: reserve > state check > sticky part number > presigned PUT ticket
// Idempotent ticket counter: the number only moves when a part is reported
// complete, so retries before complete always get the SAME part number back.
export async function reservePart(id: string) {
  const session = requireSession(id);
  requireUploadable(session); // wrong_state past recording; stale flips to recording
  tracker.touch(id); // proof of life: a just-resumed session must not re-stale
  if (!session.upload_id || !session.bucket || !session.storage_stem) {
    throw new AppError(409, "wrong_state", "recording upload not initialized");
  }
  const partNumber = tracker.getNextPartNumber(id)!;
  const raw = rawLeaf(session.storage_stem);
  const url = await presignPartUpload(
    raw.bucket,
    raw.key,
    session.upload_id,
    partNumber,
  );
  return { partNumber, url, expiresInSeconds: PART_UPLOAD_TTL_SECONDS };
}

// flow: complete > replay check > shape > state > part number > contiguity > commit
// The gatekeeper: app reports an uploaded part (ETag in hand), server proves the
// segment range extends the durable prefix exactly, then advances the ledger.
// No size minimum here: the app flushes sub-threshold parts only on its final
// drain (before stop), so the session is never 'stopping' yet — and only-the-
// last-part-may-be-small is enforced absolutely by MinIO's EntityTooSmall at
// MPU complete time (a loud 503 at stop, never silent byte loss).
export async function completePart(
  id: string,
  partNumber: number,
  body: { etag: string; firstIndex: number; lastIndex: number; sizeBytes: number },
) {
  const session = requireSession(id);

  // replay first: an already-committed part sits behind durable_through, so
  // contiguity would reject it — same etag acks, different etag is app error
  const existing = tracker.getPart(id, partNumber);
  if (existing) {
    if (existing.etag !== body.etag) {
      throw new AppError(409, "wrong_part", `part ${partNumber} already recorded with a different etag`, {
        reason: "etag_mismatch",
        expected: session.next_part_number,
        received: partNumber,
      });
    }
    return { durableThrough: session.durable_through, nextPartNumber: session.next_part_number };
  }

  if (body.lastIndex < body.firstIndex) {
    throw new AppError(400, "bad_range", "lastIndex must be >= firstIndex", {
      firstIndex: body.firstIndex,
      lastIndex: body.lastIndex,
    });
  }
  if (["truncating", "finalizing", "finalized"].includes(session.status)) {
    throw new AppError(409, "wrong_state", `recording is ${session.status}`, { status: session.status });
  }
  if (partNumber !== session.next_part_number) {
    throw new AppError(409, "wrong_part", `expected part ${session.next_part_number}, got ${partNumber}`, {
      expected: session.next_part_number,
      received: partNumber,
    });
  }
  if (body.firstIndex !== session.durable_through + 1) {
    throw new AppError(409, "out_of_order", `expected firstIndex ${session.durable_through + 1}, got ${body.firstIndex}`, {
      durableThrough: session.durable_through,
      expected: session.durable_through + 1,
      received: body.firstIndex,
    });
  }

  tracker.reportPart(id, { partNumber, etag: body.etag, sizeBytes: body.sizeBytes, firstIdx: body.firstIndex, lastIdx: body.lastIndex });
  tracker.touch(id);
  log.info("part reported", { session: id, partNumber, firstIndex: body.firstIndex, lastIndex: body.lastIndex });
  return { durableThrough: body.lastIndex, nextPartNumber: partNumber + 1 };
}

export function getSessionStatus(id: string) {
  const session = requireSession(id);
  return {
    id: session.id,
    status: session.status,
    durableThrough: session.durable_through,
    segmentsReceived: tracker.segmentsReceived(session.id),
    artifactStatus: session.status === "finalized" ? (session.size_bytes ? "ready" : "none") : "pending",
    truncatedAt: session.truncated_at,
  };
}

// Minted playback/download URLs — available only after finalize (spec D10).
const mint = (leaf: Leaf) => mintGetUrl(leaf.bucket, leaf.key);

export async function getArtifacts(id: string) {
  const session = requireSession(id);
  if (session.status !== "finalized" || !session.size_bytes) {
    throw new AppError(
      409,
      "wrong_state",
      session.status === "finalized" ? "recording has no artifacts" : `recording is ${session.status}`,
    );
  }
  const leaves = session.kind === "master" ? masterLeaves(session.storage_stem!) : clipLeaves(session.storage_stem!);
  return {
    hls: {
      manifest: await mint(leaves.hlsManifest),
      media: await mint(leaves.hlsMedia),
    },
    mkv: await mint(leaves.mkv),
    thumbnail: await mint(leaves.poster),
    durationMs: session.duration_ms,
  };
}

// Shared finalize tail for stop / stale-truncate / boot-recovered stops:
// complete the MPU from ledger parts (abort when nothing durable), enqueue job.
export async function finalizeRecording(session: SessionRow, opts: { truncated?: boolean } = {}) {
  const parts = tracker.parts(session.id);
  const totalBytes = parts.reduce((n, p) => n + p.size_bytes, 0);

  // Zero durable bytes: no part may be uploaded, so the MPU is aborted and the
  // recording finalizes empty (no artifacts, domain row marked failed).
  if (parts.length === 0) {
    if (session.upload_id) {
      const raw = rawLeaf(session.storage_stem!);
      await s3parts.abort(raw.bucket, raw.key, session.upload_id);
    }
    tracker.setFinalizedEmpty(session.id, opts.truncated);
    await markRecordingFailedByStem(
      session.storage_stem!,
      opts.truncated ? "truncated with zero durable bytes" : "stopped with zero durable bytes",
    );
    log.warn("session finalized with zero durable bytes", { session: session.id, truncated: opts.truncated });
    return { id: session.id, status: "finalized" as const };
  }

  try {
    const raw = rawLeaf(session.storage_stem!);
    await s3parts.complete(
      raw.bucket,
      raw.key,
      session.upload_id!,
      parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
    );
  } catch (err) {
    // A retried stop after a completed-but-untracked complete lands here.
    if (String(err).includes("NoSuchUpload")) throw new AppError(503, "storage_unavailable", "stop retry needed");
    throw new AppError(503, "storage_unavailable", `complete failed: ${String(err)}`);
  }
  tracker.setCompleted(session.id, totalBytes, opts.truncated);
  tracker.enqueueJob(session.id, "finalize");
  log.info(opts.truncated ? "session truncated" : "session stopped", {
    session: session.id,
    parts: parts.length,
    bytes: totalBytes,
  });
  return { id: session.id, status: "finalizing" as const };
}

export async function stopSession(id: string) {
  const session = requireSession(id);
  if (!["recording", "stale", "stopping"].includes(session.status)) {
    throw new AppError(409, "wrong_state", `recording is ${session.status}`);
  }
  tracker.setStatus(id, "stopping");

  const assembler = assemblerFor(session);
  await assembler.flushFinal();
  assemblers.delete(id);

  return finalizeRecording(tracker.getSession(id)!);
}
