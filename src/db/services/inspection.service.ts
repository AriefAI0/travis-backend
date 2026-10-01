// Inspection lifecycle orchestration, ported from the app's
// inspection-clip.service.ts. Owns start/stop/cancel of an inspection.
// The clip row stays with MinIO create — its stem embeds the clip PK.
import type { InspectionTypeCode } from "../../types/api";
import { db, type DbOrTx } from "../client";
import { AppError, notFound } from "../../lib/error";
import { removeMediaPrefix } from "../../lib/minio_storage/cleanup";
import { listIngestRecordsByClipIds } from "../repositories/recording-ingest.repository";
import { listInspectionFormFieldRecordsByFormId } from "../repositories/inspection-form.repository";
import { getSessionById } from "./session.service";
import {
  findRecordingMasterBySessionId,
  listVideoClipsByResultId,
} from "./video.service";
import {
  createResult,
  deleteResult,
  getResultById,
  listResultsBySessionId,
  updateResult,
  writeTypedDetail,
} from "./result.service";
import { getCurrentInspectionForm } from "./inspection-form.service";
import {
  getDescriptionById,
  getPartCodeById,
  getTaskCodeById,
  getTaskGroupById,
  getTypeById,
} from "./task-structure.service";



// find or create the session_item row for (sessionId, itemId)

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

// clips still on the wire, in one read for any number of clips
const listCapturingClipIds = async (
  clipIds: number[],
  database?: DbOrTx,
): Promise<Set<number>> => {
  if (clipIds.length === 0) return new Set();

  const ingestRows = await listIngestRecordsByClipIds(clipIds, database);
  return new Set(
    ingestRows
      .filter((row) => row.closedAt === null)
      .map((row) => row.clipId!)
      .filter((clipId) => clipId !== null),
  );
};

// open results of a session with clip state — the app's stop-master dialog

// flow: master check > duplicate check > resolve ids > create result — one tx
// all-or-nothing: any throw rolls back the session_item and result rows too

/* =========================================================
   Inspection lifecycle — task-tree targets, layers, custom values
   Open row = layer set and master_end_ms still null.
========================================================= */
export type StartInspectionInput = {
  sessionId: number;
  layer: number;
  inspectionTypeCode: InspectionTypeCode;
  descriptionId?: number;
  partCodeId?: number;
  remarks?: string | null;
  masterStartMs: number;
};

export type StopInspectionInput = {
  remarks?: string | null;
  payload: unknown;
  customValues?: Record<string, unknown>;
  masterEndMs: number;
};

export type ActiveInspection = {
  resultId: number;
  layer: number;
  descriptionId: number | null;
  partCodeId: number | null;
  inspectionTypeCode: InspectionTypeCode;
  remarks: string | null;
  masterStartMs: number | null;
  createdAt: Date;
  clip: { clipId: number; capturing: boolean } | null;
};

// resolve the target > owning project through the task tree chain
const resolveInspectionTarget = async (
  input: Pick<StartInspectionInput, "descriptionId" | "partCodeId">,
  database?: DbOrTx,
): Promise<{ projectId: number; descriptionId: number | null; partCodeId: number | null }> => {
  const both = input.descriptionId !== undefined && input.partCodeId !== undefined;
  const neither = input.descriptionId === undefined && input.partCodeId === undefined;
  if (both || neither) {
    throw new AppError(400, "validation_error", "exactly one of descriptionId or partCodeId is required");
  }

  if (input.descriptionId !== undefined) {
    const comp = await getDescriptionById(input.descriptionId, database);
    if (!comp) throw notFound(`description ${input.descriptionId}`);
    const taskCode = await getTaskCodeById(comp.taskCodeId, database);
    const group = taskCode ? await getTaskGroupById(taskCode.taskGroupId, database) : null;
    if (!taskCode || !group) throw notFound(`task code ${comp.taskCodeId}`);
    return { projectId: group.projectId, descriptionId: comp.descriptionId, partCodeId: null };
  }

  const code = await getPartCodeById(input.partCodeId!, database);
  if (!code) throw notFound(`part code ${input.partCodeId}`);
  const type = await getTypeById(code.typeId, database);
  const comp = type ? await getDescriptionById(type.descriptionId, database) : null;
  const taskCode = comp ? await getTaskCodeById(comp.taskCodeId, database) : null;
  const group = taskCode ? await getTaskGroupById(taskCode.taskGroupId, database) : null;
  if (!type || !comp || !taskCode || !group) throw notFound(`part code ${input.partCodeId}`);
  return { projectId: group.projectId, descriptionId: null, partCodeId: code.partCodeId };
};

