// Inspection lifecycle orchestration, ported from the app's
// inspection-clip.service.ts. Owns start/stop/cancel of an inspection.
// The clip row stays with MinIO create — its stem embeds the clip PK.
import type { InspectionTypeCode } from "../../types/api";
import { db, type DbOrTx } from "../client";
import { AppError, notFound } from "../../lib/error";
import {
  createSessionItem,
  getSessionById,
  getSessionItemById,
  getSessionItemBySessionIdAndItemId,
} from "./session.service";
import { getAssetById, getComponentById, getItemById } from "./structure.service";
import {
  findRecordingMasterBySessionId,
  listVideoClipsByResultId,
} from "./video.service";
import {
  createResult,
  deleteResult,
  getCpDetailByResultId,
  getCviDetailByResultId,
  getFmdDetailByResultId,
  getResultById,
  getResultMgiDetailByResultId,
  getGviDetailByResultId,
  getScourDetailByResultId,
  listResultsBySessionId,
  listResultsBySessionItemId,
  updateResult,
  writeTypedDetail,
} from "./result.service";

export type StartInspectionInput = {
  sessionId: number;
  itemId: number;
  inspectionTypeCode: InspectionTypeCode;
  remarks?: string | null;
};

export type StopInspectionInput = {
  remarks?: string | null;
  // typed detail — discriminated union per inspectionTypeCode
  payload: unknown;
};

// per-type detail readers; a null read means the result is still open
const detailGetters: Record<
  InspectionTypeCode,
  (resultId: number, database?: DbOrTx) => Promise<unknown>
> = {
  MGI: getResultMgiDetailByResultId,
  CP: getCpDetailByResultId,
  FMD: getFmdDetailByResultId,
  SCOUR: getScourDetailByResultId,
  GVI: getGviDetailByResultId,
  CVI: getCviDetailByResultId,
};

// find or create the session_item row for (sessionId, itemId)
export const resolveSessionItemId = async (
  sessionId: number,
  itemId: number,
  database?: DbOrTx,
) => {
  const existing = await getSessionItemBySessionIdAndItemId(sessionId, itemId, database);
  if (existing) return existing.sessionItemId;

  const created = await createSessionItem({ sessionId, itemId }, database);
  if (!created) throw new Error("session item insert returned no row");
  return created.sessionItemId;
};

// walk session_item > item > component > asset for the denormalized ids
export const resolveDenormIds = async (sessionItemId: number, database?: DbOrTx) => {
  const sessionItem = await getSessionItemById(sessionItemId, database);
  if (!sessionItem) throw notFound(`session item ${sessionItemId}`);

  const item = await getItemById(sessionItem.itemId, database);
  if (!item) throw notFound(`item ${sessionItem.itemId}`);

  const component = await getComponentById(item.componentId, database);
  if (!component) throw notFound(`component ${item.componentId}`);

  const asset = await getAssetById(component.assetId, database);
  if (!asset) throw notFound(`asset ${component.assetId}`);

  return {
    projectId: asset.projectId,
    assetId: component.assetId,
    componentId: item.componentId,
    itemId: item.itemId,
    sessionId: sessionItem.sessionId,
  };
};

// the session MUST have a master capturing now — no open ingest, no inspection
export const requireRecordingMaster = async (sessionId: number, database?: DbOrTx) => {
  const recording = await findRecordingMasterBySessionId(sessionId, database);
  if (!recording) {
    throw new AppError(
      409,
      "no_master_video",
      `session ${sessionId} has no master video on recording`,
    );
  }
  return recording;
};

// open = result exists and its typed detail is still unwritten
const hasTypedDetail = async (
  inspectionTypeCode: InspectionTypeCode,
  resultId: number,
  database?: DbOrTx,
) => (await detailGetters[inspectionTypeCode](resultId, database)) !== null;

// the open result for (sessionItemId, type), or null when none is open
export const getActiveInspection = async (
  sessionItemId: number,
  inspectionTypeCode: InspectionTypeCode,
  database?: DbOrTx,
) => {
  const results = await listResultsBySessionItemId(sessionItemId, database);
  for (const result of results) {
    if (result.inspectionTypeCode !== inspectionTypeCode) continue;
    if (!(await hasTypedDetail(result.inspectionTypeCode, result.resultId, database))) {
      return result;
    }
  }
  return null;
};

