import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { masterVideo, session } from "../schema";

export type ProjectMasterVideoRow = {
  masterVideoId: number;
  sessionId: number;
  sessionName: string | null;
  storageStem: string | null;
  startEpoch: number;
  endEpoch: number | null;
  recordingStatus: string;
  sourceIndex: number;
  isPrimary: boolean;
  sourceName: string | null;
  recoveryStatus: string | null;
  fileSize: number | null;
  durationMs: number | null;
};

export const createMasterVideoRecord = async (
  data: typeof masterVideo.$inferInsert,
  database: DbOrTx = db,
) => {
  const createdMasterVideos = await database
    .insert(masterVideo)
    .values(data)
    .returning();

  return createdMasterVideos[0] ?? null;
};

export const listMasterVideoRecords = async (database: DbOrTx = db) =>
  database.query.masterVideo.findMany({
    orderBy: [asc(masterVideo.sessionId), asc(masterVideo.startEpoch)],
  });

export const findMasterVideoById = async (
  masterVideoId: number,
  database: DbOrTx = db,
) =>
  (await database.query.masterVideo.findFirst({
    where: eq(masterVideo.masterVideoId, masterVideoId),
  })) ?? null;

export const listMasterVideoRecordsBySessionId = async (
  sessionId: number,
  database: DbOrTx = db,
) =>
  database.query.masterVideo.findMany({
    where: eq(masterVideo.sessionId, sessionId),
    // pk tiebreak: startEpoch is second-granularity, same-second creates need
    // a deterministic order for "latest" picks
    orderBy: [asc(masterVideo.startEpoch), asc(masterVideo.masterVideoId)],
  });

export const listMasterVideoRecordsByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
): Promise<ProjectMasterVideoRow[]> =>
  database
    .select({
      masterVideoId: masterVideo.masterVideoId,
      sessionId: masterVideo.sessionId,
      sessionName: session.name,
      storageStem: masterVideo.storageStem,
      startEpoch: masterVideo.startEpoch,
      endEpoch: masterVideo.endEpoch,
      recordingStatus: masterVideo.recordingStatus,
      sourceIndex: masterVideo.sourceIndex,
      isPrimary: masterVideo.isPrimary,
      sourceName: masterVideo.sourceName,
      recoveryStatus: masterVideo.recoveryStatus,
      fileSize: masterVideo.fileSize,
      durationMs: masterVideo.durationMs,
    })
    .from(masterVideo)
    .innerJoin(session, eq(session.sessionId, masterVideo.sessionId))
    .where(eq(session.projectId, projectId))
    .orderBy(asc(masterVideo.startEpoch), asc(masterVideo.masterVideoId));

export const listMasterVideoRecordsByStatuses = async (
  statuses: ("recording" | "finalized" | "interrupted" | "finalization_failed" | "canceled")[],
  database: DbOrTx = db,
) => {
  if (statuses.length === 0) {
    return [];
  }

  return database.query.masterVideo.findMany({
    where: inArray(masterVideo.recordingStatus, statuses),
    orderBy: asc(masterVideo.masterVideoId),
  });
};

export const listMasterVideoRecordsByProjectIdAndStatuses = async (
  projectId: number,
  statuses: ("recording" | "finalized" | "interrupted" | "finalization_failed" | "canceled")[],
  database: DbOrTx = db,
) => {
  if (statuses.length === 0) {
    return [];
  }

  return database
    .select({
      masterVideoId: masterVideo.masterVideoId,
      sessionId: masterVideo.sessionId,
      sessionName: session.name,
      storageStem: masterVideo.storageStem,
      startEpoch: masterVideo.startEpoch,
      endEpoch: masterVideo.endEpoch,
      recordingStatus: masterVideo.recordingStatus,
      sourceIndex: masterVideo.sourceIndex,
      isPrimary: masterVideo.isPrimary,
      sourceName: masterVideo.sourceName,
      recoveryStatus: masterVideo.recoveryStatus,
      fileSize: masterVideo.fileSize,
      durationMs: masterVideo.durationMs,
    })
    .from(masterVideo)
    .innerJoin(session, eq(session.sessionId, masterVideo.sessionId))
    .where(
      and(
        eq(session.projectId, projectId),
        inArray(masterVideo.recordingStatus, statuses),
      ),
    )
    .orderBy(desc(masterVideo.startEpoch), desc(masterVideo.masterVideoId));
};

export const updateMasterVideoById = async (
  masterVideoId: number,
  data: Partial<typeof masterVideo.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updatedMasterVideos = await database
    .update(masterVideo)
    .set(data)
    .where(eq(masterVideo.masterVideoId, masterVideoId))
    .returning();

  return updatedMasterVideos[0] ?? null;
};

export const deleteMasterVideoById = async (
  masterVideoId: number,
  database: DbOrTx = db,
) => {
  const deletedMasterVideos = await database
    .delete(masterVideo)
    .where(eq(masterVideo.masterVideoId, masterVideoId))
    .returning();

  return deletedMasterVideos[0] ?? null;
};
