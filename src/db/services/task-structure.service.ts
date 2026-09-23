import type {
  TaskStructureMainComponentNode,
  TaskStructureTaskCodeNode,
  TaskStructureTaskGroupNode,
  TaskStructureTypeBranchNode,
} from "../../types/api";
import { AppError } from "../../lib/error";
import { db, type DbOrTx } from "../client";
import {
  createComponentCodeRecord,
  deleteComponentCodeById,
  findComponentCodeById,
  updateComponentCodeById,
} from "../repositories/component-code.repository";
import {
  createComponentTypeRecord,
  deleteComponentTypeById,
  findComponentTypeById,
  findComponentTypeByProjectIdAndCode,
  listComponentTypeRecordsByProjectId,
  updateComponentTypeById,
} from "../repositories/component-type.repository";
import {
  createMainComponentRecord,
  deleteMainComponentById,
  findMainComponentById,
  updateMainComponentById,
} from "../repositories/main-component.repository";
import {
  createMainComponentTypeRecord,
  deleteMainComponentTypeById,
  findMainComponentTypeById,
  listMainComponentTypeRecordsByComponentTypeId,
  listMainComponentTypeRecordsByMainComponentIds,
  updateMainComponentTypeById,
} from "../repositories/main-component-type.repository";
import {
  createTaskCodeRecord,
  deleteTaskCodeById,
  findTaskCodeById,
  updateTaskCodeById,
} from "../repositories/task-code.repository";
import {
  createTaskGroupRecord,
  deleteTaskGroupById,
  findTaskGroupById,
  updateTaskGroupById,
} from "../repositories/task-group.repository";
import {
  listComponentCodeRecordsByMainComponentTypeIds,
  listComponentCodeRecordsByMainComponentTypeId,
} from "../repositories/component-code.repository";
import { listMainComponentRecordsByTaskCodeId, listMainComponentRecordsByTaskCodeIds } from "../repositories/main-component.repository";
import { listTaskCodeRecordsByTaskGroupId, listTaskCodeRecordsByTaskGroupIds } from "../repositories/task-code.repository";
import { listTaskGroupRecordsByProjectId } from "../repositories/task-group.repository";

export type CreateTaskGroupInput = {
  projectId: number;
  groupCode: string;
  label: string;
  displayOrder?: number;
};

export type CreateTaskCodeInput = {
  taskGroupId: number;
  code: string;
  label: string;
  displayOrder?: number;
};

export type CreateMainComponentInput = {
  taskCodeId: number;
  description: string;
  displayOrder?: number;
};

export type AttachMainComponentTypeInput = {
  mainComponentId: number;
  typeCode: string;
  label: string;
};