// read-only pair lookup: never creates the session_item, null when absent
export const getActiveInspectionByPair = async (
  sessionId: number,
  itemId: number,
  inspectionTypeCode: InspectionTypeCode,
  database?: DbOrTx,
) => {
  const existing = await getSessionItemBySessionIdAndItemId(sessionId, itemId, database);
  if (!existing) return null;
  return getActiveInspection(existing.sessionItemId, inspectionTypeCode, database);
};

export type OpenInspection = {
  resultId: number;
  sessionItemId: number;
  itemId: number;
  inspectionTypeCode: InspectionTypeCode;
  remarks: string | null;
  createdAt: Date;
  clip: { clipId: number; recordingStatus: string; storageStem: string | null } | null;
};

// open results of a session with clip state — the app's stop-master dialog
export const listOpenInspectionsBySessionId = async (
  sessionId: number,
  database?: DbOrTx,
) => {
  const sessionRecord = await getSessionById(sessionId, database);
  if (!sessionRecord) throw notFound(`session ${sessionId}`);

  const open: OpenInspection[] = [];
  for (const result of await listResultsBySessionId(sessionId, database)) {
    if (await hasTypedDetail(result.inspectionTypeCode, result.resultId, database)) continue;
    const clip = (await listVideoClipsByResultId(result.resultId, database))[0] ?? null;
    open.push({
      resultId: result.resultId,
      sessionItemId: result.sessionItemId,
      itemId: result.itemId,
      inspectionTypeCode: result.inspectionTypeCode,
      remarks: result.remarks,
      createdAt: result.createdAt,
      clip: clip
        ? {
            clipId: clip.clipId,
            recordingStatus: clip.recordingStatus,
            storageStem: clip.storageStem,
          }
        : null,
    });
  }
  return open;
};

// flow: master check > duplicate check > resolve ids > create result — one tx
// all-or-nothing: any throw rolls back the session_item and result rows too
export const startInspection = async (input: StartInspectionInput, database?: DbOrTx) => {
  const run = async (tx: DbOrTx) => {
    await requireRecordingMaster(input.sessionId, tx);

    const sessionItemId = await resolveSessionItemId(input.sessionId, input.itemId, tx);
    const active = await getActiveInspection(sessionItemId, input.inspectionTypeCode, tx);
    if (active) {
      throw new AppError(
        409,
        "inspection_in_progress",
        "An inspection is already in progress for this session item and inspection type",
      );
    }

    const denormIds = await resolveDenormIds(sessionItemId, tx);
    const created = await createResult(
      {
        sessionItemId,
        inspectionTypeCode: input.inspectionTypeCode,
        ...denormIds,
        remarks: input.remarks,
      },
      tx,
    );
    if (!created) throw new Error("result insert returned no row");
    return created;
  };

  return database ? run(database) : db.transaction(run);
};

// flow: fetch result > guard double stop > update remarks > write detail — one tx
export const stopInspection = async (
  resultId: number,
  input: StopInspectionInput,
  database?: DbOrTx,
) => {
  const run = async (tx: DbOrTx) => {
    const result = await getResultById(resultId, tx);
    if (!result) throw notFound(`result ${resultId}`);

    if (await hasTypedDetail(result.inspectionTypeCode, resultId, tx)) {
      throw new AppError(
        409,
        "inspection_already_stopped",
        `inspection ${resultId} is already stopped`,
      );
    }

    const updated = input.remarks === undefined
      ? result
      : await updateResult(resultId, { remarks: input.remarks }, tx);
    if (!updated) throw new Error(`failed to update result ${resultId}`);

    await writeTypedDetail(result.inspectionTypeCode, input.payload, resultId, tx);
    return updated;
  };

  return database ? run(database) : db.transaction(run);
};

// remove an abandoned-open inspection; the clip row cascades via FK
export const cancelInspection = async (resultId: number, database?: DbOrTx) => {
  const result = await getResultById(resultId, database);
  if (!result) throw notFound(`result ${resultId}`);

  // a stopped inspection carries evidence — never delete it here
  if (await hasTypedDetail(result.inspectionTypeCode, resultId, database)) {
    throw new AppError(
      409,
      "inspection_already_stopped",
      `inspection ${resultId} is already stopped and cannot be cancelled`,
    );
  }

  const deleted = await deleteResult(resultId, database);
  if (!deleted) throw new Error(`failed to delete result ${resultId}`);
  return deleted;
};
