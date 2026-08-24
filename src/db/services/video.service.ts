import { db, type DbOrTx } from "../client";
import type { MasterVideoPlaybackData } from "../../types/api";
import { and, asc, count, eq } from "drizzle-orm";
import {
  createMasterVideoRecord,
  deleteMasterVideoById,
  findMasterVideoById,
  listMasterVideoRecords,
  listMasterVideoRecordsByProjectIdAndStatuses,
  listMasterVideoRecordsByProjectId,
  listMasterVideoRecordsBySessionId,
  listMasterVideoRecordsByStatuses,
  updateMasterVideoById,
} from "../repositories/master-video.repository";
import {
  createMasterVideoTimelineThumbnailRecords,
  deleteMasterVideoTimelineThumbnailRecordsByMasterVideoId,
  listMasterVideoTimelineThumbnailRecordsByMasterVideoId,
} from "../repositories/timeline-thumbnail.repository";
import {
  createVideoClipRecord,
  deleteVideoClipById,
  findVideoClipById,
  findVideoClipPlaybackRowById,
  listActiveVideoClipRecords,
  listVideoClipPlaybackRowsByResultId,
  listVideoClipPlaybackRowsByResultIds,
  listVideoClipRecords,
  listVideoClipRecordsByMasterVideoId,
  listVideoClipRecordsByResultId,
  listVideoClipRecordsByStatuses,
  updateVideoClipById,
  type VideoClipPlaybackRow,
} from "../repositories/video-clip.repository";
import {
  asset,
  component,
  item,
  masterVideo,
  result,
  resultImage,
  session,
  sessionItem,
  videoClip,
} from "../schema";
import { listResultImageSummariesByResultIds } from "./result-media.service";

export type CreateMasterVideoInput = {
  sessionId: number;
  fileUrl: string;
  thumbnailUrl?: string | null;
  // path prefix without bucket/extension; written by the ingest create path
  storageStem?: string | null;
  startEpoch: number;
  endEpoch?: number | null;
  recordingStatus?: RecordingPersistenceStatus;
  sourceKind?: string | null;
  inputId?: string | null;
  sourceIndex?: number;
  isPrimary?: boolean;
  sourceName?: string | null;
  startedAt?: Date | null;
};

export type CreateVideoClipInput = {
  resultId: number;
  masterVideoId: number;
  startOffsetMs: number;
  endOffsetMs?: number | null;
  clipFileUrl?: string | null;
  thumbnailUrl?: string | null;
  storageStem?: string | null;
  recordingStatus?: RecordingPersistenceStatus;
};

export type CreateMasterVideoTimelineThumbnailInput = {
  masterVideoId: number;
  timestampMs: number;
  imagePath: string;
  width: number;
  height: number;
  sizeBytes: number;
  // path prefix without bucket/extension; written by the ingest finalize bridge
  storageStem?: string | null;
};

export type CompleteVideoClipInput = {
  endOffsetMs: number;
  clipFileUrl?: string | null;
  thumbnailUrl?: string | null;
};

export type VideoClipPlayback = {
  clipId: number;
  resultId: number;
  masterVideoId: number;
  sourceIndex: number;
  sourceName: string | null;
  isPrimary: boolean;
  fileUrl: string;
  masterVideoStartEpoch: number;
  masterVideoEndEpoch: number | null;
  masterVideoDurationMs: number | null;
  startOffsetMs: number;
  endOffsetMs: number | null;
  clipFileUrl: string | null;
  thumbnailUrl: string | null;
  durationMs: number | null;
  startEpochMs: number;
  endEpochMs: number | null;
};

export type ProjectMasterVideo = {
  masterVideoId: number;
  sessionId: number;
  sessionName: string | null;
  fileUrl: string;
  fileName: string;
  thumbnailUrl: string | null;
  startEpoch: number;
  endEpoch: number | null;
  recordingStatus: RecordingPersistenceStatus;
  sourceIndex: number;
  isPrimary: boolean;
  sourceName: string | null;
  recoveryStatus: RecordingRecoveryStatus | null;
  fileSize: number | null;
  durationMs: number | null;
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
  clipFileUrl: string | null;
  thumbnailUrl: string | null;
  imageCount: number;
};

