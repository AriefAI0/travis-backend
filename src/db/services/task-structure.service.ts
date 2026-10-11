import type {
  TaskStructureDescriptionNode,
  TaskStructureNodeKind,
  TaskStructureTaskCodeNode,
  TaskStructureTaskGroupNode,
  TaskStructureTypeNode,
} from "../../types/api";
import { AppError } from "../../lib/error";
import { removeMediaKeys, removeMediaPrefix } from "../../lib/minio_storage/cleanup";
import { imageEvidenceLeaves } from "../../lib/minio_storage/paths";
import { db, type DbOrTx } from "../client";
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

/* ---------- task group ---------- */
export const createTaskGroup = async (data: CreateTaskGroupInput, database?: DbOrTx) =>
  createTaskGroupRecord(
    {
      projectId: data.projectId,
      code: normalizeRequired(data.code, "Group code"),
    },
    database,
  );

export const getTaskGroupById = (taskGroupId: number, database?: DbOrTx) =>
  findTaskGroupById(taskGroupId, database);

export const updateTaskGroup = async (
  taskGroupId: number,
  data: Partial<{ code: string }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateTaskGroupById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Group code");
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
    },
    database,
  );

export const getTaskCodeById = (taskCodeId: number, database?: DbOrTx) =>
  findTaskCodeById(taskCodeId, database);

export const updateTaskCode = async (
  taskCodeId: number,
  data: Partial<{ code: string }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateTaskCodeById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Task code");
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
    },
    database,
  );

export const getDescriptionById = (descriptionId: number, database?: DbOrTx) =>
  findDescriptionById(descriptionId, database);

export const updateDescription = async (
  descriptionId: number,
  data: Partial<{ label: string }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateDescriptionById>[1]> = {};
  if (data.label !== undefined) next.label = normalizeRequired(data.label, "Description");
  return updateDescriptionById(descriptionId, next, database);
};

export const deleteDescription = (descriptionId: number, database?: DbOrTx) =>
  deleteDescriptionById(descriptionId, database);

/* ---------- type (owned by one description) ---------- */
export const createType = async (data: CreateTypeInput, database?: DbOrTx) => {
  const code = normalizeRequired(data.code, "Type code");

  const existing = await findTypeByDescriptionIdAndCode(data.descriptionId, code, database);
  if (existing) {
    throw new AppError(409, "wrong_state", "That type code already exists under this description");
  }

  return createTypeRecord(
    {
      descriptionId: data.descriptionId,
      code,
    },
    database,
  );
};

export const getTypeById = (typeId: number, database?: DbOrTx) =>
  findTypeById(typeId, database);

// rename in place: stable id, the code changes
export const updateType = async (
  typeId: number,
  data: Partial<{ code: string }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updateTypeById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Type code");
  return updateTypeById(typeId, next, database);
};

export const deleteType = (typeId: number, database?: DbOrTx) =>
  deleteTypeById(typeId, database);

// project-wide type vocabulary for autocomplete: the distinct type codes
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
    },
    database,
  );

export const getPartCodeById = (partCodeId: number, database?: DbOrTx) =>
  findPartCodeById(partCodeId, database);

export const updatePartCode = async (
  partCodeId: number,
  data: Partial<{ code: string }>,
  database?: DbOrTx,
) => {
  const next: Partial<Parameters<typeof updatePartCodeById>[1]> = {};
  if (data.code !== undefined) next.code = normalizeRequired(data.code, "Part code");
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
export const previewTaskStructureDelete = async (
  nodes: TaskStructureNodeRef[],
  database?: DbOrTx,
): Promise<TaskStructureDeletePreview> =>
  (await collectSelectionFacts(await resolveSelection(nodes, database), database)).preview;

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
  database?: DbOrTx,
  force = false,
): Promise<TaskStructureDeletePreview> => {
  const resolved = await resolveSelection(nodes, database);
  const facts = await collectSelectionFacts(resolved, database);

  if (facts.preview.blocked) {
    throw new AppError(409, "wrong_state", facts.preview.reason ?? "selection is still live");
  }
  if (facts.preview.orphans > 0 && !force) {
    throw new AppError(409, "orphan_confirm_required", orphanReason(facts.preview.orphans));
  }

  // Deepest level first: deleting a parent cascades the rows below it, and a
  // later delete of those rows would find nothing left to return.
  const run = async (tx: DbOrTx) => {
    for (const id of resolved.selected.partCodeIds) await deletePartCodeById(id, tx);
    for (const id of resolved.selected.typeIds) await deleteTypeById(id, tx);
    for (const id of resolved.selected.descriptionIds) await deleteDescriptionById(id, tx);
    for (const id of resolved.selected.taskCodeIds) await deleteTaskCodeById(id, tx);
    for (const id of resolved.selected.taskGroupIds) await deleteTaskGroupById(id, tx);
  };

  await (database ? run(database) : db.transaction(run));

  // The rows are already gone, so a storage error logs and the delete still wins.
  for (const prefix of facts.ingestPrefixes) await removeMediaPrefix(prefix);
  await removeMediaKeys([...facts.imageKeys, ...facts.thumbnailKeys]);

  return facts.preview;
};
