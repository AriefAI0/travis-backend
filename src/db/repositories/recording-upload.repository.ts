import { and, asc, eq } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { recordingSegment, recordingUpload } from "../schema";

// find one upload row by recording UUID, or null
export const findRecordingUploadById = async (
  recordingId: string,
  database: DbOrTx = db,
) =>
  (await database.query.recordingUpload.findFirst({
    where: eq(recordingUpload.recordingId, recordingId),
  })) ?? null;

// insert one upload row
export const insertRecordingUpload = async (
  data: typeof recordingUpload.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(recordingUpload).values(data).returning();
  return created[0] ?? null;
};

// update one upload row by recording UUID
export const updateRecordingUploadById = async (
  recordingId: string,
  data: Partial<typeof recordingUpload.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(recordingUpload)
    .set(data)
    .where(eq(recordingUpload.recordingId, recordingId))
    .returning();
  return updated[0] ?? null;
};

// lock one upload row FOR UPDATE — callers must hold a transaction
export const lockRecordingUploadById = async (
  recordingId: string,
  database: DbOrTx,
) => {
  const locked = await database
    .select()
    .from(recordingUpload)
    .where(eq(recordingUpload.recordingId, recordingId))
    .for("update");
  return locked[0] ?? null;
};

// list one recording's segment rows in index order
export const listRecordingSegments = async (
  recordingId: string,
  database: DbOrTx = db,
) =>
  database.query.recordingSegment.findMany({
    where: eq(recordingSegment.recordingId, recordingId),
    orderBy: asc(recordingSegment.segmentIndex),
  });

// find one segment row by recording + index, or null
export const findRecordingSegment = async (
  recordingId: string,
  segmentIndex: number,
  database: DbOrTx = db,
) =>
  (await database.query.recordingSegment.findFirst({
    where: and(
      eq(recordingSegment.recordingId, recordingId),
      eq(recordingSegment.segmentIndex, segmentIndex)
    ),
  })) ?? null;

// lock one segment row FOR UPDATE — callers must hold a transaction
export const lockRecordingSegment = async (
  recordingId: string,
  segmentIndex: number,
  database: DbOrTx,
) => {
  const locked = await database
    .select()
    .from(recordingSegment)
    .where(
      and(
        eq(recordingSegment.recordingId, recordingId),
        eq(recordingSegment.segmentIndex, segmentIndex)
      )
    )
    .for("update");
  return locked[0] ?? null;
};

// insert one segment reservation row
export const insertRecordingSegment = async (
  data: typeof recordingSegment.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(recordingSegment).values(data).returning();
  return created[0] ?? null;
};

// update one segment row (receipt transitions)
export const updateRecordingSegment = async (
  recordingId: string,
  segmentIndex: number,
  data: Partial<typeof recordingSegment.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(recordingSegment)
    .set(data)
    .where(
      and(
        eq(recordingSegment.recordingId, recordingId),
        eq(recordingSegment.segmentIndex, segmentIndex)
      )
    )
    .returning();
  return updated[0] ?? null;
};
