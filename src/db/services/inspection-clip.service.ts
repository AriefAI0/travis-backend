import { db, type DbOrTx } from "../client";

// Local stand-in for the app's mediaEngine generator (server has no GStreamer).
export type GenerateClipVideoThumbnailInput = {
  projectId: number;
  projectTitle?: string | null;
  sessionId?: number | null;
  sessionName?: string | null;
  itemId: number;
  clipId: number;
  itemLabel?: string | null;
  inspectionTypeCode?: "GVI" | "CVI" | "MGI" | "CP" | "FMD" | "SCOUR" | null;
  inputPath: string;
  timestampMs: number;
};

export type ClipVideoThumbnailGenerator = {
  generateClipVideoThumbnail: (
    input: GenerateClipVideoThumbnailInput,
  ) => Promise<string>;
};
import { findActiveBySessionItemIdAndCode } from "../repositories/result.repository";
import { findActiveVideoClipByResultId } from "../repositories/video-clip.repository";
import {
  createSessionItem,
  getSessionById,
  getSessionItemById,
  getSessionItemBySessionIdAndItemId,
} from "./session.service";
import {
  completeVideoClip,
  deleteVideoClip,
  getVideoClipById,
  getVideoClipPlaybackById,
  startVideoClip,
} from "./video.service";
import {
  getItemById,
  getComponentById,
  getAssetById,
} from "./structure.service";
import {
  createResult,
  deleteResult,
  getResultById,
  updateResult,
  writeTypedDetail,
} from "./result.service";

export const INSPECTION_CLIP_RESULT_STATUS = {
  inProgress: "in_progress",
  completed: "completed",
} as const;

export type StartInspectionClipInput = {
  sessionItemId: number;
  inspectionTypeCode: "GVI" | "CVI" | "MGI" | "CP" | "FMD" | "SCOUR";
  projectId: number;
  assetId: number;
  componentId: number;
  itemId: number;
  sessionId: number;
  masterVideoId: number;
  startOffsetMs: number;
  remarks?: string | null;
};

export type StartRecordingInspectionClipInput = {
  sessionId: number;
  itemId: number;
  inspectionTypeCode: "GVI" | "CVI" | "MGI" | "CP" | "FMD" | "SCOUR";
  masterVideoId?: number;
  startOffsetMs: number;
  remarks?: string | null;
};

export type StopInspectionClipInput = {
  clipId: number;
  endOffsetMs: number;
  thumbnailUrl?: string | null;
  remarks?: string | null;
  payload?: unknown; // Typed detail — discriminated union per inspectionTypeCode
};

export type CancelInspectionClipInput = {
  clipId: number;
};

export type ActiveInspectionClipInput = {
  sessionItemId: number;
  inspectionTypeCode: "GVI" | "CVI" | "MGI" | "CP" | "FMD" | "SCOUR";
};

export type InspectionClipLifecycle = {
  result: Awaited<ReturnType<typeof createResult>>;
  clip: Awaited<ReturnType<typeof startVideoClip>>;
};

export type StopInspectionClipOptions = {
  thumbnailGenerator?: Pick<ClipVideoThumbnailGenerator, "generateClipVideoThumbnail">;
};

type ClipThumbnailContext = {
  projectId: number;
  sessionId: number;
  sessionName: string | null;
  itemId: number;
  itemLabel: string;
  inspectionTypeCode: "GVI" | "CVI" | "MGI" | "CP" | "FMD" | "SCOUR";
  inputPath: string;
};

const validatePositiveInteger = (value: number, fieldName: string) => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
};

const validateNonNegativeInteger = (value: number, fieldName: string) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
};

const resolveSessionItemId = async (
  sessionId: number,
  itemId: number,
  database?: DbOrTx,
) => {
  const existingSessionItem = await getSessionItemBySessionIdAndItemId(
    sessionId,
    itemId,
    database,
  );

  if (existingSessionItem) {
    return existingSessionItem.sessionItemId;
  }

  const createdSessionItem = await createSessionItem(
    {
      sessionId,
      itemId,
    },
    database,
  );

  if (!createdSessionItem) {
    throw new Error("Failed to create session item");
  }

  return createdSessionItem.sessionItemId;
};