export const RECORDING_PERSISTENCE_STATUS = {
  recording: "recording",
  finalized: "finalized",
  interrupted: "interrupted",
  finalizationFailed: "finalization_failed",
  canceled: "canceled",
} as const;

export const RECORDING_RECOVERY_STATUS = {
  recoverable: "recoverable",
  missingFile: "missing_file",
  unusable: "unusable",
} as const;

export type RecordingPersistenceStatus =
  (typeof RECORDING_PERSISTENCE_STATUS)[keyof typeof RECORDING_PERSISTENCE_STATUS];

export type RecordingRecoveryStatus =
  (typeof RECORDING_RECOVERY_STATUS)[keyof typeof RECORDING_RECOVERY_STATUS];

const recordingPersistenceStatuses = new Set<string>(
  Object.values(RECORDING_PERSISTENCE_STATUS),
);

const recordingRecoveryStatuses = new Set<string>(
  Object.values(RECORDING_RECOVERY_STATUS),
);

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

const normalizeOptionalText = (
  value: string | null | undefined,
  _fieldName?: string,
) => {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmedValue = value.trim();

  return trimmedValue ? trimmedValue : null;
};

const normalizeRecordingPersistenceStatus = (
  value: string,
  fieldName: string,
): RecordingPersistenceStatus => {
  if (!recordingPersistenceStatuses.has(value)) {
    throw new Error(`${fieldName} is invalid`);
  }

  return value as RecordingPersistenceStatus;
};

const normalizeRecordingRecoveryStatus = (
  value: string | null | undefined,
  fieldName: string,
): RecordingRecoveryStatus | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (!recordingRecoveryStatuses.has(value)) {
    throw new Error(`${fieldName} is invalid`);
  }

  return value as RecordingRecoveryStatus;
};

