import { and, asc, eq, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { masterVideo, recordingIngest, recordingIngestSegment, timelineThumbnail } from "../schema";

// Masters whose grid may still be short: a recording still running, or one that
// has never produced a still. The job decides what is due, so a master that is
// already covered comes back with nothing to do.
export const listMasterVideoIdsWithThumbnailWork = async (
  database: DbOrTx = db,
): Promise<number[]> =>
  (
    await database
      .selectDistinct({ masterVideoId: recordingIngest.masterVideoId })
      .from(recordingIngest)
      .innerJoin(
        recordingIngestSegment,
        eq(recordingIngestSegment.ingestId, recordingIngest.ingestId),
      )
      .where(
        and(
          isNotNull(recordingIngest.masterVideoId),
          or(
            isNull(recordingIngest.closedAt),
            notExists(
              database
                .select({ present: sql`1` })
                .from(timelineThumbnail)
                .where(eq(timelineThumbnail.masterVideoId, recordingIngest.masterVideoId)),
            ),
          ),
        ),
      )
  ).map((row) => row.masterVideoId!);

// The grid points a master already has, for the job's due-set subtraction.
export const listTimelineThumbnailTimestampsByMasterVideoId = async (
  masterVideoId: number,
  database: DbOrTx = db,
): Promise<number[]> =>
  (
    await database
      .select({ timestampMs: timelineThumbnail.timestampMs })
      .from(timelineThumbnail)
      .where(eq(timelineThumbnail.masterVideoId, masterVideoId))
  ).map((row) => row.timestampMs);

// Closed masters with no timeline rows: the boot scan's whole signal, so a
// crash mid-thumbnail simply re-runs on the next start. A master counts as
// closed once its end epoch is stamped, which the ingest close does.
export const listMasterVideoIdsMissingTimelineThumbnails = async (
  database: DbOrTx = db,
): Promise<number[]> =>
  (
    await database
      .select({ masterVideoId: masterVideo.masterVideoId })
      .from(masterVideo)
      .where(
        and(
          isNotNull(masterVideo.endEpoch),
          notExists(
            database
              .select({ present: sql`1` })
              .from(timelineThumbnail)
              .where(eq(timelineThumbnail.masterVideoId, masterVideo.masterVideoId)),
          ),
        ),
      )
      .orderBy(asc(masterVideo.masterVideoId))
  ).map((row) => row.masterVideoId);

export const createMasterVideoTimelineThumbnailRecords = async (
  data: (typeof timelineThumbnail.$inferInsert)[],
  database: DbOrTx = db,
) => {
  if (data.length === 0) {
    return [];
  }

  return database.insert(timelineThumbnail).values(data).returning();
};

// Card face for a master list: the earliest still per master, one batched
// query. The key column holds the object key the thumbnail job wrote.
export const listFirstTimelineThumbnailKeysByMasterVideoIds = async (
  masterVideoIdList: number[],
  database: DbOrTx = db,
): Promise<Map<number, string>> => {
  const keysByMasterVideoId = new Map<number, string>();

  if (masterVideoIdList.length === 0) {
    return keysByMasterVideoId;
  }

  const rows = await database
    .select({
      masterVideoId: timelineThumbnail.masterVideoId,
      storageStem: timelineThumbnail.storageStem,
      timestampMs: timelineThumbnail.timestampMs,
    })
    .from(timelineThumbnail)
    .where(inArray(timelineThumbnail.masterVideoId, masterVideoIdList))
    .orderBy(asc(timelineThumbnail.masterVideoId), asc(timelineThumbnail.timestampMs));

  for (const row of rows) {
    // ordered by timestamp, so the first row per master wins
    if (!keysByMasterVideoId.has(row.masterVideoId)) {
      keysByMasterVideoId.set(row.masterVideoId, row.storageStem);
    }
  }

  return keysByMasterVideoId;
};

export const listMasterVideoTimelineThumbnailRecordsByMasterVideoId = async (
  masterVideoId: number,
  database: DbOrTx = db,
) =>
  database.query.timelineThumbnail.findMany({
    where: eq(timelineThumbnail.masterVideoId, masterVideoId),
    orderBy: asc(timelineThumbnail.timestampMs),
  });

export const deleteMasterVideoTimelineThumbnailRecordsByMasterVideoId = async (
  masterVideoId: number,
  database: DbOrTx = db,
) =>
  database
    .delete(timelineThumbnail)
    .where(eq(timelineThumbnail.masterVideoId, masterVideoId))
    .returning();
