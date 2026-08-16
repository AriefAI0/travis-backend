import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { log } from "../../lib/logger";
import { tracker } from "../../lib/db/minio_tracker";
import { s3parts } from "../../lib/minio_storage/s3sdk";
import { Assembler } from "./assembler";

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

function requireUploadable(session: ReturnType<typeof tracker.getSession>) {
  if (["stopping", "finalizing", "finalized"].includes(session!.status)) {
    throw new AppError(409, "wrong_state", `recording is ${session!.status}`);
  }
  if (session!.status === "stale") {
    tracker.setStatus(session!.id, "recording"); // app resumed
    log.info("session resumed", { session: session!.id });
  }
}

export async function createSession(appSessionId: string, kind: "master" | "clip") {
  if (tracker.countActive() >= env.MAX_ACTIVE_SESSIONS) {
    throw new AppError(429, "too_many_sessions", `max ${env.MAX_ACTIVE_SESSIONS} active sessions`);
  }

  const id = crypto.randomUUID();
  const bucket = kind === "master" ? env.BUCKET_MASTER : env.BUCKET_CLIP;
  const objectKey = `recordings/${id}/master.ts`;

  try {
    tracker.createSession({ id, appSessionId, kind, bucket, objectKey });
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new AppError(409, "duplicate_session", `session ${appSessionId} (${kind}) already exists`);
    }
    throw err;
  }

  let uploadId: string;
  try {
    uploadId = await s3parts.initiate(bucket, objectKey);
  } catch (err) {
    // Row stays in 'created'; the boot reconciler re-initiates (spec D4).
    log.error("initiate failed", { session: id, err: String(err) });
    throw new AppError(503, "storage_unavailable", "MinIO unreachable");
  }
  tracker.setRecording(id, uploadId);
  log.info("session opened", { session: id, kind, appSessionId });
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

export function getSessionStatus(id: string) {
  const session = requireSession(id);
  return {
    id: session.id,
    status: session.status,
    durableThrough: session.durable_through,
    segmentsReceived: tracker.segmentsReceived(session.id),
    artifactStatus: session.status === "finalized" ? (session.size_bytes ? "ready" : "none") : "pending",
  };
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

  const parts = tracker.parts(id);
  const totalBytes = parts.reduce((n, p) => n + p.size_bytes, 0);

  // Zero durable bytes: no part may be uploaded, so the MPU is aborted and the
  // recording finalizes empty (no artifacts).
  if (parts.length === 0) {
    await s3parts.abort(session.bucket!, session.object_key!, session.upload_id!);
    tracker.setFinalizedEmpty(id);
    log.warn("session stopped with zero segments", { session: id });
    return { id, status: "finalized" as const };
  }

  try {
    await s3parts.complete(
      session.bucket!,
      session.object_key!,
      session.upload_id!,
      parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
    );
  } catch (err) {
    // A retried stop after a completed-but-untracked complete lands here.
    if (String(err).includes("NoSuchUpload")) throw new AppError(503, "storage_unavailable", "stop retry needed");
    throw new AppError(503, "storage_unavailable", `complete failed: ${String(err)}`);
  }
  tracker.setCompleted(id, totalBytes);
  tracker.enqueueJob(id, "finalize");
  log.info("session stopped", { session: id, parts: parts.length, bytes: totalBytes });
  return { id, status: "finalizing" as const };
}
