import type {
  TaskStructureDescriptionNode,
  TaskStructureTaskCodeNode,
  TaskStructureTaskGroupNode,
  TaskStructureTypeNode,
} from "../../types/api";
import { AppError } from "../../lib/error";
import { db, type DbOrTx } from "../client";
import {
  createPartCodeRecord,
  deletePartCodeById,
  findPartCodeById,
  listPartCodeRecordsByTypeId,
  listPartCodeRecordsByTypeIds,
  updatePartCodeById,
} from "../repositories/part-code.repository";
import {
  createTypeRecord,
  deleteTypeById,
  findTypeById,
  findTypeByDescriptionIdAndCode,
  listTypeCatalogByProjectId,
  listTypeRecordsByDescriptionId,
  listTypeRecordsByDescriptionIds,
  updateTypeById,
} from "../repositories/type.repository";
import {
  createDescriptionRecord,
  deleteDescriptionById,
  findDescriptionById,
  listDescriptionRecordsByTaskCodeId,
  listDescriptionRecordsByTaskCodeIds,
  updateDescriptionById,
} from "../repositories/description.repository";
import {
  createTaskCodeRecord,
  deleteTaskCodeById,
  findTaskCodeById,
  listTaskCodeRecordsByTaskGroupId,
  listTaskCodeRecordsByTaskGroupIds,
  updateTaskCodeById,
} from "../repositories/task-code.repository";
import {
  createTaskGroupRecord,
  deleteTaskGroupById,
  findTaskGroupById,
  listTaskGroupRecordsByProjectId,
  updateTaskGroupById,
} from "../repositories/task-group.repository";

export type CreateTaskGroupInput = {
  projectId: number;
  code: string;
  label: string;
  displayOrder?: number;
};

export type CreateTaskCodeInput = {
  taskGroupId: number;
  code: string;
  label: string;
  displayOrder?: number;
};

export type CreateDescriptionInput = {
  taskCodeId: number;
  label: string;
  displayOrder?: number;
};

export type CreateTypeInput = {
  descriptionId: number;
  code: string;
  label: string;
};

export type CreatePartCodeInput = {
  typeId: number;
  code: string;
  label?: string | null;
  displayOrder?: number;
};

