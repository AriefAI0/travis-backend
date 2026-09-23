import { db, type DbOrTx } from "../client";
import type { MasterVideoPlaybackData } from "../../types/api";
import { mintTimelineThumbnailUrl } from "./result-media.service";
import { and, asc, count, eq, sql } from "drizzle-orm";
import {
  createMasterVideoRecord,
  deleteMasterVideoById,
  findMasterVideoById,
  findMasterVideoRecordWithOpenIngestBySessionId,
  listMasterVideoRecords,
  listMasterVideoRecordsByProjectId,
  listMasterVideoRecordsBySessionId,
  listMasterVideoRecordsWithOpenIngest,
  updateMasterVideoById,
} from "../repositories/master-video.repository";
import {
  createMasterVideoTimelineThumbnailRecords,
  deleteMasterVideoTimelineThumbnailRecordsByMasterVideoId,
  listFirstTimelineThumbnailKeysByMasterVideoIds,
  listMasterVideoTimelineThumbnailRecordsByMasterVideoId,
} from "../repositories/timeline-thumbnail.repository";
import {
  createVideoClipRecord,
  deleteVideoClipById,
  findVideoClipById,
  findVideoClipPlaybackRowById,
  listActiveVideoClipRecords,
  listVideoClipPlaybackRowsByResultIds,
  listVideoClipRecords,
  listVideoClipRecordsByMasterVideoId,
  listVideoClipRecordsByResultId,
  updateVideoClipById,
  type VideoClipPlaybackRow,
} from "../repositories/video-clip.repository";
import {
  componentCode,
  mainComponent,
  masterVideo,
  result,
  resultImage,
  session,
  videoClip,
} from "../schema";
import { listResultImageSummariesByResultIds } from "./result-media.service";
import {
  listPlayableClipIds,
  playbackUrl,
} from "./recording-playback.service";
import { findPlayableIngestRecord } from "../repositories/recording-ingest.repository";

export type CreateMasterVideoInput = {
  sessionId: number;
  startEpoch: number;
  endEpoch?: number | null;
};

export type CreateVideoClipInput = {
  resultId: number;
  masterVideoId: number;
  startOffsetMs: number;
  endOffsetMs?: number | null;
};

export type CreateMasterVideoTimelineThumbnailInput = {
  masterVideoId: number;
  timestampMs: number;
  width: number;
  height: number;
  sizeBytes: number;
  // required: keys derive from the stem alone (no URL column remains)
  storageStem: string;
};

export type VideoClipPlayback = {
  clipId: number;
  resultId: number;
  masterVideoId: number;
  masterVideoStartEpoch: number;
  masterVideoEndEpoch: number | null;
  masterVideoDurationMs: number | null;
  startOffsetMs: number;
  endOffsetMs: number | null;
  durationMs: number | null;
  startEpochMs: number;
  endEpochMs: number | null;
  // object key of the clip's card still; null until the still job has run
  thumbnailKey: string | null;
};

export type ProjectMasterVideo = {
  masterVideoId: number;
  sessionId: number;
  sessionName: string | null;
  // per-project ordinal: what a recording card labels itself with
  sessionDisplayNumber: number | null;
  startEpoch: number;
  endEpoch: number | null;
  durationMs: number | null;
  // presigned card still from the timeline job; null until it has run
  thumbnailUrl: string | null;
};

type PlaybackEventRow = {
  clipId: number;
  resultId: number;
  inspectionTypeCode: "GVI" | "CVI" | "MGI" | "CP" | "FMD" | "SCOUR";
  itemLabel: string;
  assetName: string;
  componentName: string;
  startOffsetMs: number;
  endOffsetMs: number | null;
  remarks: string | null;
  imageCount: number;
  thumbnailKey: string | null;
};

const validateMasterVideoTimeRange = (
  startEpoch: number,
  endEpoch?: number | null,
) => {
  if (!Number.isInteger(startEpoch) || startEpoch < 0) {
    throw new Error("Master video startEpoch must be a non-negative integer");
  }

  if (endEpoch === undefined || endEpoch === null) {
    return;
  }

  if (!Number.isInteger(endEpoch) || endEpoch <= startEpoch) {
    throw new Error("Master video endEpoch must be greater than startEpoch");
  }
};

const normalizeRequiredText = (value: string, fieldName: string) => {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    throw new Error(`${fieldName} is required`);
  }

  return trimmedValue;
};