/**
 * Resolve denormalized hierarchy IDs for result row.
 * Traces session_item → item → component → asset → session.
 */
const resolveDenormIds = async (
  sessionItemId: number,
  database?: DbOrTx,
) => {
  const sessionItem = await getSessionItemById(sessionItemId, database);
  if (!sessionItem) {
    throw new Error(`Session item ${sessionItemId} does not exist`);
  }

  const item = await getItemById(sessionItem.itemId, database);
  if (!item) {
    throw new Error(`Item ${sessionItem.itemId} does not exist`);
  }

  const component = await getComponentById(item.componentId, database);
  if (!component) {
    throw new Error(`Component ${item.componentId} does not exist`);
  }

  const asset = await getAssetById(component.assetId, database);
  if (!asset) {
    throw new Error(`Asset ${component.assetId} does not exist`);
  }

  return {
    projectId: asset.projectId,
    assetId: component.assetId,
    componentId: item.componentId,
    itemId: item.itemId,
    sessionId: sessionItem.sessionId,
  };
};

const resolveClipThumbnailContext = async (
  clipId: number,
  resultId: number,
  database?: DbOrTx,
): Promise<ClipThumbnailContext> => {
  const [selectedResult, selectedPlayback] = await Promise.all([
    getResultById(resultId, database),
    getVideoClipPlaybackById(clipId, database),
  ]);

  if (!selectedResult) {
    throw new Error(`Result ${resultId} does not exist`);
  }

  if (!selectedPlayback) {
    throw new Error(`Video clip ${clipId} does not have playback metadata`);
  }

  const sessionItem = await getSessionItemById(selectedResult.sessionItemId, database);
  if (!sessionItem) {
    throw new Error(`Session item ${selectedResult.sessionItemId} does not exist`);
  }

  const selectedItem = await getItemById(sessionItem.itemId, database);
  if (!selectedItem) {
    throw new Error(`Item ${sessionItem.itemId} does not exist`);
  }

  const selectedSession = await getSessionById(sessionItem.sessionId, database);
  if (!selectedSession) {
    throw new Error(`Session ${sessionItem.sessionId} does not exist`);
  }

  return {
    projectId: selectedResult.projectId,
    sessionId: selectedSession.sessionId,
    sessionName: selectedSession.name,
    itemId: selectedItem.itemId,
    itemLabel: selectedItem.itemLabel,
    inspectionTypeCode: selectedResult.inspectionTypeCode,
    inputPath: selectedPlayback.fileUrl,
  };
};

const resolveStopClipFileUrl = (
  data: StopInspectionClipInput,
  existingClip: Awaited<ReturnType<typeof getVideoClipById>>,
) => {
  if (!existingClip) {
    throw new Error(`Video clip ${data.clipId} does not exist`);
  }

  if (existingClip.clipFileUrl) {
    return existingClip.clipFileUrl;
  }

  throw new Error(`Video clip ${data.clipId} does not have a clip file path`);
};

// Clip thumbnails disabled: no local clip file to read (TS segments live on the
// server). Kept commented out as reference for the future object-storage worker
// (mirrors the master recording treatment in f3de3f1).
// const resolveStopClipThumbnailUrl = async (
//   data: StopInspectionClipInput,
//   existingClip: Awaited<ReturnType<typeof getVideoClipById>>,
//   generator: Pick<ClipVideoThumbnailGenerator, "generateClipVideoThumbnail">,
//   thumbnailContext: ClipThumbnailContext,
// ) => {
//   if (data.thumbnailUrl !== undefined) {
//     return data.thumbnailUrl;
//   }
//
//   if (!existingClip) {
//     throw new Error(`Video clip ${data.clipId} does not exist`);
//   }
//
//   const thumbnailTimestampMs =
//     existingClip.clipFileUrl !== null
//       ? data.endOffsetMs - existingClip.startOffsetMs > 1000
//         ? 1000
//         : 0
//       : data.endOffsetMs - existingClip.startOffsetMs > 1000
//         ? existingClip.startOffsetMs + 1000
//         : existingClip.startOffsetMs;
//
//   return generator.generateClipVideoThumbnail({
//     projectId: thumbnailContext.projectId,
//     sessionId: thumbnailContext.sessionId,
//     sessionName: thumbnailContext.sessionName,
//     itemId: thumbnailContext.itemId,
//     itemLabel: thumbnailContext.itemLabel,
//     inspectionTypeCode: thumbnailContext.inspectionTypeCode,
//     clipId: data.clipId,
//     inputPath: existingClip.clipFileUrl ?? thumbnailContext.inputPath,
//     timestampMs: thumbnailTimestampMs,
//   });
// };

