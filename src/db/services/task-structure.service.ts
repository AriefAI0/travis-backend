import type {
  TaskStructureDescriptionNode,
  TaskStructureNodeKind,
  TaskStructureTaskCodeNode,
  TaskStructureTaskGroupNode,
  TaskStructureTypeNode,
} from "../../types/api";
import { AppError, notFound } from "../../lib/error";
import type { Caller } from "../../lib/caller";
import type { StructureLevel } from "../../lib/auth/permissions";
import { removeMediaKeys, removeMediaPrefix } from "../../lib/minio_storage/cleanup";
import { imageEvidenceLeaves } from "../../lib/minio_storage/paths";
import { db, type DbOrTx } from "../client";
import { findProjectById, findProjectByIdInternal } from "../repositories/project.repository";
import { writeAudit, type AuditAction } from "./audit.service";
import { listIngestRecordsByClipIds } from "../repositories/recording-ingest.repository";
import { ingestLeaseAlive } from "../../lib/ingest_lease";
import {
  listAllResultRecordsByTargetIds,
  listOpenResultRecordsByTargetIds,
} from "../repositories/result.repository";
import { listResultImageRecordsByResultIds } from "../repositories/result-image.repository";
import { listVideoClipRecordsByResultIds } from "../repositories/video-clip.repository";
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
};

export type CreateTaskCodeInput = {
  taskGroupId: number;
  code: string;
};

export type CreateDescriptionInput = {
  taskCodeId: number;
  label: string;
};

export type CreateTypeInput = {
  descriptionId: number;
  code: string;
};

export type CreatePartCodeInput = {
  typeId: number;
  code: string;
};