const normalizeMasterVideoUpdate = (
  data: Partial<typeof masterVideo.$inferInsert>,
): Partial<typeof masterVideo.$inferInsert> => {
  const nextData: Partial<typeof masterVideo.$inferInsert> = {};

  if ("sessionId" in data) {
    nextData.sessionId = data.sessionId;
  }

  if ("startEpoch" in data) {
    nextData.startEpoch = data.startEpoch;
  }

  if ("endEpoch" in data) {
    nextData.endEpoch = data.endEpoch;
  }

  if ("durationMs" in data) {
    nextData.durationMs = data.durationMs;
  }

  nextData.lastUpdatedAt = new Date();

  return nextData;
};

const getMasterVideoDurationMs = (
  video: typeof masterVideo.$inferSelect,
) => {
  if (video.endEpoch === null) {
    return null;
  }

  return (video.endEpoch - video.startEpoch) * 1000;
};

const validateVideoClipOffsets = (
  startOffsetMs: number,
  endOffsetMs?: number | null,
) => {
  if (!Number.isInteger(startOffsetMs) || startOffsetMs < 0) {
    throw new Error("Video clip startOffsetMs must be a non-negative integer");
  }

  if (endOffsetMs === undefined || endOffsetMs === null) {
    return;
  }

  if (!Number.isInteger(endOffsetMs) || endOffsetMs <= startOffsetMs) {
    throw new Error("Video clip endOffsetMs must be greater than startOffsetMs");
  }
};

const validateMasterVideoTimelineThumbnail = (
  data: CreateMasterVideoTimelineThumbnailInput,
) => {
  if (!Number.isInteger(data.masterVideoId) || data.masterVideoId < 1) {
    throw new Error("Master video id must be a positive integer");
  }

  if (!Number.isInteger(data.timestampMs) || data.timestampMs < 0) {
    throw new Error("Thumbnail timestampMs must be a non-negative integer");
  }

  if (!Number.isInteger(data.width) || data.width < 1) {
    throw new Error("Thumbnail width must be a positive integer");
  }

  if (!Number.isInteger(data.height) || data.height < 1) {
    throw new Error("Thumbnail height must be a positive integer");
  }

  if (!Number.isInteger(data.sizeBytes) || data.sizeBytes < 0) {
    throw new Error("Thumbnail sizeBytes must be a non-negative integer");
  }

  if (!data.storageStem.trim()) {
    throw new Error("Thumbnail storage stem is required");
  }
};

const validateVideoClipRange = async (
  data: Pick<
    typeof videoClip.$inferInsert,
    "masterVideoId" | "startOffsetMs" | "endOffsetMs"
  >,
  database?: DbOrTx,
) => {
  validateVideoClipOffsets(data.startOffsetMs, data.endOffsetMs);

  const selectedMasterVideo = await findMasterVideoById(
    data.masterVideoId,
    database,
  );

  if (!selectedMasterVideo) {
    throw new Error(`Master video ${data.masterVideoId} does not exist`);
  }

  const masterVideoDurationMs = getMasterVideoDurationMs(selectedMasterVideo);

  if (
    data.endOffsetMs !== null &&
    data.endOffsetMs !== undefined &&
    masterVideoDurationMs !== null &&
    data.endOffsetMs > masterVideoDurationMs
  ) {
    throw new Error("Video clip endOffsetMs exceeds master video duration");
  }
};

export const createMasterVideo = async (
  data: CreateMasterVideoInput,
  database?: DbOrTx,
) => {
  validateMasterVideoTimeRange(data.startEpoch, data.endEpoch);

  return createMasterVideoRecord(
    {
      sessionId: data.sessionId,
      startEpoch: data.startEpoch,
      endEpoch: data.endEpoch ?? null,
      lastUpdatedAt: new Date(),
    },
    database,
  );
};

export const listMasterVideos = async (database?: DbOrTx) =>
  listMasterVideoRecords(database);

export const getMasterVideoById = async (
  masterVideoId: number,
  database?: DbOrTx,
) => findMasterVideoById(masterVideoId, database);

export const listMasterVideosBySessionId = async (
  sessionId: number,
  database?: DbOrTx,
) => listMasterVideoRecordsBySessionId(sessionId, database);

export const listMasterVideosByProjectId = async (
  projectId: number,
  database?: DbOrTx,
): Promise<ProjectMasterVideo[]> => {
  if (!Number.isInteger(projectId) || projectId < 1) {
    throw new Error("Project id must be a positive integer");
  }

  const rows = await listMasterVideoRecordsByProjectId(projectId, database);
  const thumbnailKeys = await listFirstTimelineThumbnailKeysByMasterVideoIds(
    rows.map((row) => row.masterVideoId),
    database,
  );

  // mint per row: the still is the card face, so the list read carries it
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      thumbnailUrl: await mintTimelineThumbnailUrl(
        thumbnailKeys.get(row.masterVideoId) ?? null,
      ),
    })),
  );
};