const normalizeMasterVideoUpdate = (
  data: Partial<typeof masterVideo.$inferInsert>,
): Partial<typeof masterVideo.$inferInsert> => {
  const nextData: Partial<typeof masterVideo.$inferInsert> = {};

  if ("sessionId" in data) {
    nextData.sessionId = data.sessionId;
  }

  if ("fileUrl" in data) {
    if (data.fileUrl === undefined) {
      throw new Error("Master video fileUrl is required");
    }

    nextData.fileUrl = normalizeRequiredText(data.fileUrl, "Master video fileUrl");
  }

  if ("thumbnailUrl" in data) {
    nextData.thumbnailUrl = normalizeOptionalText(
      data.thumbnailUrl,
      "Master video thumbnailUrl",
    );
  }

  if ("storageStem" in data) {
    nextData.storageStem = normalizeOptionalText(
      data.storageStem,
      "Master video storage stem",
    );
  }

  if ("startEpoch" in data) {
    nextData.startEpoch = data.startEpoch;
  }

  if ("endEpoch" in data) {
    nextData.endEpoch = data.endEpoch;
  }

  if ("recordingStatus" in data) {
    if (data.recordingStatus === undefined) {
      throw new Error("Master video recording status is required");
    }

    nextData.recordingStatus = normalizeRecordingPersistenceStatus(
      data.recordingStatus,
      "Master video recording status",
    );
  }

  if ("sourceKind" in data) {
    nextData.sourceKind = normalizeOptionalText(
      data.sourceKind,
      "Master video source kind",
    );
  }

  if ("inputId" in data) {
    nextData.inputId = normalizeOptionalText(
      data.inputId,
      "Master video input id",
    );
  }

  if ("sourceIndex" in data) {
    nextData.sourceIndex = data.sourceIndex;
  }

  if ("isPrimary" in data) {
    nextData.isPrimary = data.isPrimary;
  }

  if ("sourceName" in data) {
    nextData.sourceName = normalizeOptionalText(
      data.sourceName,
      "Master video source name",
    );
  }

  if ("startedAt" in data) {
    nextData.startedAt = data.startedAt;
  }

  if ("stoppedAt" in data) {
    nextData.stoppedAt = data.stoppedAt;
  }

  if ("durationMs" in data) {
    nextData.durationMs = data.durationMs;
  }

  if ("fileSize" in data) {
    nextData.fileSize = data.fileSize;
  }

  if ("recoveryStatus" in data) {
    nextData.recoveryStatus = normalizeRecordingRecoveryStatus(
      data.recoveryStatus,
      "Master video recovery status",
    );
  }

  if ("finalizationError" in data) {
    nextData.finalizationError = normalizeOptionalText(
      data.finalizationError,
      "Master video finalization error",
    );
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
};

const normalizeSourceIndex = (sourceIndex: number | undefined): number => {
  if (sourceIndex === undefined) {
    return 1;
  }

  // zero allowed: one composited stream is written as source_index 0 (spec)
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) {
    throw new Error("Master video sourceIndex must be a non-negative integer");
  }

  return sourceIndex;
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
      fileUrl: normalizeRequiredText(data.fileUrl, "Master video fileUrl"),
      thumbnailUrl: normalizeOptionalText(
        data.thumbnailUrl,
        "Master video thumbnailUrl",
      ),
      storageStem: normalizeOptionalText(
        data.storageStem,
        "Master video storage stem",
      ),
      startEpoch: data.startEpoch,
      endEpoch: data.endEpoch ?? null,
      recordingStatus: data.recordingStatus ?? RECORDING_PERSISTENCE_STATUS.finalized,
      sourceKind: normalizeOptionalText(data.sourceKind, "Master video source kind"),
      inputId: normalizeOptionalText(data.inputId, "Master video input id"),
      sourceIndex: normalizeSourceIndex(data.sourceIndex),
      isPrimary: data.isPrimary ?? false,
      sourceName: normalizeOptionalText(data.sourceName, "Master video source name"),
      startedAt: data.startedAt ?? null,
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

  return rows.map((row) => ({
    ...row,
    fileName: row.fileUrl.split(/[\\/]/).pop() ?? row.fileUrl,
    recordingStatus: normalizeRecordingPersistenceStatus(
      row.recordingStatus,
      "Master video recording status",
    ),
    recoveryStatus: normalizeRecordingRecoveryStatus(
      row.recoveryStatus,
      "Master video recovery status",
    ),
  }));
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
      fileUrl: masterVideo.fileUrl,
      thumbnailUrl: masterVideo.thumbnailUrl,
      startEpoch: masterVideo.startEpoch,
      endEpoch: masterVideo.endEpoch,
      durationMs: masterVideo.durationMs,
      recordingStatus: masterVideo.recordingStatus,
      sourceIndex: masterVideo.sourceIndex,
      isPrimary: masterVideo.isPrimary,
      sourceName: masterVideo.sourceName,
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

  const normalizedRecordingStatus = normalizeRecordingPersistenceStatus(
    selectedMasterVideo.recordingStatus,
    "Master video recording status",
  );
  const sessionMasterVideos = await listMasterVideoRecordsBySessionId(
    selectedMasterVideo.sessionId,
    database,
  );

  if (normalizedRecordingStatus !== RECORDING_PERSISTENCE_STATUS.finalized) {
    throw new Error("Only finalized master videos can be opened for playback");
  }

  const eventRows = await (database ?? db)
    .select({
      clipId: videoClip.clipId,
      resultId: result.resultId,
      inspectionTypeCode: result.inspectionTypeCode,
      itemLabel: item.itemLabel,
      assetName: asset.name,
      componentName: component.name,
      startOffsetMs: videoClip.startOffsetMs,
      endOffsetMs: videoClip.endOffsetMs,
      remarks: result.remarks,
      clipFileUrl: videoClip.clipFileUrl,
      thumbnailUrl: videoClip.thumbnailUrl,
      imageCount: count(resultImage.imageId),
    })
    .from(videoClip)
    .innerJoin(result, eq(result.resultId, videoClip.resultId))
    .innerJoin(sessionItem, eq(sessionItem.sessionItemId, result.sessionItemId))
    .innerJoin(item, eq(item.itemId, sessionItem.itemId))
    .innerJoin(component, eq(component.componentId, item.componentId))
    .innerJoin(asset, eq(asset.assetId, component.assetId))
    .leftJoin(resultImage, eq(resultImage.resultId, result.resultId))
    .where(eq(videoClip.masterVideoId, masterVideoId))
    .groupBy(
      videoClip.clipId,
      result.resultId,
      result.inspectionTypeCode,
      item.itemLabel,
      asset.name,
      component.name,
      videoClip.startOffsetMs,
      videoClip.endOffsetMs,
      result.remarks,
      videoClip.clipFileUrl,
      videoClip.thumbnailUrl,
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

  return {
    ...selectedMasterVideo,
    fileName: selectedMasterVideo.fileUrl.split(/[\\/]/).pop() ?? selectedMasterVideo.fileUrl,
    recordingStatus: normalizedRecordingStatus,
    sourceVideos: sessionMasterVideos
      .map((sourceVideo) => ({
        masterVideoId: sourceVideo.masterVideoId,
        sourceIndex: sourceVideo.sourceIndex,
        isPrimary: sourceVideo.isPrimary,
        sourceName: sourceVideo.sourceName,
        fileName: sourceVideo.fileUrl.split(/[\\/]/).pop() ?? sourceVideo.fileUrl,
        fileUrl: sourceVideo.fileUrl,
        recordingStatus: normalizeRecordingPersistenceStatus(
          sourceVideo.recordingStatus,
          "Master video recording status",
        ),
      }))
      .sort((firstSource, secondSource) =>
        firstSource.sourceIndex === secondSource.sourceIndex
          ? firstSource.masterVideoId - secondSource.masterVideoId
          : firstSource.sourceIndex - secondSource.sourceIndex
      ),
    thumbnails: timelineThumbnails.map((thumbnail) => ({
      thumbnailId: thumbnail.thumbnailId,
      masterVideoId: thumbnail.masterVideoId,
      timestampMs: thumbnail.timestampMs,
      imagePath: thumbnail.imagePath,
      width: thumbnail.width,
      height: thumbnail.height,
      sizeBytes: thumbnail.sizeBytes,
    })),
    events: (eventRows as PlaybackEventRow[]).map((eventRow) => ({
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
      clipFileUrl: eventRow.clipFileUrl,
      thumbnailUrl: eventRow.thumbnailUrl,
      images: imagesByResultId.get(eventRow.resultId) ?? [],
      imageCount: eventRow.imageCount,
    })),
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
        imagePath: normalizeRequiredText(
          thumbnail.imagePath,
          "Thumbnail imagePath",
        ),
        width: thumbnail.width,
        height: thumbnail.height,
        sizeBytes: thumbnail.sizeBytes,
        storageStem: normalizeOptionalText(
          thumbnail.storageStem,
          "Timeline thumbnail storage stem",
        ),
      })),
      tx,
    );
  };

  return database ? run(database) : db.transaction(run);
};

