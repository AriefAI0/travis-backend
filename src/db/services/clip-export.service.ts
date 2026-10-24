// One durable MKV export per clip. The route queues a row; the merge runs
// outside the request and writes the state a polling client reads.

import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClipExportState } from "../../types/api";
import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { log } from "../../lib/logger";
import type { DbOrTx } from "../client";
import { mergeClip } from "../../features/recording/jobs/remux";
import { mintDownloadUrl } from "../../lib/minio_storage/mint";
import {
  findClipExportByClipId,
  findClipExportById,
  listProcessingClipExports,
  markClipExportFailed,
  markClipExportReady,
  startClipExportRecord,
  type ClipExportRow,
} from "../repositories/clip-export.repository";

export type ClipExportDeps = {
  mergeClip: typeof mergeClip;
  scratchRoot: (jobId: number) => string;
};

const defaultDeps: ClipExportDeps = {
  mergeClip,
  scratchRoot: (jobId) => path.join(os.tmpdir(), "travis-clip-export", String(jobId)),
};

export const clipExportDeps: ClipExportDeps = { ...defaultDeps };
export const resetClipExportDeps = () => Object.assign(clipExportDeps, defaultDeps);

export const clipExportState = (row: ClipExportRow): ClipExportState => ({
  clipId: row.clipId,
  state: row.status,
  filename: row.filename,
  sizeBytes: row.sizeBytes,
  error: row.error,
  startedAt: row.startedAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

// flow: claim row > merge > ready or failed > remove this job's scratch only
export const runClipExport = async (
  jobId: number,
  database?: DbOrTx,
): Promise<ClipExportRow | null> => {
  const job = await findClipExportById(jobId, database);
  if (!job || job.status === "ready") return job;

  const scratch = clipExportDeps.scratchRoot(jobId);
  try {
    const result = await clipExportDeps.mergeClip(job.clipId, scratch);
    if (result.status === "ok" && result.key) {
      const filename = result.key.split("/").pop() ?? `clip-${job.clipId}.mkv`;
      return await markClipExportReady(
        jobId,
        {
          objectKey: result.key,
          filename,
          sizeBytes: result.sizeBytes,
        },
        database,
      );
    }
    return await markClipExportFailed(
      jobId,
      result.error ?? `merge ${result.status}`,
      database,
    );
  } catch (error) {
    log.error("clip export failed", { jobId, clipId: job.clipId, err: String(error) });
    return markClipExportFailed(jobId, String(error), database);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch((error) => {
      log.warn("clip export scratch cleanup failed", { scratch, err: String(error) });
    });
  }
};

// A ready job keeps its object; a failed job retries the same row.
export const startClipExport = async (
  clipId: number,
  database?: DbOrTx,
): Promise<ClipExportRow> => {
  const existing = await findClipExportByClipId(clipId, database);
  if (existing?.status === "processing" || existing?.status === "ready") {
    return existing;
  }

  const job = await startClipExportRecord(clipId, database);
  if (!job) throw new Error(`failed to start clip export for ${clipId}`);
  void runClipExport(job.jobId, database);
  return job;
};

// Boot: an export cut short by a restart returns to work.
export const recoverClipExports = async (database?: DbOrTx): Promise<number> => {
  const jobs = await listProcessingClipExports(database);
  for (const job of jobs) void runClipExport(job.jobId, database);
  return jobs.length;
};

export const getClipExport = async (
  clipId: number,
  database?: DbOrTx,
): Promise<ClipExportState | null> => {
  const row = await findClipExportByClipId(clipId, database);
  return row ? clipExportState(row) : null;
};

// flow: ready row > stored leaf and filename > fresh presigned download URL
export const getClipExportDownload = async (
  clipId: number,
  database?: DbOrTx,
): Promise<{ url: string; filename: string; sizeBytes: number }> => {
  const row = await findClipExportByClipId(clipId, database);
  if (!row) {
    throw new AppError(404, "not_found", `clip ${clipId} has no export`);
  }
  if (row.status !== "ready" || !row.objectKey || !row.filename) {
    throw new AppError(
      409,
      "export_not_ready",
      `clip ${clipId} export is ${row.status}`,
    );
  }

  return {
    url: await mintDownloadUrl(
      env.BUCKET_MEDIA,
      row.objectKey,
      row.filename,
      env.PRESIGN_GET_TTL_SECONDS,
    ),
    filename: row.filename,
    sizeBytes: row.sizeBytes ?? 0,
  };
};