const normalizeRequired = (value: string, fieldName: string) => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${fieldName} is required`);
  return trimmed;
};

/* ---------- tree read (batched: 5 queries for the whole project) ---------- */
export const listProjectTaskStructureTree = async (
  projectId: number,
  caller: Caller,
  database?: DbOrTx,
): Promise<TaskStructureTaskGroupNode[]> => {
  // a project in another org has no tree to show
  if (!(await findProjectById(projectId, caller.organizationId, database))) return [];

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
      partCodes: (partCodesByType.get(typeRow.typeId) ?? []).map((part) => ({
        partCodeId: part.partCodeId,
        code: part.code,
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
      descriptions: descriptionsByTaskCode.get(taskCode.taskCodeId) ?? [],
    };
    const bucket = codesByGroup.get(taskCode.taskGroupId) ?? [];
    bucket.push(node);
    codesByGroup.set(taskCode.taskGroupId, bucket);
  }

  return groups.map((group) => ({
    taskGroupId: group.taskGroupId,
    code: group.code,
    taskCodes: codesByGroup.get(group.taskGroupId) ?? [],
  }));
};

/* ---------- org scoping ---------- */
// Every node hangs off a project, and the project carries the org. A node
// resolves its project by walking up the chain rather than denormalising the
// org onto five tables.
// flow: node id > parent chain > project id
const projectIdOfGroup = async (taskGroupId: number, database: DbOrTx) =>
  (await findTaskGroupById(taskGroupId, database))?.projectId ?? null;

const projectIdOfTaskCode = async (taskCodeId: number, database: DbOrTx) => {
  const row = await findTaskCodeById(taskCodeId, database);
  return row ? projectIdOfGroup(row.taskGroupId, database) : null;
};

const projectIdOfDescription = async (descriptionId: number, database: DbOrTx) => {
  const row = await findDescriptionById(descriptionId, database);
  return row ? projectIdOfTaskCode(row.taskCodeId, database) : null;
};

const projectIdOfType = async (typeId: number, database: DbOrTx) => {
  const row = await findTypeById(typeId, database);
  return row ? projectIdOfDescription(row.descriptionId, database) : null;
};

const projectIdOfPartCode = async (partCodeId: number, database: DbOrTx) => {
  const row = await findPartCodeById(partCodeId, database);
  return row ? projectIdOfType(row.typeId, database) : null;
};

const PROJECT_OF: Record<StructureLevel, (id: number, database: DbOrTx) => Promise<number | null>> = {
  // a project is its own owner
  project: async (id) => id,
  taskGroup: projectIdOfGroup,
  taskCode: projectIdOfTaskCode,
  description: projectIdOfDescription,
  type: projectIdOfType,
  partCode: projectIdOfPartCode,
};

// The project a result target hangs off, for features that scope by target id
// rather than by node id. Exactly one of the two ids is set.
// flow: target > chain > project id
export const projectIdOfTarget = async (
  target: { descriptionId?: number | null; partCodeId?: number | null },
  database: DbOrTx,
): Promise<number | null> => {
  if (target.descriptionId !== undefined && target.descriptionId !== null) {
    return projectIdOfDescription(target.descriptionId, database);
  }
  if (target.partCodeId !== undefined && target.partCodeId !== null) {
    return projectIdOfPartCode(target.partCodeId, database);
  }
  return null;
};

// The row at each level, for the audit trail's before-value.
const READ_AT: Record<StructureLevel, (id: number, database: DbOrTx) => Promise<unknown>> = {
  project: (id, database) => findProjectByIdInternal(id, database),
  taskGroup: findTaskGroupById,
  taskCode: findTaskCodeById,
  description: findDescriptionById,
  type: findTypeById,
  partCode: findPartCodeById,
};

export type ScopedWrite = {
  action: AuditAction;
  resourceType: string;
};

// flow: node > owning project > org check > the write > audit, one transaction
// A node in another org reads as absent, never as forbidden: the id must not
// be probeable. The check and the write share a transaction, so nothing can
// slip between them.
const writeAsCaller = async <T>(
  level: StructureLevel,
  nodeId: number,
  caller: Caller,
  entry: ScopedWrite,
  run: (tx: DbOrTx) => Promise<T | null>,
  database?: DbOrTx,
): Promise<T | null> => {
  const attempt = async (tx: DbOrTx) => {
    const projectId = await PROJECT_OF[level](nodeId, tx);
    if (projectId === null) return null;
    if (!(await findProjectById(projectId, caller.organizationId, tx))) return null;

    const before = await READ_AT[level](nodeId, tx);
    const result = await run(tx);
    if (result === null || result === undefined) return null;

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: nodeId,
        before: entry.action === "remove" ? before : undefined,
        after: entry.action === "remove" ? undefined : result,
      },
      tx,
    );

    return result;
  };

  return database ? attempt(database) : db.transaction(attempt);
};

// A create has no node to resolve, so it checks the parent it hangs off.
// A missing or foreign parent throws 404 rather than returning null: a create
// route has no null to check, and a 500 would leak that the id exists elsewhere.
const createAsCaller = async <T>(
  parentLevel: StructureLevel,
  parentId: number,
  caller: Caller,
  entry: ScopedWrite,
  run: (tx: DbOrTx) => Promise<T | null>,
  database?: DbOrTx,
): Promise<T | null> => {
  const attempt = async (tx: DbOrTx) => {
    const projectId = await PROJECT_OF[parentLevel](parentId, tx);
    const parentInOrg =
      projectId !== null && (await findProjectById(projectId, caller.organizationId, tx));

    if (!parentInOrg) {
      throw notFound(`The parent ${parentLevel} for this ${entry.resourceType}`);
    }

    const created = await run(tx);
    if (created === null) return null;

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: nodeIdOf(created),
        after: created,
      },
      tx,
    );

    return created;
  };

  return database ? attempt(database) : db.transaction(attempt);
};

// Every created row exposes one identity column, named after its level.
const nodeIdOf = (row: unknown): number | null => {
  const record = row as Record<string, number | undefined>;
  return (
    record.taskGroupId ??
    record.taskCodeId ??
    record.descriptionId ??
    record.typeId ??
    record.partCodeId ??
    null
  );
};

/* ---------- task group ---------- */
export const createTaskGroup = async (
  data: CreateTaskGroupInput,
  caller: Caller,
  database?: DbOrTx,
) =>
  createAsCaller(
    "project",
    data.projectId,
    caller,
    { action: "create", resourceType: "TaskGroup" },
    (tx) =>
      createTaskGroupRecord(
        { projectId: data.projectId, code: normalizeRequired(data.code, "Group code") },
        tx,
      ),
    database,
  );

export const getTaskGroupById = async (
  taskGroupId: number,
  caller: Caller,
  database?: DbOrTx,
) => {
  const projectId = await PROJECT_OF.taskGroup(taskGroupId, database ?? db);
  if (projectId === null) return null;
  if (!(await findProjectById(projectId, caller.organizationId, database))) return null;
  return findTaskGroupById(taskGroupId, database);
};

export const updateTaskGroup = async (
  taskGroupId: number,
  data: Partial<{ code: string }>,
  caller: Caller,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateTaskGroupById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Group code");

  return writeAsCaller(
    "taskGroup",
    taskGroupId,
    caller,
    { action: "modify", resourceType: "TaskGroup" },
    (tx) => updateTaskGroupById(taskGroupId, next, tx),
    database,
  );
};

export const deleteTaskGroup = (taskGroupId: number, caller: Caller, database?: DbOrTx) =>
  writeAsCaller(
    "taskGroup",
    taskGroupId,
    caller,
    { action: "remove", resourceType: "TaskGroup" },
    (tx) => deleteTaskGroupById(taskGroupId, tx),
    database,
  );

/* ---------- task code ---------- */
export const createTaskCode = async (
  data: CreateTaskCodeInput,
  caller: Caller,
  database?: DbOrTx,
) =>
  createAsCaller(
    "taskGroup",
    data.taskGroupId,
    caller,
    { action: "create", resourceType: "TaskCode" },
    (tx) =>
      createTaskCodeRecord(
        { taskGroupId: data.taskGroupId, code: normalizeRequired(data.code, "Task code") },
        tx,
      ),
    database,
  );

export const getTaskCodeById = async (
  taskCodeId: number,
  caller: Caller,
  database?: DbOrTx,
) => {
  const projectId = await PROJECT_OF.taskCode(taskCodeId, database ?? db);
  if (projectId === null) return null;
  if (!(await findProjectById(projectId, caller.organizationId, database))) return null;
  return findTaskCodeById(taskCodeId, database);
};

export const updateTaskCode = async (
  taskCodeId: number,
  data: Partial<{ code: string }>,
  caller: Caller,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateTaskCodeById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Task code");

  return writeAsCaller(
    "taskCode",
    taskCodeId,
    caller,
    { action: "modify", resourceType: "TaskCode" },
    (tx) => updateTaskCodeById(taskCodeId, next, tx),
    database,
  );
};

export const deleteTaskCode = (taskCodeId: number, caller: Caller, database?: DbOrTx) =>
  writeAsCaller(
    "taskCode",
    taskCodeId,
    caller,
    { action: "remove", resourceType: "TaskCode" },
    (tx) => deleteTaskCodeById(taskCodeId, tx),
    database,
  );

/* ---------- description ---------- */
export const createDescription = async (
  data: CreateDescriptionInput,
  caller: Caller,
  database?: DbOrTx,
) =>
  createAsCaller(
    "taskCode",
    data.taskCodeId,
    caller,
    { action: "create", resourceType: "Description" },
    (tx) =>
      createDescriptionRecord(
        { taskCodeId: data.taskCodeId, label: normalizeRequired(data.label, "Description") },
        tx,
      ),
    database,
  );

export const getDescriptionById = async (
  descriptionId: number,
  caller: Caller,
  database?: DbOrTx,
) => {
  const projectId = await PROJECT_OF.description(descriptionId, database ?? db);
  if (projectId === null) return null;
  if (!(await findProjectById(projectId, caller.organizationId, database))) return null;
  return findDescriptionById(descriptionId, database);
};

export const updateDescription = async (
  descriptionId: number,
  data: Partial<{ label: string }>,
  caller: Caller,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateDescriptionById>[1]> = {};
  if (data.label !== undefined) next.label = normalizeRequired(data.label, "Description");

  return writeAsCaller(
    "description",
    descriptionId,
    caller,
    { action: "modify", resourceType: "Description" },
    (tx) => updateDescriptionById(descriptionId, next, tx),
    database,
  );
};

export const deleteDescription = (
  descriptionId: number,
  caller: Caller,
  database?: DbOrTx,
) =>
  writeAsCaller(
    "description",
    descriptionId,
    caller,
    { action: "remove", resourceType: "Description" },
    (tx) => deleteDescriptionById(descriptionId, tx),
    database,
  );

/* ---------- type (owned by one description) ---------- */
export const createType = async (
  data: CreateTypeInput,
  caller: Caller,
  database?: DbOrTx,
) => {
  const code = normalizeRequired(data.code, "Type code");

  return createAsCaller(
    "description",
    data.descriptionId,
    caller,
    { action: "create", resourceType: "Type" },
    async (tx) => {
      const existing = await findTypeByDescriptionIdAndCode(data.descriptionId, code, tx);
      if (existing) {
        throw new AppError(
          409,
          "wrong_state",
          "That type code already exists under this description",
        );
      }
      return createTypeRecord({ descriptionId: data.descriptionId, code }, tx);
    },
    database,
  );
};

export const getTypeById = async (typeId: number, caller: Caller, database?: DbOrTx) => {
  const projectId = await PROJECT_OF.type(typeId, database ?? db);
  if (projectId === null) return null;
  if (!(await findProjectById(projectId, caller.organizationId, database))) return null;
  return findTypeById(typeId, database);
};

// rename in place: stable id, the code changes
export const updateType = async (
  typeId: number,
  data: Partial<{ code: string }>,
  caller: Caller,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateTypeById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Type code");

  return writeAsCaller(
    "type",
    typeId,
    caller,
    { action: "modify", resourceType: "Type" },
    (tx) => updateTypeById(typeId, next, tx),
    database,
  );
};

export const deleteType = (typeId: number, caller: Caller, database?: DbOrTx) =>
  writeAsCaller(
    "type",
    typeId,
    caller,
    { action: "remove", resourceType: "Type" },
    (tx) => deleteTypeById(typeId, tx),
    database,
  );

// project-wide type vocabulary for autocomplete: the distinct type codes
export const listTypeCatalog = async (
  projectId: number,
  caller: Caller,
  database?: DbOrTx,
) => {
  if (!(await findProjectById(projectId, caller.organizationId, database))) return [];
  return listTypeCatalogByProjectId(projectId, database);
};

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
  caller: Caller,
  database?: DbOrTx,
) =>
  createAsCaller(
    "type",
    data.typeId,
    caller,
    { action: "create", resourceType: "PartCode" },
    (tx) =>
      createPartCodeRecord(
        { typeId: data.typeId, code: normalizeRequired(data.code, "Part code") },
        tx,
      ),
    database,
  );

export const getPartCodeById = async (
  partCodeId: number,
  caller: Caller,
  database?: DbOrTx,
) => {
  const projectId = await PROJECT_OF.partCode(partCodeId, database ?? db);
  if (projectId === null) return null;
  if (!(await findProjectById(projectId, caller.organizationId, database))) return null;
  return findPartCodeById(partCodeId, database);
};

export const updatePartCode = async (
  partCodeId: number,
  data: Partial<{ code: string }>,
  caller: Caller,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updatePartCodeById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Part code");

  return writeAsCaller(
    "partCode",
    partCodeId,
    caller,
    { action: "modify", resourceType: "PartCode" },
    (tx) => updatePartCodeById(partCodeId, next, tx),
    database,
  );
};

export const deletePartCode = (partCodeId: number, caller: Caller, database?: DbOrTx) =>
  writeAsCaller(
    "partCode",
    partCodeId,
    caller,
    { action: "remove", resourceType: "PartCode" },
    (tx) => deletePartCodeById(partCodeId, tx),
    database,
  );

/* ---------- convenience single-parent lists ---------- */
export const listTaskCodesByGroupId = (taskGroupId: number, database?: DbOrTx) =>
  listTaskCodeRecordsByTaskGroupId(taskGroupId, database);

export const listDescriptionsByTaskCodeId = (taskCodeId: number, database?: DbOrTx) =>
  listDescriptionRecordsByTaskCodeId(taskCodeId, database);

export const listPartCodesByTypeId = (typeId: number, database?: DbOrTx) =>
  listPartCodeRecordsByTypeId(typeId, database);

/* ---------- bulk delete: preview, then one transaction ---------- */

export type TaskStructureNodeRef = { kind: TaskStructureNodeKind; id: number };

// What the confirm dialog shows. Counts are what a cascade removes, so they
// describe the damage before anything happens.
export type TaskStructureDeletePreview = {
  // node rows below the selection; the selected rows themselves are not counted
  children: number;
  results: number;
  clips: number;
  images: number;
  // true while a capture is actually on the wire under the selection — the one
  // refusal a force cannot relax
  blocked: boolean;
  // Open inspections whose capture is not alive: unfinished work with no
  // recorder behind it. Discardable, but only on an explicit confirm.
  orphans: number;
  reason: string | null;
};

type IdsByLevel = {
  taskGroupIds: number[];
  taskCodeIds: number[];
  descriptionIds: number[];
  typeIds: number[];
  partCodeIds: number[];
};

// `selected` is what the user picked, `all` is everything the cascade reaches.
// The delete targets `selected`; counts and media keys need `all`.
type ResolvedSelection = { selected: IdsByLevel; all: IdsByLevel };

const unique = (values: number[]): number[] => [...new Set(values)];

const totalIds = (ids: IdsByLevel): number =>
  ids.taskGroupIds.length +
  ids.taskCodeIds.length +
  ids.descriptionIds.length +
  ids.typeIds.length +
  ids.partCodeIds.length;

// A group owns its task codes, a task code its descriptions, a description its
// types, a type its part codes — so the walk only ever goes down.
// flow: selected ids > walk each level down > selected + reachable ids
const resolveSelection = async (
  nodes: TaskStructureNodeRef[],
  database?: DbOrTx,
): Promise<ResolvedSelection> => {
  const pick = (kind: TaskStructureNodeKind): number[] =>
    unique(nodes.filter((node) => node.kind === kind).map((node) => node.id));

  const selected: IdsByLevel = {
    taskGroupIds: pick("task_group"),
    taskCodeIds: pick("task_code"),
    descriptionIds: pick("description"),
    typeIds: pick("type"),
    partCodeIds: pick("part_code"),
  };

  const codesUnderGroups = await listTaskCodeRecordsByTaskGroupIds(
    selected.taskGroupIds,
    database,
  );
  const taskCodeIds = unique([
    ...selected.taskCodeIds,
    ...codesUnderGroups.map((row) => row.taskCodeId),
  ]);

  const descriptionsUnderCodes = await listDescriptionRecordsByTaskCodeIds(
    taskCodeIds,
    database,
  );
  const descriptionIds = unique([
    ...selected.descriptionIds,
    ...descriptionsUnderCodes.map((row) => row.descriptionId),
  ]);

  const typesUnderDescriptions = await listTypeRecordsByDescriptionIds(
    descriptionIds,
    database,
  );
  const typeIds = unique([
    ...selected.typeIds,
    ...typesUnderDescriptions.map((row) => row.typeId),
  ]);

  const partsUnderTypes = await listPartCodeRecordsByTypeIds(typeIds, database);
  const partCodeIds = unique([
    ...selected.partCodeIds,
    ...partsUnderTypes.map((row) => row.partCodeId),
  ]);

  return {
    selected,
    all: {
      taskGroupIds: selected.taskGroupIds,
      taskCodeIds,
      descriptionIds,
      typeIds,
      partCodeIds,
    },
  };
};

type SelectionFacts = {
  preview: TaskStructureDeletePreview;
  // exact leaves a row stores itself
  imageKeys: string[];
  thumbnailKeys: string[];
  // directories an ingest wrote into: segments, poster and evidence images
  ingestPrefixes: string[];
};

// flow: resolved ids > results > clips + images + ingests > counts, keys, block flag
const collectSelectionFacts = async (
  resolved: ResolvedSelection,
  database?: DbOrTx,
): Promise<SelectionFacts> => {
  const { descriptionIds, partCodeIds } = resolved.all;

  const results = await listAllResultRecordsByTargetIds(descriptionIds, partCodeIds, database);
  const resultIds = results.map((row) => row.resultId);

  // Sequential on purpose: a caller can hand this a transaction, and a
  // transaction is one connection, so parallel reads would share it.
  const clips = await listVideoClipRecordsByResultIds(resultIds, database);
  const images = await listResultImageRecordsByResultIds(resultIds, database);
  const openResults = await listOpenResultRecordsByTargetIds(
    descriptionIds,
    partCodeIds,
    database,
  );

  const ingestRows = await listIngestRecordsByClipIds(
    clips.map((clip) => clip.clipId),
    database,
  );

  // Split the open ones by lease: a fresh open ingest means a capture is writing
  // under the selection right now; a stale one is a leftover the sweep will close.
  const liveIngests = ingestRows.filter(
    (row) => row.closedAt === null && ingestLeaseAlive(row),
  );
  const liveClipIds = new Set(liveIngests.map((row) => row.clipId));
  const liveResultIds = new Set(
    clips.filter((clip) => liveClipIds.has(clip.clipId)).map((clip) => clip.resultId),
  );
  // An open inspection with no live capture behind it: the recorder stopped, the
  // work never got submitted, and nothing will finish it but a person.
  const orphans = openResults.filter((row) => !liveResultIds.has(row.resultId)).length;
  const blocked = liveIngests.length > 0;

  // raw and annotated twins; the annotated leaf is only there when it was written
  const imageKeys = images.flatMap((row) => {
    const leaves = imageEvidenceLeaves(row.storageStem, row.imageId, row.contentType);
    return row.hasAnnotated ? [leaves.raw.key, leaves.annotated.key] : [leaves.raw.key];
  });

  return {
    preview: {
      children: totalIds(resolved.all) - totalIds(resolved.selected),
      results: results.length,
      clips: clips.length,
      images: images.length,
      blocked,
      orphans,
      reason: blocked
        ? `${liveIngests.length} recording${liveIngests.length === 1 ? "" : "s"} still being written`
        : orphans > 0
          ? orphanReason(orphans)
          : null,
    },
    imageKeys,
    thumbnailKeys: clips
      .map((clip) => clip.thumbnailKey)
      .filter((key): key is string => key !== null && key.length > 0),
    ingestPrefixes: ingestRows.map((row) => row.keyPrefix),
  };
};

// Read-only: same walk the delete does, so the dialog never promises a
// different number than the delete delivers.
// The wire names the levels in snake_case; the service walks them in camelCase.
const LEVEL_OF_KIND: Record<TaskStructureNodeKind, StructureLevel> = {
  task_group: "taskGroup",
  task_code: "taskCode",
  description: "description",
  type: "type",
  part_code: "partCode",
};

// The node ids arrive from the client, so each one is resolved to its project
// and checked before anything is read or deleted. Descendants are not checked:
// they hang off the nodes checked here.
// flow: every named node > owning project > org check
const assertNodesInCallerOrg = async (
  nodes: TaskStructureNodeRef[],
  caller: Caller,
  database: DbOrTx,
): Promise<void> => {
  for (const node of nodes) {
    const level = LEVEL_OF_KIND[node.kind];
    const projectId = await PROJECT_OF[level](node.id, database);
    if (projectId === null) {
      throw notFound(`The selected ${node.kind.replace("_", " ")}`);
    }
    if (!(await findProjectById(projectId, caller.organizationId, database))) {
      throw notFound(`The selected ${node.kind.replace("_", " ")}`);
    }
  }
};

export const previewTaskStructureDelete = async (
  nodes: TaskStructureNodeRef[],
  caller: Caller,
  database?: DbOrTx,
): Promise<TaskStructureDeletePreview> => {
  if (database) {
    await assertNodesInCallerOrg(nodes, caller, database);
  } else {
    await db.transaction((tx) => assertNodesInCallerOrg(nodes, caller, tx));
  }

  return (await collectSelectionFacts(await resolveSelection(nodes, database), database)).preview;
};

// What the confirm dialog says before it discards unfinished work. Exported so
// the refusal and the preview can never drift apart.
export const orphanReason = (orphans: number): string =>
  `${orphans} unfinished inspection${orphans === 1 ? "" : "s"} stopped recording — they will be discarded with this delete`;

/**
 * A capture still writing under the selection refuses outright — force does not
 * reach it. Orphans refuse too, but only until the caller confirms: they are
 * cascaded away with the selection (result and clip FKs are onDelete cascade),
 * and their media is cleared after commit with every other prefix here.
 * flow: resolve > facts > live check > orphan confirm > one tx > remove objects
 */
export const deleteTaskStructureSelection = async (
  nodes: TaskStructureNodeRef[],
  caller: Caller,
  database?: DbOrTx,
  force = false,
): Promise<TaskStructureDeletePreview> => {
  if (database) {
    await assertNodesInCallerOrg(nodes, caller, database);
  } else {
    await db.transaction((tx) => assertNodesInCallerOrg(nodes, caller, tx));
  }

  const resolved = await resolveSelection(nodes, database);
  const facts = await collectSelectionFacts(resolved, database);

  if (facts.preview.blocked) {
    throw new AppError(409, "wrong_state", facts.preview.reason ?? "selection is still live");
  }
  if (facts.preview.orphans > 0 && !force) {
    throw new AppError(409, "orphan_confirm_required", orphanReason(facts.preview.orphans));
  }

  // Each removed node writes its own audit row, the one its single delete would
  // have written, so the change stream names what went.
  // flow: delete > audit on the same transaction
  const removeNode = async (
    tx: DbOrTx,
    resourceType: string,
    nodeId: number,
    remove: (id: number, tx: DbOrTx) => Promise<unknown>,
  ): Promise<void> => {
    const before = await remove(nodeId, tx);
    if (!before) return;

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "remove",
        resourceType,
        resourceId: nodeId,
        before,
      },
      tx,
    );
  };

  // Deepest level first: deleting a parent cascades the rows below it, and a
  // later delete of those rows would find nothing left to return.
  const run = async (tx: DbOrTx) => {
    for (const id of resolved.selected.partCodeIds) {
      await removeNode(tx, "PartCode", id, deletePartCodeById);
    }
    for (const id of resolved.selected.typeIds) {
      await removeNode(tx, "Type", id, deleteTypeById);
    }
    for (const id of resolved.selected.descriptionIds) {
      await removeNode(tx, "Description", id, deleteDescriptionById);
    }
    for (const id of resolved.selected.taskCodeIds) {
      await removeNode(tx, "TaskCode", id, deleteTaskCodeById);
    }
    for (const id of resolved.selected.taskGroupIds) {
      await removeNode(tx, "TaskGroup", id, deleteTaskGroupById);
    }
  };

  await (database ? run(database) : db.transaction(run));

  // The rows are already gone, so a storage error logs and the delete still wins.
  for (const prefix of facts.ingestPrefixes) await removeMediaPrefix(prefix);
  await removeMediaKeys([...facts.imageKeys, ...facts.thumbnailKeys]);

  return facts.preview;
};