const normalizeRequired = (value: string, fieldName: string) => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${fieldName} is required`);
  return trimmed;
};

const normalizeOptional = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/* ---------- tree read (batched: 5 queries for the whole project) ---------- */
export const listProjectTaskStructureTree = async (
  projectId: number,
  database?: DbOrTx,
): Promise<TaskStructureTaskGroupNode[]> => {
  const groups = await listTaskGroupRecordsByProjectId(projectId, database);

  const taskCodes = await listTaskCodeRecordsByTaskGroupIds(
    groups.map((g) => g.taskGroupId),
    database,
  );
  const descriptions = await listDescriptionRecordsByTaskCodeIds(
    taskCodes.map((c) => c.taskCodeId),
    database,
  );
  const types = await listTypeRecordsByDescriptionIds(
    descriptions.map((d) => d.descriptionId),
    database,
  );
  const partCodes = await listPartCodeRecordsByTypeIds(
    types.map((t) => t.typeId),
    database,
  );

  const partCodesByType = new Map<number, typeof partCodes>();
  for (const part of partCodes) {
    const bucket = partCodesByType.get(part.typeId) ?? [];
    bucket.push(part);
    partCodesByType.set(part.typeId, bucket);
  }

  const typesByDescription = new Map<number, TaskStructureTypeNode[]>();
  for (const typeRow of types) {
    const node: TaskStructureTypeNode = {
      typeId: typeRow.typeId,
      code: typeRow.code,
      label: typeRow.label,
      displayOrder: typeRow.displayOrder,
      partCodes: (partCodesByType.get(typeRow.typeId) ?? []).map((part) => ({
        partCodeId: part.partCodeId,
        code: part.code,
        label: part.label,
        displayOrder: part.displayOrder,
      })),
    };
    const bucket = typesByDescription.get(typeRow.descriptionId) ?? [];
    bucket.push(node);
    typesByDescription.set(typeRow.descriptionId, bucket);
  }

  const descriptionsByTaskCode = new Map<number, TaskStructureDescriptionNode[]>();
  for (const row of descriptions) {
    const node: TaskStructureDescriptionNode = {
      descriptionId: row.descriptionId,
      label: row.label,
      displayOrder: row.displayOrder,
      types: typesByDescription.get(row.descriptionId) ?? [],
    };
    const bucket = descriptionsByTaskCode.get(row.taskCodeId) ?? [];
    bucket.push(node);
    descriptionsByTaskCode.set(row.taskCodeId, bucket);
  }

  const codesByGroup = new Map<number, TaskStructureTaskCodeNode[]>();
  for (const taskCode of taskCodes) {
    const node: TaskStructureTaskCodeNode = {
      taskCodeId: taskCode.taskCodeId,
      code: taskCode.code,
      label: taskCode.label,
      displayOrder: taskCode.displayOrder,
      descriptions: descriptionsByTaskCode.get(taskCode.taskCodeId) ?? [],
    };
    const bucket = codesByGroup.get(taskCode.taskGroupId) ?? [];
    bucket.push(node);
    codesByGroup.set(taskCode.taskGroupId, bucket);
  }

  return groups.map((group) => ({
    taskGroupId: group.taskGroupId,
    code: group.code,
    label: group.label,
    displayOrder: group.displayOrder,
    taskCodes: codesByGroup.get(group.taskGroupId) ?? [],
  }));
};

/* ---------- task group ---------- */
export const createTaskGroup = async (data: CreateTaskGroupInput, database?: DbOrTx) =>
  createTaskGroupRecord(
    {
      projectId: data.projectId,
      code: normalizeRequired(data.code, "Group code"),
      label: normalizeRequired(data.label, "Group label"),
      displayOrder: data.displayOrder ?? 0,
    },
    database,
  );

export const getTaskGroupById = (taskGroupId: number, database?: DbOrTx) =>
  findTaskGroupById(taskGroupId, database);

export const updateTaskGroup = async (
  taskGroupId: number,
  data: Partial<{ code: string; label: string; displayOrder: number }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateTaskGroupById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Group code");
  if (data.label !== undefined) next.label = normalizeRequired(data.label, "Group label");
  if (data.displayOrder !== undefined) next.displayOrder = data.displayOrder;
  return updateTaskGroupById(taskGroupId, next, database);
};

export const deleteTaskGroup = (taskGroupId: number, database?: DbOrTx) =>
  deleteTaskGroupById(taskGroupId, database);

/* ---------- task code ---------- */
export const createTaskCode = async (data: CreateTaskCodeInput, database?: DbOrTx) =>
  createTaskCodeRecord(
    {
      taskGroupId: data.taskGroupId,
      code: normalizeRequired(data.code, "Task code"),
      label: normalizeRequired(data.label, "Task label"),
      displayOrder: data.displayOrder ?? 0,
    },
    database,
  );

export const getTaskCodeById = (taskCodeId: number, database?: DbOrTx) =>
  findTaskCodeById(taskCodeId, database);

export const updateTaskCode = async (
  taskCodeId: number,
  data: Partial<{ code: string; label: string; displayOrder: number }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateTaskCodeById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Task code");
  if (data.label !== undefined) next.label = normalizeRequired(data.label, "Task label");
  if (data.displayOrder !== undefined) next.displayOrder = data.displayOrder;
  return updateTaskCodeById(taskCodeId, next, database);
};

export const deleteTaskCode = (taskCodeId: number, database?: DbOrTx) =>
  deleteTaskCodeById(taskCodeId, database);

/* ---------- description ---------- */
export const createDescription = async (
  data: CreateDescriptionInput,
  database?: DbOrTx,
) =>
  createDescriptionRecord(
    {
      taskCodeId: data.taskCodeId,
      label: normalizeRequired(data.label, "Description"),
      displayOrder: data.displayOrder ?? 0,
    },
    database,
  );

export const getDescriptionById = (descriptionId: number, database?: DbOrTx) =>
  findDescriptionById(descriptionId, database);

export const updateDescription = async (
  descriptionId: number,
  data: Partial<{ label: string; displayOrder: number }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateDescriptionById>[1]> = {};
  if (data.label !== undefined) next.label = normalizeRequired(data.label, "Description");
  if (data.displayOrder !== undefined) next.displayOrder = data.displayOrder;
  return updateDescriptionById(descriptionId, next, database);
};

export const deleteDescription = (descriptionId: number, database?: DbOrTx) =>
  deleteDescriptionById(descriptionId, database);

/* ---------- type (owned by one description) ---------- */
export const createType = async (data: CreateTypeInput, database?: DbOrTx) => {
  const code = normalizeRequired(data.code, "Type code");
  const label = normalizeRequired(data.label, "Type label");

  const existing = await findTypeByDescriptionIdAndCode(data.descriptionId, code, database);
  if (existing) {
    throw new AppError(409, "wrong_state", "That type code already exists under this description");
  }

  return createTypeRecord(
    {
      descriptionId: data.descriptionId,
      code,
      label,
      displayOrder: 0,
    },
    database,
  );
};

export const getTypeById = (typeId: number, database?: DbOrTx) =>
  findTypeById(typeId, database);

// rename in place: stable id, code and label change together
export const updateType = async (
  typeId: number,
  data: Partial<{ code: string; label: string; displayOrder: number }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateTypeById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Type code");
  if (data.label !== undefined) next.label = normalizeRequired(data.label, "Type label");
  if (data.displayOrder !== undefined) next.displayOrder = data.displayOrder;
  return updateTypeById(typeId, next, database);
};

export const deleteType = (typeId: number, database?: DbOrTx) =>
  deleteTypeById(typeId, database);

// project-wide type vocabulary for autocomplete: distinct code+label pairs
export const listTypeCatalog = (projectId: number, database?: DbOrTx) =>
  listTypeCatalogByProjectId(projectId, database);

// The label media keys and breadcrumbs use for a result's target: the
// description label, else the part code.
export const resolveTargetLabel = async (
  target: { descriptionId: number | null; partCodeId: number | null },
  database?: DbOrTx,
): Promise<string> => {
  if (target.descriptionId !== null) {
    const row = await findDescriptionById(target.descriptionId, database);
    return row?.label ?? `description-${target.descriptionId}`;
  }
  if (target.partCodeId !== null) {
    const row = await findPartCodeById(target.partCodeId, database);
    return row?.code ?? `part-${target.partCodeId}`;
  }
  throw new AppError(400, "validation_error", "result has no inspection target");
};

/* ---------- part code ---------- */
export const createPartCode = async (
  data: CreatePartCodeInput,
  database?: DbOrTx,
) =>
  createPartCodeRecord(
    {
      typeId: data.typeId,
      code: normalizeRequired(data.code, "Part code"),
      label: normalizeOptional(data.label),
      displayOrder: data.displayOrder ?? 0,
    },
    database,
  );

export const getPartCodeById = (partCodeId: number, database?: DbOrTx) =>
  findPartCodeById(partCodeId, database);

export const updatePartCode = async (
  partCodeId: number,
  data: Partial<{ code: string; label?: string | null; displayOrder: number }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updatePartCodeById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Part code");
  if (data.label !== undefined) next.label = normalizeOptional(data.label);
  if (data.displayOrder !== undefined) next.displayOrder = data.displayOrder;
  return updatePartCodeById(partCodeId, next, database);
};

export const deletePartCode = (partCodeId: number, database?: DbOrTx) =>
  deletePartCodeById(partCodeId, database);

/* ---------- convenience single-parent lists ---------- */
export const listTaskCodesByGroupId = (taskGroupId: number, database?: DbOrTx) =>
  listTaskCodeRecordsByTaskGroupId(taskGroupId, database);

export const listDescriptionsByTaskCodeId = (taskCodeId: number, database?: DbOrTx) =>
  listDescriptionRecordsByTaskCodeId(taskCodeId, database);

export const listPartCodesByTypeId = (typeId: number, database?: DbOrTx) =>
  listPartCodeRecordsByTypeId(typeId, database);