export const listRecoverableMasterVideosByProjectId = async (
  projectId: number,
  database?: DbOrTx,
): Promise<ProjectMasterVideo[]> => {
  if (!Number.isInteger(projectId) || projectId < 1) {
    throw new Error("Project id must be a positive integer");
  }

  const rows = await listMasterVideoRecordsByProjectIdAndStatuses(
    projectId,
    [
      RECORDING_PERSISTENCE_STATUS.interrupted,
      RECORDING_PERSISTENCE_STATUS.finalizationFailed,
    ],
    database,
  );

  return rows.map((row) => ({
    ...row,
    fileName: row.fileUrl.split(/[\\/]/).pop() ?? row.fileUrl,
    recordingStatus: normalizeRecordingPersistenceStatus(
      row.recordingStatus,
      "Master video recording status",
    ),
    recoveryStatus: normalizeRecordingRecoveryStatus(
      row.recoveryStatus,
      "Master video recovery status",
    ),
  }));
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
      clipFileUrl: normalizeOptionalText(
        data.clipFileUrl,
        "Video clip fileUrl",
      ),
      thumbnailUrl: normalizeOptionalText(
        data.thumbnailUrl,
        "Video clip thumbnailUrl",
      ),
      storageStem: normalizeOptionalText(
        data.storageStem,
        "Video clip storage stem",
      ),
      recordingStatus:
        data.recordingStatus ?? RECORDING_PERSISTENCE_STATUS.finalized,
      lastUpdatedAt: new Date(),
    },
    database,
  );
};

