import { and, asc, eq, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { masterVideo, recordingIngest, session } from "../schema";

export type ProjectMasterVideoRow = {
  masterVideoId: number;
  sessionId: number;
  sessionName: string | null;
  // per-project ordinal: what a recording card labels itself with. The global
  // sessionId above is the identity and never reads as a user-facing number.
  sessionDisplayNumber: number | null;
  startEpoch: number;
  endEpoch: number | null;
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
      sessionDisplayNumber: session.displayNumber,
      startEpoch: masterVideo.startEpoch,
      endEpoch: masterVideo.endEpoch,
      durationMs: masterVideo.durationMs,
    })
    .from(masterVideo)
    .innerJoin(session, eq(session.sessionId, masterVideo.sessionId))
    .where(eq(session.projectId, projectId))
    .orderBy(asc(masterVideo.startEpoch), asc(masterVideo.masterVideoId));

// Masters still open on the wire: an ingest row that has not closed. This is
// the whole "unfinished" signal in the direct protocol — no status string.
export const listMasterVideoRecordsWithOpenIngest = async (
  database: DbOrTx = db,
): Promise<UnfinishedMasterVideoRow[]> =>
  database
    .selectDistinct({
      masterVideoId: masterVideo.masterVideoId,
      sessionId: masterVideo.sessionId,
      startEpoch: masterVideo.startEpoch,
      endEpoch: masterVideo.endEpoch,
      durationMs: masterVideo.durationMs,
    })
    .from(masterVideo)
    .innerJoin(
      recordingIngest,
      eq(recordingIngest.masterVideoId, masterVideo.masterVideoId),
    )
    .where(isNull(recordingIngest.closedAt))
    .orderBy(asc(masterVideo.masterVideoId));

export type UnfinishedMasterVideoRow = {
  masterVideoId: number;
  sessionId: number;
  startEpoch: number;
  endEpoch: number | null;
  durationMs: number | null;
};

// The master a session is capturing right now: its ingest row is still open.
// An inspection may only start against a session in this state.
export const findMasterVideoRecordWithOpenIngestBySessionId = async (
  sessionId: number,
  database: DbOrTx = db,
): Promise<UnfinishedMasterVideoRow | null> =>
  (await database
    .select({
      masterVideoId: masterVideo.masterVideoId,
      sessionId: masterVideo.sessionId,
      startEpoch: masterVideo.startEpoch,
      endEpoch: masterVideo.endEpoch,
      durationMs: masterVideo.durationMs,
    })
    .from(masterVideo)
    .innerJoin(
      recordingIngest,
      eq(recordingIngest.masterVideoId, masterVideo.masterVideoId),
    )
    .where(
      and(eq(masterVideo.sessionId, sessionId), isNull(recordingIngest.closedAt)),
    )
    .orderBy(asc(masterVideo.masterVideoId))
    .limit(1))[0] ?? null;

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