// check custom values against the pinned form version; returns the cleaned map
const validateCustomValues = async (
  inspectionFormId: number,
  customValues: Record<string, unknown>,
  database?: DbOrTx,
): Promise<Record<string, unknown>> => {
  const fields = await listInspectionFormFieldRecordsByFormId(inspectionFormId, database);
  const byId = new Map(fields.map((field) => [String(field.inspectionFormFieldId), field]));
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(customValues)) {
    const field = byId.get(key);
    if (!field || field.isBuiltin) {
      throw new AppError(400, "custom_value_invalid", `customValues: unknown field ${key}`);
    }
    if (value === null || value === undefined) continue;
    const matches =
      (field.dataType === "integer" && Number.isInteger(value)) ||
      (field.dataType === "decimal" && typeof value === "number" && Number.isFinite(value)) ||
      (field.dataType === "text" && typeof value === "string") ||
      (field.dataType === "boolean" && typeof value === "boolean");
    if (!matches) {
      throw new AppError(400, "custom_value_invalid", `customValues: ${field.label} expects ${field.dataType}`);
    }
    values[key] = value;
  }

  for (const field of fields) {
    if (field.isBuiltin || !field.required) continue;
    const value = values[String(field.inspectionFormFieldId)];
    if (value === undefined || value === "") {
      throw new AppError(400, "custom_value_missing", `customValues: ${field.label} is required`);
    }
  }
  return values;
};

// active rows of a session: layer set and end anchor still null
const listActiveRows = async (sessionId: number, database?: DbOrTx) => {
  const rows = await listResultsBySessionId(sessionId, database);
  return rows.filter((row) => row.layer !== null && row.masterEndMs === null);
};

// flow: master > target > duplicate > layer > pin form > create — one tx
export const startInspection = async (
  input: StartInspectionInput,
  database?: DbOrTx,
) => {
  const run = async (tx: DbOrTx) => {
    await requireRecordingMaster(input.sessionId, tx);
    const sessionRecord = await getSessionById(input.sessionId, tx);
    if (!sessionRecord) throw notFound(`session ${input.sessionId}`);

    const target = await resolveInspectionTarget(input, tx);
    if (target.projectId !== sessionRecord.projectId) {
      throw new AppError(400, "target_project_mismatch", "target belongs to a different project");
    }

    const actives = await listActiveRows(input.sessionId, tx);
    for (const row of actives) {
      const sameTarget =
        row.descriptionId === target.descriptionId &&
        row.partCodeId === target.partCodeId;
      if (sameTarget && row.inspectionTypeCode === input.inspectionTypeCode) {
        throw new AppError(
          409,
          "inspection_in_progress",
          "An inspection is already in progress for this target and inspection type",
        );
      }
      if (row.layer === input.layer) {
        throw new AppError(
          409,
          "layer_in_use",
          `layer ${input.layer} already has an active inspection in this session`,
        );
      }
    }

    const form = await getCurrentInspectionForm(
      sessionRecord.projectId,
      input.inspectionTypeCode,
      tx,
    );
    const created = await createResult(
      {
        sessionId: input.sessionId,
        projectId: sessionRecord.projectId,
        inspectionTypeCode: input.inspectionTypeCode,
        descriptionId: target.descriptionId ?? undefined,
        partCodeId: target.partCodeId ?? undefined,
        layer: input.layer,
        masterStartMs: input.masterStartMs,
        inspectionFormId: form.inspectionFormId,
        remarks: input.remarks,
      },
      tx,
    );
    if (!created) throw new Error("result insert returned no row");
    return created;
  };

  return database ? run(database) : db.transaction(run);
};