export const listUnfinishedMasterVideos = async (database?: DbOrTx) =>
  listMasterVideoRecordsByStatuses(
    [
      RECORDING_PERSISTENCE_STATUS.recording,
      RECORDING_PERSISTENCE_STATUS.finalizationFailed,
    ],
    database,
  );

export const markMasterVideoFinalized = async (
  masterVideoId: number,
  data: {
    stoppedAt: Date;
    durationMs: number;
    // Null since the local master file was removed (TS segments are the master).
    fileSize: number | null;
    endEpoch: number;
  },
  database?: DbOrTx,
) =>
  updateMasterVideo(masterVideoId, {
    endEpoch: data.endEpoch,
    recordingStatus: RECORDING_PERSISTENCE_STATUS.finalized,
    stoppedAt: data.stoppedAt,
    durationMs: data.durationMs,
    fileSize: data.fileSize,
    recoveryStatus: null,
    finalizationError: null,
  }, database);

export const markMasterVideoFinalizationFailed = async (
  masterVideoId: number,
  error: string,
  database?: DbOrTx,
) =>
  updateMasterVideo(masterVideoId, {
    recordingStatus: RECORDING_PERSISTENCE_STATUS.finalizationFailed,
    finalizationError: normalizeRequiredText(error, "Finalization error"),
  }, database);

export const markMasterVideoInterrupted = async (
  masterVideoId: number,
  data: {
    recoveryStatus: RecordingRecoveryStatus;
    fileSize: number | null;
    error?: string | null;
  },
  database?: DbOrTx,
) =>
  updateMasterVideo(masterVideoId, {
    recordingStatus: RECORDING_PERSISTENCE_STATUS.interrupted,
    recoveryStatus: data.recoveryStatus,
    fileSize: data.fileSize,
    finalizationError: data.error ?? null,
  }, database);

export const startVideoClip = async (
  data: Omit<CreateVideoClipInput, "endOffsetMs" | "clipFileUrl" | "thumbnailUrl">,
  database?: DbOrTx,
) =>
  createVideoClip(
    {
      ...data,
      endOffsetMs: null,
      clipFileUrl: null,
      thumbnailUrl: null,
    },
    database,
  );

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

export const listVideoClipPlaybackByResultId = async (
  resultId: number,
  database?: DbOrTx,
): Promise<VideoClipPlayback[]> => {
  const playbackRows = await listVideoClipPlaybackRowsByResultId(resultId, database);
  return playbackRows.map(toVideoClipPlayback);
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
      clipFileUrl:
        "clipFileUrl" in data
          ? normalizeOptionalText(data.clipFileUrl, "Video clip fileUrl")
          : undefined,
      thumbnailUrl:
        "thumbnailUrl" in data
          ? normalizeOptionalText(data.thumbnailUrl, "Video clip thumbnailUrl")
          : undefined,
      recordingStatus:
        "recordingStatus" in data && data.recordingStatus !== undefined
          ? normalizeRecordingPersistenceStatus(
              data.recordingStatus,
              "Video clip recording status",
            )
          : undefined,
      recoveryStatus:
        "recoveryStatus" in data
          ? normalizeRecordingRecoveryStatus(
              data.recoveryStatus,
              "Video clip recovery status",
            )
          : undefined,
      finalizationError:
        "finalizationError" in data
          ? normalizeOptionalText(
              data.finalizationError,
              "Video clip finalization error",
            )
          : undefined,
      lastUpdatedAt: new Date(),
    },
    database,
  );
};

