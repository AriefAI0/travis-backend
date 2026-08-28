import { asc, eq } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { timelineThumbnail } from "../schema";

export const createMasterVideoTimelineThumbnailRecords = async (
  data: (typeof timelineThumbnail.$inferInsert)[],
  database: DbOrTx = db,
) => {
  if (data.length === 0) {
    return [];
  }

  return database.insert(timelineThumbnail).values(data).returning();
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