// flow: fetch > open guard > validate customs > update row > write detail — one tx
export const stopInspection = async (
  resultId: number,
  input: StopInspectionInput,
  database?: DbOrTx,
) => {
  const run = async (tx: DbOrTx) => {
    const result = await getResultById(resultId, tx);
    if (!result) throw notFound(`result ${resultId}`);
    if (result.layer === null) {
      throw new AppError(409, "inspection_already_stopped", `inspection ${resultId} is not a task-tree inspection`);
    }
    if (result.masterEndMs !== null) {
      throw new AppError(409, "inspection_already_stopped", `inspection ${resultId} is already stopped`);
    }

    // An active inspection adopts the CURRENT form version: an operator who
    // edits the form mid-inspection can fill the new fields. The completed
    // result lands on that version, so its labels stay frozen afterwards.
    const form = await getCurrentInspectionForm(
      result.projectId,
      result.inspectionTypeCode,
      tx,
    );
    const values = await validateCustomValues(form.inspectionFormId, input.customValues ?? {}, tx);

    const update: Record<string, unknown> = {
      masterEndMs: input.masterEndMs,
      customValues: values,
      inspectionFormId: form.inspectionFormId,
    };
    if (input.remarks !== undefined) update.remarks = input.remarks;
    const updated = await updateResult(resultId, update, tx);
    if (!updated) throw new Error(`failed to update result ${resultId}`);

    await writeTypedDetail(result.inspectionTypeCode, input.payload, resultId, tx);
    return updated;
  };

  return database ? run(database) : db.transaction(run);
};

// cancel removes the open row, its clip, and the clip's uploaded media
export const cancelInspection = async (resultId: number, database?: DbOrTx) => {
  const result = await getResultById(resultId, database);
  if (!result) throw notFound(`result ${resultId}`);
  if (result.layer === null) {
    throw new AppError(409, "inspection_already_stopped", `inspection ${resultId} is not a task-tree inspection`);
  }
  if (result.masterEndMs !== null) {
    throw new AppError(
      409,
      "inspection_already_stopped",
      `inspection ${resultId} is already stopped and cannot be cancelled`,
    );
  }

  // fetch clip ingests before the row delete cascades them away
  const clips = await listVideoClipsByResultId(resultId, database);
  const ingestRows = await listIngestRecordsByClipIds(
    clips.map((clip) => clip.clipId),
    database,
  );
  for (const ingest of ingestRows) {
    await removeMediaPrefix(ingest.keyPrefix);
  }

  const deleted = await deleteResult(resultId, database);
  if (!deleted) throw new Error(`failed to delete result ${resultId}`);
  return deleted;
};

// open inspections of a session with clip state — stack restore
export const listActiveBySessionId = async (
  sessionId: number,
  database?: DbOrTx,
): Promise<ActiveInspection[]> => {
  const sessionRecord = await getSessionById(sessionId, database);
  if (!sessionRecord) throw notFound(`session ${sessionId}`);

  const rows = await listActiveRows(sessionId, database);

  const clipIdByResultId = new Map<number, number>();
  for (const row of rows) {
    const clip = (await listVideoClipsByResultId(row.resultId, database))[0];
    if (clip) clipIdByResultId.set(row.resultId, clip.clipId);
  }
  const capturingClipIds = await listCapturingClipIds(
    [...clipIdByResultId.values()],
    database,
  );

  return rows.map((row) => {
    const clipId = clipIdByResultId.get(row.resultId);
    return {
      resultId: row.resultId,
      layer: row.layer!,
      descriptionId: row.descriptionId,
      partCodeId: row.partCodeId,
      inspectionTypeCode: row.inspectionTypeCode,
      remarks: row.remarks,
      masterStartMs: row.masterStartMs,
      createdAt: row.createdAt,
      clip:
        clipId === undefined
          ? null
          : { clipId, capturing: capturingClipIds.has(clipId) },
    };
  });
};

