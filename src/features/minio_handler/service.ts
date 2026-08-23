import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { log } from "../../lib/logger";
import { tracker, type SessionRow } from "../../lib/db/minio_tracker";
import { PART_UPLOAD_TTL_SECONDS, presignPartUpload, s3parts } from "../../lib/minio_storage/s3sdk";
import { mintGetUrl } from "../../lib/minio_storage/mint";
import { Assembler } from "./assembler";
import { baseKey, identityString, leafKeys, rawKey, type RecordingIdentity } from "./paths";

const assemblers = new Map<string, Assembler>();

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

export async function createSession(identity: RecordingIdentity) {
  if (tracker.countActive() >= env.MAX_ACTIVE_SESSIONS) {
    throw new AppError(429, "too_many_sessions", `max ${env.MAX_ACTIVE_SESSIONS} active sessions`);
  }

  const id = crypto.randomUUID();
  const appSessionId = identityString(identity);
  const objectKey = baseKey(identity); // base key; MPU ops derive the raw leaf

  try {
    tracker.createSession({ id, appSessionId, kind: identity.kind, bucket: env.BUCKET_RAW, objectKey });
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new AppError(409, "duplicate_session", `recording ${appSessionId} already exists`);
    }
    throw err;
  }

  let uploadId: string;
  try {
    uploadId = await s3parts.initiate(env.BUCKET_RAW, rawKey(identity.kind, objectKey));
  } catch (err) {
    // Row stays in 'created'; boot recovery re-initiates (spec D4).
    log.error("initiate failed", { session: id, err: String(err) });
    throw new AppError(503, "storage_unavailable", "MinIO unreachable");
  }
  tracker.setRecording(id, uploadId);
  log.info("session opened", { session: id, kind: identity.kind, identity: appSessionId });
  return { id, status: "recording" as const };
}

export async function appendSegment(id: string, idx: number, bytes: Uint8Array) {
  const session = requireSession(id);
  requireUploadable(session);
  tracker.touch(id);
  const assembler = assemblerFor(session);
  await assembler.append(idx, bytes);
  return { durableThrough: assembler.durableThrough, receivedIndex: idx };
}

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
  if (!session.upload_id || !session.bucket || !session.object_key) {
    throw new AppError(409, "wrong_state", "recording upload not initialized");
  }
  const partNumber = tracker.getNextPartNumber(id)!;
  const url = await presignPartUpload(
    session.bucket,
    rawKey(session.kind, session.object_key),
    session.upload_id,
    partNumber,
  );
  return { partNumber, url, expiresInSeconds: PART_UPLOAD_TTL_SECONDS };
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
export async function getArtifacts(id: string) {
  const session = requireSession(id);
  if (session.status !== "finalized" || !session.size_bytes) {
    throw new AppError(
      409,
      "wrong_state",
      session.status === "finalized" ? "recording has no artifacts" : `recording is ${session.status}`,
    );
  }
  const keys = leafKeys(session.kind, session.object_key!);
  return {
    hls: {
      manifest: await mintGetUrl(env.BUCKET_MEDIA, keys.hlsManifest),
      media: await mintGetUrl(env.BUCKET_MEDIA, keys.hlsMedia),
    },
    mkv: await mintGetUrl(env.BUCKET_MEDIA, keys.mkv),
    thumbnail: await mintGetUrl(env.BUCKET_THUMBNAILS, keys.thumb),
    durationMs: session.duration_ms,
  };
}

// Shared finalize tail for stop / stale-truncate / boot-recovered stops:
// complete the MPU from ledger parts (abort when nothing durable), enqueue job.
export async function finalizeRecording(session: SessionRow, opts: { truncated?: boolean } = {}) {
  const parts = tracker.parts(session.id);
  const totalBytes = parts.reduce((n, p) => n + p.size_bytes, 0);

  // Zero durable bytes: no part may be uploaded, so the MPU is aborted and the
  // recording finalizes empty (no artifacts).
  if (parts.length === 0) {
    if (session.upload_id) {
      await s3parts.abort(session.bucket!, rawKey(session.kind, session.object_key!), session.upload_id);
    }
    tracker.setFinalizedEmpty(session.id, opts.truncated);
    log.warn("session finalized with zero durable bytes", { session: session.id, truncated: opts.truncated });
    return { id: session.id, status: "finalized" as const };
  }

  try {
    await s3parts.complete(
      session.bucket!,
      rawKey(session.kind, session.object_key!),
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