export const getMasterVideoPlaybackData = async (
  projectId: number,
  masterVideoId: number,
  database?: DbOrTx,
): Promise<MasterVideoPlaybackData | null> => {
  if (!Number.isInteger(projectId) || projectId < 1) {
    throw new Error("Project id must be a positive integer");
  }

  if (!Number.isInteger(masterVideoId) || masterVideoId < 1) {
    throw new Error("Master video id must be a positive integer");
  }

  const selectedMasterVideo = await (database ?? db)
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
    .where(
      and(
        eq(masterVideo.masterVideoId, masterVideoId),
        eq(session.projectId, projectId),
      ),
    )
    .limit(1).then((rows) => rows[0] ?? null);

  if (!selectedMasterVideo) {
    return null;
  }

  const sessionMasterVideos = await listMasterVideoRecordsBySessionId(
    selectedMasterVideo.sessionId,
    database,
  );

  // no recording-status gate: the bundle is a read, and playability comes from
  // the stored segments.

  const eventRows = await (database ?? db)
    .select({
      clipId: videoClip.clipId,
      resultId: result.resultId,
      inspectionTypeCode: result.inspectionTypeCode,
      // the v2 target replaces the item chain: the main component description
      // names it, and the component code is the sub-label when the target is a code
      itemLabel: sql<string>`coalesce(${mainComponent.description}, ${componentCode.code}, '')`,
      assetName: sql<string>`coalesce(${mainComponent.description}, ${componentCode.code}, '')`,
      componentName: sql<string>`coalesce(${componentCode.code}, '')`,
      startOffsetMs: videoClip.startOffsetMs,
      endOffsetMs: videoClip.endOffsetMs,
      remarks: result.remarks,
      imageCount: count(resultImage.imageId),
      thumbnailKey: videoClip.thumbnailKey,
    })
    .from(videoClip)
    .innerJoin(result, eq(result.resultId, videoClip.resultId))
    .leftJoin(mainComponent, eq(mainComponent.mainComponentId, result.mainComponentId))
    .leftJoin(componentCode, eq(componentCode.componentCodeId, result.componentCodeId))
    .leftJoin(resultImage, eq(resultImage.resultId, result.resultId))
    .where(eq(videoClip.masterVideoId, masterVideoId))
    .groupBy(
      videoClip.clipId,
      result.resultId,
      result.inspectionTypeCode,
      mainComponent.description,
      componentCode.code,
      videoClip.startOffsetMs,
      videoClip.endOffsetMs,
      result.remarks,
      videoClip.thumbnailKey,
    )
    .orderBy(asc(videoClip.startOffsetMs), asc(videoClip.clipId));

  // Batched: one image-summary query across all distinct resultIds in the events
  // (the previous version issued one query per distinct resultId).
  const eventResultIds = [
    ...new Set((eventRows as PlaybackEventRow[]).map((row) => row.resultId)),
  ];
  const imagesByResultId =
    await listResultImageSummariesByResultIds(eventResultIds, database);

  const timelineThumbnails =
    await listMasterVideoTimelineThumbnailRecordsByMasterVideoId(
      masterVideoId,
      database,
    );

  // The ingest is the status: open means the capture is still running, and its
  // duration is the only number that grows before close.
  const playableIngest = await findPlayableIngestRecord(
    { kind: "master", id: masterVideoId },
    database,
  );

  // Batched: one pair of queries for every clip in the events.
  const playableClipIds = await listPlayableClipIds(
    (eventRows as PlaybackEventRow[]).map((row) => row.clipId),
    database,
  );

  return {
    ...selectedMasterVideo,
    durationMs: selectedMasterVideo.durationMs ?? playableIngest?.durationMs ?? null,
    recordingStatus: playableIngest?.closedAt === null ? "recording" : "finalized",
    sessionRecordings: [...sessionMasterVideos]
      // copy first: sort mutates in place
      .sort((firstSource, secondSource) =>
        firstSource.startEpoch === secondSource.startEpoch
          ? firstSource.masterVideoId - secondSource.masterVideoId
          : firstSource.startEpoch - secondSource.startEpoch
      )
      .map((sourceVideo) => ({
        masterVideoId: sourceVideo.masterVideoId,
        startEpoch: sourceVideo.startEpoch,
        endEpoch: sourceVideo.endEpoch,
        durationMs: sourceVideo.durationMs,
      })),
    // presigned per read: the strip renders these directly
    thumbnails: await Promise.all(
      timelineThumbnails.map(async (thumbnail) => ({
        thumbnailId: thumbnail.thumbnailId,
        masterVideoId: thumbnail.masterVideoId,
        timestampMs: thumbnail.timestampMs,
        storageStem: thumbnail.storageStem,
        width: thumbnail.width,
        height: thumbnail.height,
        sizeBytes: thumbnail.sizeBytes,
        url: await mintTimelineThumbnailUrl(thumbnail.storageStem),
      })),
    ),
    events: await Promise.all(
      (eventRows as PlaybackEventRow[]).map(async (eventRow) => ({
        eventId: `clip-${eventRow.clipId}`,
        resultId: eventRow.resultId,
        clipId: eventRow.clipId,
        inspectionTypeCode: eventRow.inspectionTypeCode,
        itemLabel: eventRow.itemLabel,
        assetName: eventRow.assetName,
        componentName: eventRow.componentName,
        startOffsetMs: eventRow.startOffsetMs,
        endOffsetMs: eventRow.endOffsetMs,
        remarks: eventRow.remarks,
        images: imagesByResultId.get(eventRow.resultId) ?? [],
        imageCount: eventRow.imageCount,
        videoUrl: playableClipIds.has(eventRow.clipId)
          ? playbackUrl({ kind: "clip", id: eventRow.clipId })
          : null,
        // the clip's own still once its job has run; null until then
        thumbnailUrl: await mintTimelineThumbnailUrl(eventRow.thumbnailKey),
      })),
    ),
  };
};