const validateStopClipRange = (
  data: StopInspectionClipInput,
  existingClip: Awaited<ReturnType<typeof getVideoClipById>>,
) => {
  if (!existingClip) {
    throw new Error(`Video clip ${data.clipId} does not exist`);
  }

  if (data.endOffsetMs <= existingClip.startOffsetMs) {
    throw new Error("Video clip endOffsetMs must be greater than startOffsetMs");
  }
};

export const validateInspectionClipStop = async (
  data: StopInspectionClipInput,
  database?: DbOrTx,
) => {
  validatePositiveInteger(data.clipId, "Clip id");
  validateNonNegativeInteger(data.endOffsetMs, "End offset");

  const existingClip = await getVideoClipById(data.clipId, database);

  if (!existingClip) {
    return null;
  }

  if (existingClip.endOffsetMs !== null) {
    throw new Error(`Video clip ${data.clipId} has already been completed`);
  }

  validateStopClipRange(data, existingClip);

  return existingClip;
};

export const getActiveInspectionClip = async (
  data: ActiveInspectionClipInput,
  database?: DbOrTx,
): Promise<InspectionClipLifecycle | null> => {
  validatePositiveInteger(data.sessionItemId, "Session item id");

  const activeResult = await findActiveBySessionItemIdAndCode(
    data.sessionItemId,
    data.inspectionTypeCode,
    database,
  );

  if (!activeResult) {
    return null;
  }

  const activeClip = await findActiveVideoClipByResultId(
    activeResult.resultId,
    database,
  );

  if (!activeClip) {
    // result.status was dropped in Phase 2 — a result with no active (open)
    // video clip is the normal post-stop/post-cancel state, not an invariant
    // violation. "No active clip" therefore means "no active inspection".
    return null;
  }

  return {
    result: activeResult,
    clip: activeClip,
  };
};

export const startInspectionClip = async (
  data: StartInspectionClipInput,
  database?: DbOrTx,
): Promise<InspectionClipLifecycle> => {
  validatePositiveInteger(data.sessionItemId, "Session item id");
  validatePositiveInteger(data.masterVideoId, "Master video id");
  validateNonNegativeInteger(data.startOffsetMs, "Start offset");

  // flow: check active > create result > start clip, all in one tx
  const run = async (tx: DbOrTx): Promise<InspectionClipLifecycle> => {
    const activeClip = await getActiveInspectionClip(
      {
        sessionItemId: data.sessionItemId,
        inspectionTypeCode: data.inspectionTypeCode,
      },
      tx,
    );

    if (activeClip) {
      throw new Error(
        "An inspection clip is already in progress for this session item and inspection type",
      );
    }

    const createdResult = await createResult(
      {
        sessionItemId: data.sessionItemId,
        inspectionTypeCode: data.inspectionTypeCode,
        projectId: data.projectId,
        assetId: data.assetId,
        componentId: data.componentId,
        itemId: data.itemId,
        sessionId: data.sessionId,
        remarks: data.remarks,
      },
      tx,
    );

    if (!createdResult) {
      throw new Error("Failed to create inspection result");
    }

    const createdClip = await startVideoClip(
      {
        resultId: createdResult.resultId,
        masterVideoId: data.masterVideoId,
        startOffsetMs: data.startOffsetMs,
      },
      tx,
    );

    if (!createdClip) {
      throw new Error("Failed to create inspection video clip");
    }

    return {
      result: createdResult,
      clip: createdClip,
    };
  };

  return database ? run(database) : db.transaction(run);
};

