import { and, asc, eq } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { recordingFinalizeJob } from "../schema";

// create a job row; no-op when recording/revision already has one
export const insertRecordingFinalizeJob = async (
  data: typeof recordingFinalizeJob.$inferInsert,
  database: DbOrTx = db,
) => {
  const inserted = await database
    .insert(recordingFinalizeJob)
    .values(data)
    .onConflictDoNothing({
      target: [recordingFinalizeJob.recordingId, recordingFinalizeJob.targetRevision],
    })
    .returning();
  return inserted[0] ?? null;
};

// find one job row by recording + target revision, or null
export const findRecordingFinalizeJobByRevision = async (
  recordingId: string,
  targetRevision: number,
  database: DbOrTx = db,
) =>
  (await database.query.recordingFinalizeJob.findFirst({
    where: and(
      eq(recordingFinalizeJob.recordingId, recordingId),
      eq(recordingFinalizeJob.targetRevision, targetRevision)
    ),
  })) ?? null;

// find one job row by id, or null
export const findRecordingFinalizeJobById = async (
  jobId: string,
  database: DbOrTx = db,
) =>
  (await database.query.recordingFinalizeJob.findFirst({
    where: eq(recordingFinalizeJob.jobId, jobId),
  })) ?? null;

// list one recording's job rows, oldest revision first
export const listRecordingFinalizeJobs = async (
  recordingId: string,
  database: DbOrTx = db,
) =>
  database.query.recordingFinalizeJob.findMany({
    where: eq(recordingFinalizeJob.recordingId, recordingId),
    orderBy: asc(recordingFinalizeJob.targetRevision),
  });

// update one job row by id (state, attempts, lease, error)
export const updateRecordingFinalizeJobById = async (
  jobId: string,
  data: Partial<typeof recordingFinalizeJob.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(recordingFinalizeJob)
    .set(data)
    .where(eq(recordingFinalizeJob.jobId, jobId))
    .returning();
  return updated[0] ?? null;
};