/* ---------- session timeline: rows for the event table, markers for playback ---------- */
export type SessionInspectionBreadcrumb = {
  taskGroup: { code: string };
  taskCode: { code: string };
  description: { label: string };
  type: { code: string } | null;
  partCode: { code: string } | null;
};

export type SessionInspectionRow = {
  resultId: number;
  inspectionTypeCode: InspectionTypeCode;
  layer: number;
  displayNumber: number;
  remarks: string | null;
  masterStartMs: number | null;
  masterEndMs: number | null;
  createdAt: Date;
  target: {
    kind: "description" | "part_code";
    descriptionId: number | null;
    partCodeId: number | null;
    label: string;
  };
  breadcrumb: SessionInspectionBreadcrumb | null;
};

// walk a result's target to the full breadcrumb; labels follow renames
const buildBreadcrumb = async (
  descriptionId: number | null,
  partCodeId: number | null,
  database?: DbOrTx,
): Promise<{ breadcrumb: SessionInspectionBreadcrumb; label: string }> => {
  type PartCodeRow = Awaited<ReturnType<typeof getPartCodeById>>;
  type TypeRow = Awaited<ReturnType<typeof getTypeById>>;

  let partCode: PartCodeRow = null;
  let type: TypeRow = null;
  if (partCodeId !== null) {
    partCode = await getPartCodeById(partCodeId, database);
    type = partCode ? await getTypeById(partCode.typeId, database) : null;
  }
  const descriptionIdResolved =
    descriptionId ?? (type ? type.descriptionId : null);
  const comp = descriptionIdResolved
    ? await getDescriptionById(descriptionIdResolved, database)
    : null;
  const taskCode = comp ? await getTaskCodeById(comp.taskCodeId, database) : null;
  const group = taskCode ? await getTaskGroupById(taskCode.taskGroupId, database) : null;
  if (!comp || !taskCode || !group) throw notFound(`target of result`);

  return {
    breadcrumb: {
      taskGroup: { code: group.code },
      taskCode: { code: taskCode.code },
      description: { label: comp.label },
      type: type ? { code: type.code } : null,
      partCode: partCode ? { code: partCode.code } : null,
    },
    label: partCode ? partCode.code : comp.label,
  };
};

// all rows of a session, open and finished — the workspace event table
export const listSessionInspectionRows = async (
  sessionId: number,
  database?: DbOrTx,
): Promise<SessionInspectionRow[]> => {
  const sessionRecord = await getSessionById(sessionId, database);
  if (!sessionRecord) throw notFound(`session ${sessionId}`);

  const rows = (await listResultsBySessionId(sessionId, database)).filter(
    (row) => row.layer !== null,
  );

  return Promise.all(
    rows.map(async (row) => {
      const { breadcrumb, label } = await buildBreadcrumb(
        row.descriptionId,
        row.partCodeId,
        database,
      );
      return {
        resultId: row.resultId,
        inspectionTypeCode: row.inspectionTypeCode,
        layer: row.layer!,
        displayNumber: row.displayNumber,
        remarks: row.remarks,
        masterStartMs: row.masterStartMs,
        masterEndMs: row.masterEndMs,
        createdAt: row.createdAt,
        target: {
          kind: row.partCodeId !== null ? "part_code" : "description",
          descriptionId: row.descriptionId,
          partCodeId: row.partCodeId,
          label,
        },
        breadcrumb,
      };
    }),
  );
};

// finished rows only, ordered by master start — the playback layer markers
export const listSessionInspectionMarkers = async (
  sessionId: number,
  database?: DbOrTx,
) => {
  const rows = await listSessionInspectionRows(sessionId, database);
  return rows
    .filter((row) => row.masterEndMs !== null)
    .sort((a, b) => (a.masterStartMs ?? 0) - (b.masterStartMs ?? 0))
    .map((row) => ({
      resultId: row.resultId,
      inspectionTypeCode: row.inspectionTypeCode,
      layer: row.layer,
      masterStartMs: row.masterStartMs,
      masterEndMs: row.masterEndMs,
      targetLabel: row.target.label,
      breadcrumb: row.breadcrumb,
    }));
};