export type CreateComponentCodeInput = {
  mainComponentTypeId: number;
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

/* ---------- tree read (batched: 6 queries for the whole project) ---------- */
export const listProjectTaskStructureTree = async (
  projectId: number,
  database?: DbOrTx,
): Promise<TaskStructureTaskGroupNode[]> => {
  const [groups, catalog] = await Promise.all([
    listTaskGroupRecordsByProjectId(projectId, database),
    listComponentTypeRecordsByProjectId(projectId, undefined, database),
  ]);

  const taskCodes = await listTaskCodeRecordsByTaskGroupIds(
    groups.map((g) => g.taskGroupId),
    database,
  );
  const mainComponents = await listMainComponentRecordsByTaskCodeIds(
    taskCodes.map((c) => c.taskCodeId),
    database,
  );
  const branches = await listMainComponentTypeRecordsByMainComponentIds(
    mainComponents.map((m) => m.mainComponentId),
    database,
  );
  const componentCodes = await listComponentCodeRecordsByMainComponentTypeIds(
    branches.map((b) => b.mainComponentTypeId),
    database,
  );

  const catalogById = new Map(catalog.map((t) => [t.componentTypeId, t]));
  const codesByBranch = new Map<number, typeof componentCodes>();
  for (const code of componentCodes) {
    const bucket = codesByBranch.get(code.mainComponentTypeId) ?? [];
    bucket.push(code);
    codesByBranch.set(code.mainComponentTypeId, bucket);
  }

  const branchesByComponent = new Map<number, TaskStructureTypeBranchNode[]>();
  for (const branch of branches) {
    const type = catalogById.get(branch.componentTypeId);
    if (!type) continue; // archived catalog row: branch hidden from the tree
    const node: TaskStructureTypeBranchNode = {
      mainComponentTypeId: branch.mainComponentTypeId,
      componentTypeId: branch.componentTypeId,
      typeCode: type.typeCode,
      label: type.label,
      displayOrder: branch.displayOrder,
      componentCodes: (codesByBranch.get(branch.mainComponentTypeId) ?? []).map((code) => ({
        componentCodeId: code.componentCodeId,
        code: code.code,
        label: code.label,
        displayOrder: code.displayOrder,
      })),
    };
    const bucket = branchesByComponent.get(branch.mainComponentId) ?? [];
    bucket.push(node);
    branchesByComponent.set(branch.mainComponentId, bucket);
  }

  const componentsByTaskCode = new Map<number, TaskStructureMainComponentNode[]>();
  for (const comp of mainComponents) {
    const node: TaskStructureMainComponentNode = {
      mainComponentId: comp.mainComponentId,
      description: comp.description,
      displayOrder: comp.displayOrder,
      types: branchesByComponent.get(comp.mainComponentId) ?? [],
    };
    const bucket = componentsByTaskCode.get(comp.taskCodeId) ?? [];
    bucket.push(node);
    componentsByTaskCode.set(comp.taskCodeId, bucket);
  }

  const codesByGroup = new Map<number, TaskStructureTaskCodeNode[]>();
  for (const taskCode of taskCodes) {
    const node: TaskStructureTaskCodeNode = {
      taskCodeId: taskCode.taskCodeId,
      code: taskCode.code,
      label: taskCode.label,
      displayOrder: taskCode.displayOrder,
      mainComponents: componentsByTaskCode.get(taskCode.taskCodeId) ?? [],
    };
    const bucket = codesByGroup.get(taskCode.taskGroupId) ?? [];
    bucket.push(node);
    codesByGroup.set(taskCode.taskGroupId, bucket);
  }

  return groups.map((group) => ({
    taskGroupId: group.taskGroupId,
    groupCode: group.groupCode,
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
      groupCode: normalizeRequired(data.groupCode, "Group code"),
      label: normalizeRequired(data.label, "Group label"),
      displayOrder: data.displayOrder ?? 0,
    },
    database,
  );

export const getTaskGroupById = (taskGroupId: number, database?: DbOrTx) =>
  findTaskGroupById(taskGroupId, database);

export const updateTaskGroup = async (
  taskGroupId: number,
  data: Partial<{ groupCode: string; label: string; displayOrder: number }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateTaskGroupById>[1]> = {};
  if (data.groupCode !== undefined)
    next.groupCode = normalizeRequired(data.groupCode, "Group code");
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

/* ---------- main component ---------- */
export const createMainComponent = async (
  data: CreateMainComponentInput,
  database?: DbOrTx,
) =>
  createMainComponentRecord(
    {
      taskCodeId: data.taskCodeId,
      description: normalizeRequired(data.description, "Description"),
      displayOrder: data.displayOrder ?? 0,
    },
    database,
  );

export const getMainComponentById = (mainComponentId: number, database?: DbOrTx) =>
  findMainComponentById(mainComponentId, database);

export const updateMainComponent = async (
  mainComponentId: number,
  data: Partial<{ description: string; displayOrder: number }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateMainComponentById>[1]> = {};
  if (data.description !== undefined)
    next.description = normalizeRequired(data.description, "Description");
  if (data.displayOrder !== undefined) next.displayOrder = data.displayOrder;
  return updateMainComponentById(mainComponentId, next, database);
};

export const deleteMainComponent = (mainComponentId: number, database?: DbOrTx) =>
  deleteMainComponentById(mainComponentId, database);

/* ---------- type branch + project catalog ---------- */
// resolve the owning project through main component > task code > task group
const resolveProjectIdForMainComponent = async (
  mainComponentId: number,
  database?: DbOrTx,
): Promise<number> => {
  const comp = await findMainComponentById(mainComponentId, database);
  if (!comp) throw new Error("Parent task code does not exist");
  const taskCode = await findTaskCodeById(comp.taskCodeId, database);
  if (!taskCode) throw new Error("Parent task code does not exist");
  const group = await findTaskGroupById(taskCode.taskGroupId, database);
  if (!group) throw new Error("Parent task code does not exist");
  return group.projectId;
};

// attach a type branch; the catalog value is created on first use, reused after
export const attachMainComponentType = async (
  data: AttachMainComponentTypeInput,
  database?: DbOrTx,
) => {
  const projectId = await resolveProjectIdForMainComponent(data.mainComponentId, database);
  const typeCode = normalizeRequired(data.typeCode, "Type code");
  const label = normalizeRequired(data.label, "Type label");

  const existing = await findComponentTypeByProjectIdAndCode(projectId, typeCode, database);
  const catalogRow =
    existing ?? (await createComponentTypeRecord({ projectId, typeCode, label }, database));

  return createMainComponentTypeRecord(
    {
      mainComponentId: data.mainComponentId,
      componentTypeId: catalogRow.componentTypeId,
      displayOrder: 0,
    },
    database,
  );
};

export const getMainComponentTypeById = (mainComponentTypeId: number, database?: DbOrTx) =>
  findMainComponentTypeById(mainComponentTypeId, database);

export const updateMainComponentType = async (
  mainComponentTypeId: number,
  data: Partial<{ componentTypeId: number; displayOrder: number }>,
  database?: DbOrTx,
) => updateMainComponentTypeById(mainComponentTypeId, data, database);

export const deleteMainComponentType = (mainComponentTypeId: number, database?: DbOrTx) =>
  deleteMainComponentTypeById(mainComponentTypeId, database);

export const listComponentTypes = (
  projectId: number,
  query?: string,
  database?: DbOrTx,
) => listComponentTypeRecordsByProjectId(projectId, query, database);

export const createComponentType = async (
  projectId: number,
  data: { typeCode: string; label: string },
  database?: DbOrTx,
) =>
  createComponentTypeRecord(
    {
      projectId,
      typeCode: normalizeRequired(data.typeCode, "Type code"),
      label: normalizeRequired(data.label, "Type label"),
    },
    database,
  );

// rename in place: stable id, code and label change together
export const renameComponentType = async (
  componentTypeId: number,
  data: { typeCode: string; label: string },
  database?: DbOrTx,
) => {
  const next = {
    typeCode: normalizeRequired(data.typeCode, "Type code"),
    label: normalizeRequired(data.label, "Type label"),
  };
  const renamed = await updateComponentTypeById(componentTypeId, next, database);
  if (!renamed) throw new Error("Component type does not exist");
  return renamed;
};

// catalog delete: refuse while branches reference the type
export const deleteComponentType = async (componentTypeId: number, database?: DbOrTx) => {
  const inUse = await listMainComponentTypeRecordsByComponentTypeId(componentTypeId, database);
  if (inUse.length > 0) {
    throw new AppError(409, "wrong_state", "Type is in use by main components");
  }
  return deleteComponentTypeById(componentTypeId, database);
};

/* ---------- component code ---------- */
export const createComponentCode = async (
  data: CreateComponentCodeInput,
  database?: DbOrTx,
) =>
  createComponentCodeRecord(
    {
      mainComponentTypeId: data.mainComponentTypeId,
      code: normalizeRequired(data.code, "Component code"),
      label: normalizeOptional(data.label),
      displayOrder: data.displayOrder ?? 0,
    },
    database,
  );

export const getComponentCodeById = (componentCodeId: number, database?: DbOrTx) =>
  findComponentCodeById(componentCodeId, database);

export const updateComponentCode = async (
  componentCodeId: number,
  data: Partial<{ code: string; label?: string | null; displayOrder: number }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateComponentCodeById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Component code");
  if (data.label !== undefined) next.label = normalizeOptional(data.label);
  if (data.displayOrder !== undefined) next.displayOrder = data.displayOrder;
  return updateComponentCodeById(componentCodeId, next, database);
};

export const deleteComponentCode = (componentCodeId: number, database?: DbOrTx) =>
  deleteComponentCodeById(componentCodeId, database);

/* ---------- convenience single-parent lists ---------- */
export const listTaskCodesByGroupId = (taskGroupId: number, database?: DbOrTx) =>
  listTaskCodeRecordsByTaskGroupId(taskGroupId, database);

export const listMainComponentsByTaskCodeId = (taskCodeId: number, database?: DbOrTx) =>
  listMainComponentRecordsByTaskCodeId(taskCodeId, database);

export const listComponentCodesByTypeId = (mainComponentTypeId: number, database?: DbOrTx) =>
  listComponentCodeRecordsByMainComponentTypeId(mainComponentTypeId, database);
