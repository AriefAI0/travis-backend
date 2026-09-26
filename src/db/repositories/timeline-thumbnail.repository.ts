import { and, asc, eq, inArray, isNotNull, notExists, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { recordingIngest, recordingIngestSegment, session, timelineThumbnail } from "../schema";

// Every session recording holding at least one segment, open or closed. The job
// derives its own due set, so a session already drawn on the current grid costs
// one source read and reports nothing. Asking the grid rather than the row
// count is what backfills a recording thumbnailed by an earlier, coarser
// interval.
export const listSessionIdsWithThumbnailWork = async (
  database: DbOrTx = db,
): Promise<number[]> =>
  (
    await database
      .selectDistinct({ sessionId: recordingIngest.sessionId })
      .from(recordingIngest)
      .innerJoin(
        recordingIngestSegment,
        eq(recordingIngestSegment.ingestId, recordingIngest.ingestId),
      )
      .where(isNotNull(recordingIngest.sessionId))
  ).map((row) => row.sessionId!);

// The grid points a session already has, for the job's due-set subtraction.
export const listTimelineThumbnailTimestampsBySessionId = async (
  sessionId: number,
  database: DbOrTx = db,
): Promise<number[]> =>
  (
    await database
      .select({ timestampMs: timelineThumbnail.timestampMs })
      .from(timelineThumbnail)
      .where(eq(timelineThumbnail.sessionId, sessionId))
  ).map((row) => row.timestampMs);

// Closed sessions with no timeline rows: the boot scan's whole signal, so a
// crash mid-thumbnail simply re-runs on the next start. A session counts as
// closed once its end epoch is stamped, which the ingest close does.
export const listSessionIdsMissingTimelineThumbnails = async (
  database: DbOrTx = db,
): Promise<number[]> =>
  (
    await database
      .select({ sessionId: session.sessionId })
      .from(session)
      .where(
        and(
          isNotNull(session.endEpoch),
          notExists(
            database
              .select({ present: sql`1` })
              .from(timelineThumbnail)
              .where(eq(timelineThumbnail.sessionId, session.sessionId)),
          ),
        ),
      )
      .orderBy(asc(session.sessionId))
  ).map((row) => row.sessionId);

export const createTimelineThumbnailRecords = async (
  data: (typeof timelineThumbnail.$inferInsert)[],
  database: DbOrTx = db,
) => {
  if (data.length === 0) {
    return [];
  }

  return database.insert(timelineThumbnail).values(data).returning();
};

// Card face for a session list: the earliest still per session, one batched
// query. The key column holds the object key the thumbnail job wrote.
export const listFirstTimelineThumbnailKeysBySessionIds = async (
  sessionIdList: number[],
  database: DbOrTx = db,
): Promise<Map<number, string>> => {
  const keysBySessionId = new Map<number, string>();

  if (sessionIdList.length === 0) {
    return keysBySessionId;
  }

  const rows = await database
    .select({
      sessionId: timelineThumbnail.sessionId,
      storageStem: timelineThumbnail.storageStem,
      timestampMs: timelineThumbnail.timestampMs,
    })
    .from(timelineThumbnail)
    .where(inArray(timelineThumbnail.sessionId, sessionIdList))
    .orderBy(asc(timelineThumbnail.sessionId), asc(timelineThumbnail.timestampMs));

  for (const row of rows) {
    // ordered by timestamp, so the first row per session wins
    if (!keysBySessionId.has(row.sessionId)) {
      keysBySessionId.set(row.sessionId, row.storageStem);
    }
  }

  return keysBySessionId;
};

export const listTimelineThumbnailRecordsBySessionId = async (
  sessionId: number,
  database: DbOrTx = db,
) =>
  database.query.timelineThumbnail.findMany({
    where: eq(timelineThumbnail.sessionId, sessionId),
    orderBy: asc(timelineThumbnail.timestampMs),
  });

export const deleteTimelineThumbnailRecordsBySessionId = async (
  sessionId: number,
  database: DbOrTx = db,
) =>
  database
    .delete(timelineThumbnail)
    .where(eq(timelineThumbnail.sessionId, sessionId))
    .returning();