export const startInspectionClipFromRecording = async (
  data: StartRecordingInspectionClipInput,
  database?: DbOrTx,
): Promise<InspectionClipLifecycle> => {
  validatePositiveInteger(data.sessionId, "Session id");
  validatePositiveInteger(data.itemId, "Item id");
  validateNonNegativeInteger(data.startOffsetMs, "Start offset");

  // flow: resolve session item > resolve denorm ids > start clip, one tx
  const run = async (tx: DbOrTx): Promise<InspectionClipLifecycle> => {
    const sessionItemId = await resolveSessionItemId(data.sessionId, data.itemId, tx);
    const denormIds = await resolveDenormIds(sessionItemId, tx);

    return startInspectionClip(
      {
        sessionItemId,
        inspectionTypeCode: data.inspectionTypeCode,
        masterVideoId: data.masterVideoId ?? 0, // Fallback; caller should provide
        startOffsetMs: data.startOffsetMs,
        remarks: data.remarks,
        ...denormIds,
      },
      tx,
    );
  };

  return database ? run(database) : db.transaction(run);
};

export const stopInspectionClip = async (
  data: StopInspectionClipInput,
  database?: DbOrTx,
  // Accepted (and ignored) while thumbnails are disabled — restores the
  // generator wiring without touching call sites when they come back.
  _options: StopInspectionClipOptions = {},
): Promise<InspectionClipLifecycle | null> => {
  // flow: validate > complete clip > update result > typed detail, one tx
  const run = async (tx: DbOrTx): Promise<InspectionClipLifecycle | null> => {
    const existingClip = await validateInspectionClipStop(data, tx);

    if (!existingClip) {
      return null;
    }

    const clipContext = await resolveClipThumbnailContext(
      data.clipId,
      existingClip.resultId,
      tx,
    );
    const clipFileUrl = resolveStopClipFileUrl(data, existingClip);
    // Clip thumbnails disabled: no local clip file to read (TS segments live on the
    // server). Kept commented out as reference for the future object-storage worker
    // (mirrors the master recording treatment in f3de3f1).
    // const thumbnailUrl = await resolveStopClipThumbnailUrl(
    //   data,
    //   existingClip,
    //   options.thumbnailGenerator ?? clipVideoThumbnailGenerator,
    //   clipContext,
    // );
    const thumbnailUrl = null;

    const completedClip = await completeVideoClip(
      data.clipId,
      {
        endOffsetMs: data.endOffsetMs,
        clipFileUrl,
        thumbnailUrl,
      },
      tx,
    );

    if (!completedClip) {
      throw new Error(`Failed to complete video clip ${data.clipId}`);
    }

    const completedResult = await updateResult(
      existingClip.resultId,
      {
        ...(data.remarks === undefined ? {} : { remarks: data.remarks }),
      },
      tx,
    );

    if (!completedResult) {
      throw new Error(`Failed to complete result ${existingClip.resultId}`);
    }

    if (data.payload) {
      // Write typed detail to the appropriate typed table (MGI/CP/FMD/GVI/CVI)
      await writeTypedDetail(
        clipContext.inspectionTypeCode,
        data.payload,
        existingClip.resultId,
        tx,
      );
    }

    return {
      result: completedResult,
      clip: completedClip,
    };
  };

  return database ? run(database) : db.transaction(run);
};

export const cancelInspectionClip = async (
  data: CancelInspectionClipInput,
  database?: DbOrTx,
): Promise<InspectionClipLifecycle | null> => {
  validatePositiveInteger(data.clipId, "Clip id");

  // flow: check clip open > delete clip > delete result, one tx
  const run = async (tx: DbOrTx): Promise<InspectionClipLifecycle | null> => {
    const existingClip = await getVideoClipById(data.clipId, tx);

    if (!existingClip) {
      return null;
    }

    if (existingClip.endOffsetMs !== null) {
      throw new Error(`Completed video clip ${data.clipId} cannot be cancelled`);
    }

    const deletedClip = await deleteVideoClip(data.clipId, tx);

    if (!deletedClip) {
      throw new Error(`Failed to delete video clip ${data.clipId}`);
    }

    const deletedResult = await deleteResult(existingClip.resultId, tx);

    if (!deletedResult) {
      throw new Error(`Failed to delete result ${existingClip.resultId}`);
    }

    return {
      result: deletedResult,
      clip: deletedClip,
    };
  };

  return database ? run(database) : db.transaction(run);
};
