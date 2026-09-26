import { db, type DbOrTx } from "../client";
import type { MasterVideoPlaybackData } from "../../types/api";
import { mintTimelineThumbnailUrl } from "./result-media.service";
import { and, asc, count, eq, sql } from "drizzle-orm";
import {
  findSessionById,
  findSessionWithOpenIngestBySessionId,
  listSessionRecordingRowsByProjectId,
  listSessionsWithOpenIngest,
  updateSessionById,
} from "../repositories/session.repository";
import {
  createTimelineThumbnailRecords,
  deleteTimelineThumbnailRecordsBySessionId,
  listFirstTimelineThumbnailKeysBySessionIds,
  listTimelineThumbnailRecordsBySessionId,
} from "../repositories/timeline-thumbnail.repository";
import {
  createVideoClipRecord,
  deleteVideoClipById,
  findVideoClipById,
  findVideoClipPlaybackRowById,
  listActiveVideoClipRecords,
  listVideoClipPlaybackRowsByResultIds,
  listVideoClipRecords,
  listVideoClipRecordsBySessionId,
  listVideoClipRecordsByResultId,
  updateVideoClipById,
  type VideoClipPlaybackRow,
} from "../repositories/video-clip.repository";
import {
  description,
  partCode,
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

export type CreateVideoClipInput = {
  resultId: number;
  sessionId: number;
  startOffsetMs: number;
  endOffsetMs?: number | null;
};

export type CreateTimelineThumbnailInput = {
  sessionId: number;
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
  sessionId: number;
  sessionStartEpoch: number | null;
  sessionEndEpoch: number | null;
  masterDurationMs: number | null;
  startOffsetMs: number;
  endOffsetMs: number | null;
  durationMs: number | null;
  startEpochMs: number;
  endEpochMs: number | null;
  // object key of the clip's card still; null until the still job has run
  thumbnailKey: string | null;
};

export type ProjectSessionRecording = {
  sessionId: number;
  sessionName: string | null;
  // per-project ordinal: what a recording card labels itself with
  sessionDisplayNumber: number;
  startEpoch: number | null;
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

const validateRecordingTimeRange = (
  startEpoch: number,
  endEpoch?: number | null,
) => {
  if (!Number.isInteger(startEpoch) || startEpoch < 0) {
    throw new Error("Recording startEpoch must be a non-negative integer");
  }

  if (endEpoch === undefined || endEpoch === null) {
    return;
  }

  if (!Number.isInteger(endEpoch) || endEpoch <= startEpoch) {
    throw new Error("Recording endEpoch must be greater than startEpoch");
  }
};

const normalizeRequiredText = (value: string, fieldName: string) => {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    throw new Error(`${fieldName} is required`);
  }

  return trimmedValue;
};

const getRecordingDurationMs = (
  row: Pick<typeof session.$inferSelect, "startEpoch" | "endEpoch">,
) => {
  if (row.endEpoch === null || row.startEpoch === null) {
    return null;
  }

  return (row.endEpoch - row.startEpoch) * 1000;
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

const validateTimelineThumbnail = (
  data: CreateTimelineThumbnailInput,
) => {
  if (!Number.isInteger(data.sessionId) || data.sessionId < 1) {
    throw new Error("Session id must be a positive integer");
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
    "sessionId" | "startOffsetMs" | "endOffsetMs"
  >,
  database?: DbOrTx,
) => {
  validateVideoClipOffsets(data.startOffsetMs, data.endOffsetMs);

  const sessionRow = await findSessionById(data.sessionId, database);

  if (!sessionRow) {
    throw new Error(`Session ${data.sessionId} does not exist`);
  }

  const durationMs = getRecordingDurationMs(sessionRow);

  if (
    data.endOffsetMs !== null &&
    data.endOffsetMs !== undefined &&
    durationMs !== null &&
    data.endOffsetMs > durationMs
  ) {
    throw new Error("Video clip endOffsetMs exceeds the session recording duration");
  }
};

// admission stamps the recording start on the session row (the session IS the master)
export const stampSessionRecordingStart = async (
  data: { sessionId: number; startEpoch: number },
  database?: DbOrTx,
) => {
  validateRecordingTimeRange(data.startEpoch);

  return updateSessionById(
    data.sessionId,
    { startEpoch: data.startEpoch, recordingUpdatedAt: new Date() },
    database,
  );
};

// the ingest close stamps the end anchor and final duration on the session row
export const stampSessionRecordingEnd = async (
  sessionId: number,
  data: { endEpoch: number; durationMs?: number | null },
  database?: DbOrTx,
) => {
  const sessionRow = await findSessionById(sessionId, database);
  if (!sessionRow) return null;

  validateRecordingTimeRange(sessionRow.startEpoch ?? 0, data.endEpoch);

  return updateSessionById(
    sessionId,
    {
      endEpoch: data.endEpoch,
      durationMs: data.durationMs ?? null,
      recordingUpdatedAt: new Date(),
    },
    database,
  );
};

export const listSessionRecordingsByProjectId = async (
  projectId: number,
  database?: DbOrTx,
): Promise<ProjectSessionRecording[]> => {
  if (!Number.isInteger(projectId) || projectId < 1) {
    throw new Error("Project id must be a positive integer");
  }

  const rows = await listSessionRecordingRowsByProjectId(projectId, database);
  const thumbnailKeys = await listFirstTimelineThumbnailKeysBySessionIds(
    rows.map((row) => row.sessionId),
    database,
  );

  // mint per row: the still is the card face, so the list read carries it
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      thumbnailUrl: await mintTimelineThumbnailUrl(
        thumbnailKeys.get(row.sessionId) ?? null,
      ),
    })),
  );
};