export const completeVideoClip = async (
  clipId: number,
  data: CompleteVideoClipInput,
  database?: DbOrTx,
) => {
  const existingVideoClip = await findVideoClipById(clipId, database);

  if (!existingVideoClip) {
    return null;
  }

  await validateVideoClipRange(
    {
      masterVideoId: existingVideoClip.masterVideoId,
      startOffsetMs: existingVideoClip.startOffsetMs,
      endOffsetMs: data.endOffsetMs,
    },
    database,
  );

  return updateVideoClipById(
    clipId,
    {
      endOffsetMs: data.endOffsetMs,
      clipFileUrl:
        data.clipFileUrl === undefined
          ? existingVideoClip.clipFileUrl
          : normalizeOptionalText(data.clipFileUrl, "Video clip fileUrl"),
      thumbnailUrl: normalizeOptionalText(
        data.thumbnailUrl,
        "Video clip thumbnailUrl",
      ),
      recordingStatus: RECORDING_PERSISTENCE_STATUS.finalized,
      recordingStoppedAt: new Date(),
      recoveryStatus: null,
      finalizationError: null,
      lastUpdatedAt: new Date(),
    },
    database,
  );
};

export const markVideoClipRecordingStarted = async (
  clipId: number,
  clipFileUrl: string,
  database?: DbOrTx,
) =>
  updateVideoClip(clipId, {
    clipFileUrl,
    recordingStatus: RECORDING_PERSISTENCE_STATUS.recording,
    recordingStartedAt: new Date(),
    finalizationError: null,
    recoveryStatus: null,
  }, database);

export const markVideoClipFinalizationFailed = async (
  clipId: number,
  error: string,
  database?: DbOrTx,
) =>
  updateVideoClip(clipId, {
    recordingStatus: RECORDING_PERSISTENCE_STATUS.finalizationFailed,
    finalizationError: normalizeRequiredText(error, "Finalization error"),
  }, database);

export const markVideoClipFinalized = async (
  clipId: number,
  data: {
    // Null since TS segments became the clip master (no local file to stat).
    fileSize: number | null;
    // ingest clips span 0..duration; absent leaves app-managed offsets alone
    endOffsetMs?: number;
  },
  database?: DbOrTx,
) =>
  updateVideoClip(clipId, {
    recordingStatus: RECORDING_PERSISTENCE_STATUS.finalized,
    recordingStoppedAt: new Date(),
    ...(data.endOffsetMs !== undefined ? { endOffsetMs: data.endOffsetMs } : {}),
    fileSize: data.fileSize,
    recoveryStatus: null,
    finalizationError: null,
  }, database);

export const markVideoClipInterrupted = async (
  clipId: number,
  data: {
    recoveryStatus: RecordingRecoveryStatus;
    fileSize: number | null;
    error?: string | null;
  },
  database?: DbOrTx,
) =>
  updateVideoClip(clipId, {
    recordingStatus: RECORDING_PERSISTENCE_STATUS.interrupted,
    recoveryStatus: data.recoveryStatus,
    fileSize: data.fileSize,
    finalizationError: data.error ?? null,
  }, database);

export const markVideoClipCanceled = async (
  clipId: number,
  database?: DbOrTx,
) =>
  updateVideoClip(clipId, {
    recordingStatus: RECORDING_PERSISTENCE_STATUS.canceled,
    recordingStoppedAt: new Date(),
  }, database);

export const listUnfinishedVideoClips = async (database?: DbOrTx) =>
  listVideoClipRecordsByStatuses(
    [
      RECORDING_PERSISTENCE_STATUS.recording,
      RECORDING_PERSISTENCE_STATUS.finalizationFailed,
    ],
    database,
  );

// active inspections: open clips (endOffsetMs null); status is unreliable
// because created clips default to 'finalized' until the recorder flips it
export const listActiveVideoClips = async (database?: DbOrTx) =>
  listActiveVideoClipRecords(database);

export const deleteVideoClip = async (clipId: number, database?: DbOrTx) =>
  deleteVideoClipById(clipId, database);
