import { asc, eq, inArray } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { clipExportJob } from "../schema";

export type ClipExportRow = typeof clipExportJob.$inferSelect;

export const findClipExportByClipId = async (
  clipId: number,
  database: DbOrTx = db,
) =>
  (await database.query.clipExportJob.findFirst({
    where: eq(clipExportJob.clipId, clipId),
  })) ?? null;

export const findClipExportById = async (
  jobId: number,
  database: DbOrTx = db,
) =>
  (await database.query.clipExportJob.findFirst({
    where: eq(clipExportJob.jobId, jobId),
  })) ?? null;

// One row per clip; a retry resets the same row instead of stacking jobs.
export const startClipExportRecord = async (
  clipId: number,
  database: DbOrTx = db,
) => {
  const rows = await database
    .insert(clipExportJob)
    .values({ clipId, status: "processing", startedAt: new Date() })
    .onConflictDoUpdate({
      target: clipExportJob.clipId,
      set: {
        status: "processing",
        objectKey: null,
        filename: null,
        sizeBytes: null,
        error: null,
        startedAt: new Date(),
        finishedAt: null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return rows[0] ?? null;
};

export const markClipExportReady = async (
  jobId: number,
  values: { objectKey: string; filename: string; sizeBytes: number },
  database: DbOrTx = db,
) => {
  const rows = await database
    .update(clipExportJob)
    .set({
      status: "ready",
      objectKey: values.objectKey,
      filename: values.filename,
      sizeBytes: values.sizeBytes,
      error: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(clipExportJob.jobId, jobId))
    .returning();

  return rows[0] ?? null;
};

export const markClipExportFailed = async (
  jobId: number,
  error: string,
  database: DbOrTx = db,
) => {
  const rows = await database
    .update(clipExportJob)
    .set({
      status: "failed",
      error: error.slice(-2_000),
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(clipExportJob.jobId, jobId))
    .returning();

  return rows[0] ?? null;
};

// Restart recovery reads every job a dead process left processing.
export const listProcessingClipExports = async (database: DbOrTx = db) =>
  database.query.clipExportJob.findMany({
    where: inArray(clipExportJob.status, ["processing"]),
    orderBy: asc(clipExportJob.jobId),
  });