export const replaceMasterVideoTimelineThumbnails = async (
  masterVideoId: number,
  thumbnails: CreateMasterVideoTimelineThumbnailInput[],
  database?: DbOrTx,
) => {
  if (!Number.isInteger(masterVideoId) || masterVideoId < 1) {
    throw new Error("Master video id must be a positive integer");
  }

  const selectedMasterVideo = await findMasterVideoById(masterVideoId, database);

  if (!selectedMasterVideo) {
    throw new Error(`Master video ${masterVideoId} does not exist`);
  }

  thumbnails.forEach(validateMasterVideoTimelineThumbnail);

  if (thumbnails.some((thumbnail) => thumbnail.masterVideoId !== masterVideoId)) {
    throw new Error("Thumbnail masterVideoId must match target master video");
  }

  // flow: delete old thumbnails > insert new set, one tx
  const run = async (tx: DbOrTx) => {
    await deleteMasterVideoTimelineThumbnailRecordsByMasterVideoId(
      masterVideoId,
      tx,
    );

    return createMasterVideoTimelineThumbnailRecords(
      thumbnails.map((thumbnail) => ({
        masterVideoId,
        timestampMs: thumbnail.timestampMs,
        width: thumbnail.width,
        height: thumbnail.height,
        sizeBytes: thumbnail.sizeBytes,
        storageStem: normalizeRequiredText(
          thumbnail.storageStem,
          "Timeline thumbnail storage stem",
        ),
      })),
      tx,
    );
  };

  return database ? run(database) : db.transaction(run);
};

export const updateMasterVideo = async (
  masterVideoId: number,
  data: Partial<typeof masterVideo.$inferInsert>,
  database?: DbOrTx,
) => {
  const existingMasterVideo = await findMasterVideoById(masterVideoId, database);

  if (!existingMasterVideo) {
    return null;
  }

  validateMasterVideoTimeRange(
    data.startEpoch ?? existingMasterVideo.startEpoch,
    data.endEpoch === undefined ? existingMasterVideo.endEpoch : data.endEpoch,
  );

  return updateMasterVideoById(
    masterVideoId,
    normalizeMasterVideoUpdate(data),
    database,
  );
};

export const deleteMasterVideo = async (
  masterVideoId: number,
  database?: DbOrTx,
) => deleteMasterVideoById(masterVideoId, database);

export const createVideoClip = async (
  data: CreateVideoClipInput,
  database?: DbOrTx,
) => {
  await validateVideoClipRange(data, database);

  return createVideoClipRecord(
    {
      resultId: data.resultId,
      masterVideoId: data.masterVideoId,
      startOffsetMs: data.startOffsetMs,
      endOffsetMs: data.endOffsetMs ?? null,
      lastUpdatedAt: new Date(),
    },
    database,
  );
};

// open ingests are the whole signal: a master is unfinished while its ingest
// row has not closed. The idle sweep closes them, so this drains on its own.
export const listUnfinishedMasterVideos = async (database?: DbOrTx) =>
  listMasterVideoRecordsWithOpenIngest(database);

