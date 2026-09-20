import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { masterVideo, videoClip } from "../schema";

export type VideoClipPlaybackRow = {
  clipId: number;
  resultId: number;
  masterVideoId: number;
  masterVideoStartEpoch: number;
  masterVideoEndEpoch: number | null;
  startOffsetMs: number;
  endOffsetMs: number | null;
};

export const createVideoClipRecord = async (
  data: typeof videoClip.$inferInsert,
  database: DbOrTx = db,
) => {
  const createdVideoClips = await database
    .insert(videoClip)
    .values(data)
    .returning();

  return createdVideoClips[0] ?? null;
};

export const listVideoClipRecords = async (database: DbOrTx = db) =>
  database.query.videoClip.findMany({
    orderBy: asc(videoClip.clipId),
  });

export const findVideoClipById = async (
  clipId: number,
  database: DbOrTx = db,
) =>
  (await database.query.videoClip.findFirst({
    where: eq(videoClip.clipId, clipId),
  })) ?? null;

export const listVideoClipRecordsByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  database.query.videoClip.findMany({
    where: eq(videoClip.resultId, resultId),
    orderBy: asc(videoClip.startOffsetMs),
  });

export const findActiveVideoClipByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database.query.videoClip.findFirst({
    where: and(
      eq(videoClip.resultId, resultId),
      isNull(videoClip.endOffsetMs),
    ),
    orderBy: asc(videoClip.startOffsetMs),
  })) ?? null;

// open clips across all results (endOffsetMs null = open, regardless of status)
export const listActiveVideoClipRecords = async (database: DbOrTx = db) =>
  database.query.videoClip.findMany({
    where: isNull(videoClip.endOffsetMs),
    orderBy: asc(videoClip.startOffsetMs),
  });

export const listVideoClipRecordsByMasterVideoId = async (
  masterVideoId: number,
  database: DbOrTx = db,
) =>
  database.query.videoClip.findMany({
    where: eq(videoClip.masterVideoId, masterVideoId),
    orderBy: asc(videoClip.startOffsetMs),
  });

export const findVideoClipPlaybackRowById = async (
  clipId: number,
  database: DbOrTx = db,
): Promise<VideoClipPlaybackRow | null> =>
  (await database
    .select({
      clipId: videoClip.clipId,
      resultId: videoClip.resultId,
      masterVideoId: videoClip.masterVideoId,
      masterVideoStartEpoch: masterVideo.startEpoch,
      masterVideoEndEpoch: masterVideo.endEpoch,
      startOffsetMs: videoClip.startOffsetMs,
      endOffsetMs: videoClip.endOffsetMs,
    })
    .from(videoClip)
    .innerJoin(
      masterVideo,
      eq(masterVideo.masterVideoId, videoClip.masterVideoId),
    )
    .where(eq(videoClip.clipId, clipId))
    .limit(1))[0] ?? null;

/** Batched playback rows across many results (kills the sidebar N+1). */
export const listVideoClipPlaybackRowsByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<VideoClipPlaybackRow[]> => {
  if (resultIds.length === 0) {
    return [];
  }

  return database
    .select({
      clipId: videoClip.clipId,
      resultId: videoClip.resultId,
      masterVideoId: videoClip.masterVideoId,
      masterVideoStartEpoch: masterVideo.startEpoch,
      masterVideoEndEpoch: masterVideo.endEpoch,
      startOffsetMs: videoClip.startOffsetMs,
      endOffsetMs: videoClip.endOffsetMs,
    })
    .from(videoClip)
    .innerJoin(
      masterVideo,
      eq(masterVideo.masterVideoId, videoClip.masterVideoId),
    )
    .where(inArray(videoClip.resultId, resultIds))
    .orderBy(
      asc(videoClip.resultId),
      asc(videoClip.startOffsetMs),
      asc(videoClip.clipId),
    );
};

export const updateVideoClipById = async (
  clipId: number,
  data: Partial<typeof videoClip.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updatedVideoClips = await database
    .update(videoClip)
    .set(data)
    .where(eq(videoClip.clipId, clipId))
    .returning();

  return updatedVideoClips[0] ?? null;
};

export const deleteVideoClipById = async (
  clipId: number,
  database: DbOrTx = db,
) => {
  const deletedVideoClips = await database
    .delete(videoClip)
    .where(eq(videoClip.clipId, clipId))
    .returning();

  return deletedVideoClips[0] ?? null;
};