export const getSessionPlaybackData = async (
  projectId: number,
  sessionId: number,
  database?: DbOrTx,
): Promise<MasterVideoPlaybackData | null> => {
  if (!Number.isInteger(projectId) || projectId < 1) {
    throw new Error("Project id must be a positive integer");
  }

  if (!Number.isInteger(sessionId) || sessionId < 1) {
    throw new Error("Session id must be a positive integer");
  }

  const selectedSession = await (database ?? db)
    .select({
      sessionId: session.sessionId,
      sessionName: session.name,
      sessionDisplayNumber: session.displayNumber,
      startEpoch: session.startEpoch,
      endEpoch: session.endEpoch,
      durationMs: session.durationMs,
    })
    .from(session)
    .where(
      and(
        eq(session.sessionId, sessionId),
        eq(session.projectId, projectId),
      ),
    )
    .limit(1).then((rows) => rows[0] ?? null);

  if (!selectedSession) {
    return null;
  }

  // no recording-status gate: the bundle is a read, and playability comes from
  // the stored segments.

  const eventRows = await (database ?? db)
    .select({
      clipId: videoClip.clipId,
      resultId: result.resultId,
      inspectionTypeCode: result.inspectionTypeCode,
      // the target: the description label names it, the part code is the
      // sub-label when the target is a code
      itemLabel: sql<string>`coalesce(${description.label}, ${partCode.code}, '')`,
      assetName: sql<string>`coalesce(${description.label}, ${partCode.code}, '')`,
      componentName: sql<string>`coalesce(${partCode.code}, '')`,
      startOffsetMs: videoClip.startOffsetMs,
      endOffsetMs: videoClip.endOffsetMs,
      remarks: result.remarks,
      imageCount: count(resultImage.imageId),
      thumbnailKey: videoClip.thumbnailKey,
    })
    .from(videoClip)
    .innerJoin(result, eq(result.resultId, videoClip.resultId))
    .leftJoin(description, eq(description.descriptionId, result.descriptionId))
    .leftJoin(partCode, eq(partCode.partCodeId, result.partCodeId))
    .leftJoin(resultImage, eq(resultImage.resultId, result.resultId))
    .where(eq(videoClip.sessionId, sessionId))
    .groupBy(
      videoClip.clipId,
      result.resultId,
      result.inspectionTypeCode,
      description.label,
      partCode.code,
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

  const timelineThumbnails = await listTimelineThumbnailRecordsBySessionId(
    sessionId,
    database,
  );

  // The ingest is the status: open means the capture is still running, and its
  // duration is the only number that grows before close.
  const playableIngest = await findPlayableIngestRecord(
    { kind: "master", id: sessionId },
    database,
  );

  // Batched: one pair of queries for every clip in the events.
  const playableClipIds = await listPlayableClipIds(
    (eventRows as PlaybackEventRow[]).map((row) => row.clipId),
    database,
  );

  return {
    ...selectedSession,
    durationMs: selectedSession.durationMs ?? playableIngest?.durationMs ?? null,
    recordingStatus: playableIngest?.closedAt === null ? "recording" : "finalized",
    // presigned per read: the strip renders these directly
    thumbnails: await Promise.all(
      timelineThumbnails.map(async (thumbnail) => ({
        thumbnailId: thumbnail.thumbnailId,
        sessionId: thumbnail.sessionId,
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

export const replaceSessionTimelineThumbnails = async (
  sessionId: number,
  thumbnails: CreateTimelineThumbnailInput[],
  database?: DbOrTx,
) => {
  if (!Number.isInteger(sessionId) || sessionId < 1) {
    throw new Error("Session id must be a positive integer");
  }

  const sessionRow = await findSessionById(sessionId, database);

  if (!sessionRow) {
    throw new Error(`Session ${sessionId} does not exist`);
  }

  thumbnails.forEach(validateTimelineThumbnail);

  if (thumbnails.some((thumbnail) => thumbnail.sessionId !== sessionId)) {
    throw new Error("Thumbnail sessionId must match the target session");
  }

  // flow: delete old thumbnails > insert new set, one tx
  const run = async (tx: DbOrTx) => {
    await deleteTimelineThumbnailRecordsBySessionId(sessionId, tx);

    return createTimelineThumbnailRecords(
      thumbnails.map((thumbnail) => ({
        sessionId,
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

export const createVideoClip = async (
  data: CreateVideoClipInput,
  database?: DbOrTx,
) => {
  await validateVideoClipRange(data, database);

  return createVideoClipRecord(
    {
      resultId: data.resultId,
      sessionId: data.sessionId,
      startOffsetMs: data.startOffsetMs,
      endOffsetMs: data.endOffsetMs ?? null,
      lastUpdatedAt: new Date(),
    },
    database,
  );
};

// open ingests are the whole signal: a session is unfinished while its master
// ingest row has not closed. The idle sweep closes them, so this drains alone.
export const listUnfinishedSessions = async (database?: DbOrTx) =>
  listSessionsWithOpenIngest(database);

// the master a session is capturing now; null when nothing is open
export const findRecordingMasterBySessionId = async (
  sessionId: number,
  database?: DbOrTx,
) => findSessionWithOpenIngestBySessionId(sessionId, database);

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
    masterDurationMs:
      playbackRow.sessionEndEpoch === null || playbackRow.sessionStartEpoch === null
        ? null
        : (playbackRow.sessionEndEpoch - playbackRow.sessionStartEpoch) * 1000,
    durationMs,
    startEpochMs: (playbackRow.sessionStartEpoch ?? 0) * 1000 + playbackRow.startOffsetMs,
    endEpochMs:
      playbackRow.endOffsetMs === null
        ? null
        : (playbackRow.sessionStartEpoch ?? 0) * 1000 + playbackRow.endOffsetMs,
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

export const listVideoClipsBySessionId = async (
  sessionId: number,
  database?: DbOrTx,
) => listVideoClipRecordsBySessionId(sessionId, database);

export const getVideoClipPlaybackById = async (
  clipId: number,
  database?: DbOrTx,
): Promise<VideoClipPlayback | null> => {
  const playbackRow = await findVideoClipPlaybackRowById(clipId, database);
  return playbackRow ? toVideoClipPlayback(playbackRow) : null;
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
      sessionId: data.sessionId ?? existingVideoClip.sessionId,
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