// the master a session is capturing now; null when nothing is open
export const findRecordingMasterBySessionId = async (
  sessionId: number,
  database?: DbOrTx,
) => findMasterVideoRecordWithOpenIngestBySessionId(sessionId, database);

export const listVideoClips = async (database?: DbOrTx) =>
  listVideoClipRecords(database);

export const getVideoClipById = async (clipId: number, database?: DbOrTx) =>
  findVideoClipById(clipId, database);

export const listVideoClipsByResultId = async (
  resultId: number,
  database?: DbOrTx,
) => listVideoClipRecordsByResultId(resultId, database);

const toVideoClipPlayback = (playbackRow: VideoClipPlaybackRow): VideoClipPlayback => {
  const durationMs =
    playbackRow.endOffsetMs === null
      ? null
      : playbackRow.endOffsetMs - playbackRow.startOffsetMs;

  return {
    ...playbackRow,
    masterVideoDurationMs:
      playbackRow.masterVideoEndEpoch === null
        ? null
        : (playbackRow.masterVideoEndEpoch - playbackRow.masterVideoStartEpoch) * 1000,
    durationMs,
    startEpochMs: (playbackRow.masterVideoStartEpoch ?? 0) * 1000 + playbackRow.startOffsetMs,
    endEpochMs:
      playbackRow.endOffsetMs === null
        ? null
        : (playbackRow.masterVideoStartEpoch ?? 0) * 1000 + playbackRow.endOffsetMs,
  };
};

/**
 * Batched clip-playback fetch across many results, returned as a Map keyed by
 * resultId so the sidebar assembles per-result clip lists from a single query.
 */
export const listVideoClipPlaybackByResultIds = async (
  resultIds: number[],
  database?: DbOrTx,
): Promise<Map<number, VideoClipPlayback[]>> => {
  const clipsByResultId = new Map<number, VideoClipPlayback[]>();

  if (resultIds.length === 0) {
    return clipsByResultId;
  }

  const playbackRows = await listVideoClipPlaybackRowsByResultIds(
    resultIds,
    database,
  );

  for (const playbackRow of playbackRows) {
    const bucket = clipsByResultId.get(playbackRow.resultId) ?? [];
    bucket.push(toVideoClipPlayback(playbackRow));
    clipsByResultId.set(playbackRow.resultId, bucket);
  }

  return clipsByResultId;
};

export const listVideoClipsByMasterVideoId = async (
  masterVideoId: number,
  database?: DbOrTx,
) => listVideoClipRecordsByMasterVideoId(masterVideoId, database);

export const getVideoClipPlaybackById = async (
  clipId: number,
  database?: DbOrTx,
): Promise<VideoClipPlayback | null> => {
  const playbackRow = await findVideoClipPlaybackRowById(clipId, database);

  if (!playbackRow) {
    return null;
  }

  const durationMs =
    playbackRow.endOffsetMs === null
      ? null
      : playbackRow.endOffsetMs - playbackRow.startOffsetMs;

  return {
    ...playbackRow,
    masterVideoDurationMs:
      playbackRow.masterVideoEndEpoch === null
        ? null
        : (playbackRow.masterVideoEndEpoch -
            playbackRow.masterVideoStartEpoch) *
          1000,
    durationMs,
    startEpochMs:
      playbackRow.masterVideoStartEpoch * 1000 + playbackRow.startOffsetMs,
    endEpochMs:
      playbackRow.endOffsetMs === null
        ? null
        : playbackRow.masterVideoStartEpoch * 1000 + playbackRow.endOffsetMs,
  };
};

export const updateVideoClip = async (
  clipId: number,
  data: Partial<typeof videoClip.$inferInsert>,
  database?: DbOrTx,
) => {
  const existingVideoClip = await findVideoClipById(clipId, database);

  if (!existingVideoClip) {
    return null;
  }

  await validateVideoClipRange(
    {
      masterVideoId: data.masterVideoId ?? existingVideoClip.masterVideoId,
      startOffsetMs: data.startOffsetMs ?? existingVideoClip.startOffsetMs,
      endOffsetMs:
        data.endOffsetMs === undefined
          ? existingVideoClip.endOffsetMs
          : data.endOffsetMs,
    },
    database,
  );

  return updateVideoClipById(
    clipId,
    {
      ...data,
      lastUpdatedAt: new Date(),
    },
    database,
  );
};

// open clips only: the ingest close stamps endOffsetMs, which is the whole
// close signal in the direct protocol.
export const listActiveVideoClips = async (database?: DbOrTx) =>
  listActiveVideoClipRecords(database);

export const deleteVideoClip = async (clipId: number, database?: DbOrTx) =>
  deleteVideoClipById(clipId, database);
