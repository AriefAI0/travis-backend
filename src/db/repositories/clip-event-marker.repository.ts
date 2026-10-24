import { asc, inArray } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { clipEventMarker } from "../schema";

export type ClipEventMarkerInput = {
  clipId: number;
  positionMs: number;
};

// Insert one point row per click, duplicates included.
export const createClipEventMarkerRecords = async (
  data: ClipEventMarkerInput[],
  database: DbOrTx = db,
) => {
  if (data.length === 0) {
    return [];
  }

  return database.insert(clipEventMarker).values(data).returning();
};

// Read markers for a clip batch in timeline order.
export const listClipEventMarkerRecordsByClipIds = async (
  clipIds: number[],
  database: DbOrTx = db,
) => {
  if (clipIds.length === 0) {
    return [];
  }

  return database.query.clipEventMarker.findMany({
    where: inArray(clipEventMarker.clipId, clipIds),
    orderBy: [
      asc(clipEventMarker.clipId),
      asc(clipEventMarker.positionMs),
      asc(clipEventMarker.markerId),
    ],
  });
};
