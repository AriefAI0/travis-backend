// Archive, restore, and permanent removal over the seven tables that carry
// `archivedAt`. Archive is a state, not a table: a row keeps its data and
// leaves the active lists, because every list query already filters
// `archivedAt`.
//
// Source: travis-viewer-spec.md, "Archive".
// flow: node > its descendants, level by level > stamp every level > audit

import { and, asc, eq, ilike, inArray, isNotNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import type { Caller } from "../../lib/caller";
import { notFound } from "../../lib/error";
import {
  description,
  partCode,
  project,
  session,
  taskCode,
  taskGroup,
  type,
} from "../schema";
import { findDescriptionById } from "../repositories/description.repository";
import { findPartCodeById } from "../repositories/part-code.repository";
import { findSessionById } from "../repositories/session.repository";
import { findTaskCodeById } from "../repositories/task-code.repository";
import { findTaskGroupById } from "../repositories/task-group.repository";
import { findTypeById } from "../repositories/type.repository";
import type { Subject } from "../../lib/auth/permissions";
import { writeAudit } from "./audit.service";

// `result` carries the column but is NOT here: a result is removed directly,
// from the results table, with its evidence. It never passes the archive.
export const ARCHIVE_RESOURCES = [
  "project",
  "session",
  "taskGroup",
  "taskCode",
  "description",
  "type",
  "partCode",
] as const;
export type ArchiveResource = (typeof ARCHIVE_RESOURCES)[number];

export const isArchiveResource = (value: string): value is ArchiveResource =>
  (ARCHIVE_RESOURCES as readonly string[]).includes(value);

// A session may carry no name, so a label can be null.
type Labelled = { label: string | null };

type Resource = {
  subject: Subject;
  // the row's project, which is what the org check hangs on
  projectIdOf: (id: number, database: DbOrTx) => Promise<number | null>;
  list: (needle: string, limit: number, offset: number, database: DbOrTx) => Promise<Labelled[]>;
  count: (database: DbOrTx) => Promise<number>;
  rowsOf: (ids: number[], database: DbOrTx) => Promise<Labelled[]>;
  stamp: (ids: number[], value: Date | null, database: DbOrTx) => Promise<void>;
};

// The needle is a LIKE pattern; % and _ in it would widen the match.
const like = (needle: string) => `%${needle.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

const total = (rows: unknown[]) => rows.length;

export const ARCHIVE: Record<ArchiveResource, Resource> = {
  project: {
    subject: "Project",
    projectIdOf: async (id) => id,
    list: async (needle, limit, offset, database) =>
      database
        .select({ label: project.title })
        .from(project)
        .where(and(isNotNull(project.archivedAt), ilike(project.title, like(needle))))
        .orderBy(asc(project.projectId))
        .limit(limit)
        .offset(offset),
    count: async (database) =>
      total(await database.select().from(project).where(isNotNull(project.archivedAt))),
    rowsOf: async (ids, database) =>
      database.select({ label: project.title }).from(project).where(inArray(project.projectId, ids)),
    stamp: async (ids, value, database) => {
      await database.update(project).set({ archivedAt: value }).where(inArray(project.projectId, ids));
    },
  },
  session: {
    subject: "Session",
    projectIdOf: async (id, database) => (await findSessionById(id, database))?.projectId ?? null,
    list: async (needle, limit, offset, database) =>
      database
        .select({ label: session.name })
        .from(session)
        .where(and(isNotNull(session.archivedAt), ilike(session.name, like(needle))))
        .orderBy(asc(session.sessionId))
        .limit(limit)
        .offset(offset),
    count: async (database) =>
      total(await database.select().from(session).where(isNotNull(session.archivedAt))),
    rowsOf: async (ids, database) =>
      database.select({ label: session.name }).from(session).where(inArray(session.sessionId, ids)),
    stamp: async (ids, value, database) => {
      await database.update(session).set({ archivedAt: value }).where(inArray(session.sessionId, ids));
    },
  },
  taskGroup: {
    subject: "Structure",
    projectIdOf: async (id, database) => (await findTaskGroupById(id, database))?.projectId ?? null,
    list: async (needle, limit, offset, database) =>
      database
        .select({ label: taskGroup.code })
        .from(taskGroup)
        .where(and(isNotNull(taskGroup.archivedAt), ilike(taskGroup.code, like(needle))))
        .orderBy(asc(taskGroup.taskGroupId))
        .limit(limit)
        .offset(offset),
    count: async (database) =>
      total(await database.select().from(taskGroup).where(isNotNull(taskGroup.archivedAt))),
    rowsOf: async (ids, database) =>
      database
        .select({ label: taskGroup.code })
        .from(taskGroup)
        .where(inArray(taskGroup.taskGroupId, ids)),
    stamp: async (ids, value, database) => {
      await database
        .update(taskGroup)
        .set({ archivedAt: value })
        .where(inArray(taskGroup.taskGroupId, ids));
    },
  },
  taskCode: {
    subject: "Structure",
    projectIdOf: async (id, database) => {
      const row = await findTaskCodeById(id, database);
      return row ? ((await findTaskGroupById(row.taskGroupId, database))?.projectId ?? null) : null;
    },
    list: async (needle, limit, offset, database) =>
      database
        .select({ label: taskCode.code })
        .from(taskCode)
        .where(and(isNotNull(taskCode.archivedAt), ilike(taskCode.code, like(needle))))
        .orderBy(asc(taskCode.taskCodeId))
        .limit(limit)
        .offset(offset),
    count: async (database) =>
      total(await database.select().from(taskCode).where(isNotNull(taskCode.archivedAt))),
    rowsOf: async (ids, database) =>
      database
        .select({ label: taskCode.code })
        .from(taskCode)
        .where(inArray(taskCode.taskCodeId, ids)),
    stamp: async (ids, value, database) => {
      await database
        .update(taskCode)
        .set({ archivedAt: value })
        .where(inArray(taskCode.taskCodeId, ids));
    },
  },
  description: {
    subject: "Structure",
    projectIdOf: async (id, database) => {
      const row = await findDescriptionById(id, database);
      return row ? projectIdOfTaskCode(row.taskCodeId, database) : null;
    },
    list: async (needle, limit, offset, database) =>
      database
        .select({ label: description.label })
        .from(description)
        .where(and(isNotNull(description.archivedAt), ilike(description.label, like(needle))))
        .orderBy(asc(description.descriptionId))
        .limit(limit)
        .offset(offset),
    count: async (database) =>
      total(await database.select().from(description).where(isNotNull(description.archivedAt))),
    rowsOf: async (ids, database) =>
      database
        .select({ label: description.label })
        .from(description)
        .where(inArray(description.descriptionId, ids)),
    stamp: async (ids, value, database) => {
      await database
        .update(description)
        .set({ archivedAt: value })
        .where(inArray(description.descriptionId, ids));
    },
  },
  type: {
    subject: "Structure",
    projectIdOf: async (id, database) => {
      const row = await findTypeById(id, database);
      if (!row) return null;
      const parent = await findDescriptionById(row.descriptionId, database);
      return parent ? projectIdOfTaskCode(parent.taskCodeId, database) : null;
    },
    list: async (needle, limit, offset, database) =>
      database
        .select({ label: type.code })
        .from(type)
        .where(and(isNotNull(type.archivedAt), ilike(type.code, like(needle))))
        .orderBy(asc(type.typeId))
        .limit(limit)
        .offset(offset),
    count: async (database) =>
      total(await database.select().from(type).where(isNotNull(type.archivedAt))),
    rowsOf: async (ids, database) =>
      database.select({ label: type.code }).from(type).where(inArray(type.typeId, ids)),
    stamp: async (ids, value, database) => {
      await database.update(type).set({ archivedAt: value }).where(inArray(type.typeId, ids));
    },
  },
  partCode: {
    subject: "Structure",
    projectIdOf: async (id, database) => {
      const row = await findPartCodeById(id, database);
      if (!row) return null;
      const parent = await findTypeById(row.typeId, database);
      if (!parent) return null;
      const grandparent = await findDescriptionById(parent.descriptionId, database);
      return grandparent ? projectIdOfTaskCode(grandparent.taskCodeId, database) : null;
    },
    list: async (needle, limit, offset, database) =>
      database
        .select({ label: partCode.code })
        .from(partCode)
        .where(and(isNotNull(partCode.archivedAt), ilike(partCode.code, like(needle))))
        .orderBy(asc(partCode.partCodeId))
        .limit(limit)
        .offset(offset),
    count: async (database) =>
      total(await database.select().from(partCode).where(isNotNull(partCode.archivedAt))),
    rowsOf: async (ids, database) =>
      database
        .select({ label: partCode.code })
        .from(partCode)
        .where(inArray(partCode.partCodeId, ids)),
    stamp: async (ids, value, database) => {
      await database
        .update(partCode)
        .set({ archivedAt: value })
        .where(inArray(partCode.partCodeId, ids));
    },
  },
};

const projectIdOfTaskCode = async (taskCodeId: number, database: DbOrTx) => {
  const code = await findTaskCodeById(taskCodeId, database);
  return code ? ((await findTaskGroupById(code.taskGroupId, database))?.projectId ?? null) : null;
};

/* ---------- the walk ---------- */

// Table key -> the ids of every row the node owns, per table.
type Subtree = Partial<Record<ArchiveResource, number[]>>;

// Each edge has its own query: the chain is fixed and short, and one edge's
// ids are never another edge's ids.
const childrenOf: Record<
  ArchiveResource,
  (ids: number[], database: DbOrTx) => Promise<Array<[ArchiveResource, number[]]>>
> = {
  project: async (ids, database) => [
    [
      "taskGroup",
      (
        await database
          .select({ id: taskGroup.taskGroupId })
          .from(taskGroup)
          .where(inArray(taskGroup.projectId, ids))
      ).map((row) => row.id),
    ],
    [
      "session",
      (
        await database
          .select({ id: session.sessionId })
          .from(session)
          .where(inArray(session.projectId, ids))
      ).map((row) => row.id),
    ],
  ],
  session: async () => [],
  taskGroup: async (ids, database) => [
    [
      "taskCode",
      (
        await database
          .select({ id: taskCode.taskCodeId })
          .from(taskCode)
          .where(inArray(taskCode.taskGroupId, ids))
      ).map((row) => row.id),
    ],
  ],
  taskCode: async (ids, database) => [
    [
      "description",
      (
        await database
          .select({ id: description.descriptionId })
          .from(description)
          .where(inArray(description.taskCodeId, ids))
      ).map((row) => row.id),
    ],
  ],
  description: async (ids, database) => [
    [
      "type",
      (
        await database
          .select({ id: type.typeId })
          .from(type)
          .where(inArray(type.descriptionId, ids))
      ).map((row) => row.id),
    ],
  ],
  type: async (ids, database) => [
    [
      "partCode",
      (
        await database
          .select({ id: partCode.partCodeId })
          .from(partCode)
          .where(inArray(partCode.typeId, ids))
      ).map((row) => row.id),
    ],
  ],
  partCode: async () => [],
};

// flow: node > child ids per edge > repeat while a level returns rows
const collectSubtree = async (
  resource: ArchiveResource,
  id: number,
  database: DbOrTx,
): Promise<Subtree> => {
  const tree: Subtree = { [resource]: [id] };
  let frontier: Array<{ resource: ArchiveResource; ids: number[] }> = [
    { resource, ids: [id] },
  ];

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const level of frontier) {
      for (const [child, ids] of await childrenOf[level.resource](level.ids, database)) {
        if (ids.length === 0) continue;
        tree[child] = [...(tree[child] ?? []), ...ids];
        next.push({ resource: child, ids });
      }
    }
    frontier = next;
  }

  return tree;
};

// The org check: the row's project must be the caller's. A row in another org
// reads as absent, so an id can never be probed.
const scopedSubtree = async (
  resource: ArchiveResource,
  id: number,
  caller: Caller,
  database: DbOrTx,
): Promise<Subtree> => {
  const projectId = await ARCHIVE[resource].projectIdOf(id, database);
  if (projectId === null) throw notFound(resource);

  const owner = await database.query.project.findFirst({
    where: and(eq(project.projectId, projectId), eq(project.organizationId, caller.organizationId)),
  });
  if (!owner) throw notFound(resource);

  return collectSubtree(resource, id, database);
};

/* ---------- archive and restore ---------- */

// flow: subtree > stamp every level > audit — one tx
const stamp = async (
  resource: ArchiveResource,
  id: number,
  caller: Caller,
  value: Date | null,
  action: "archive" | "restore",
  database?: DbOrTx,
) => {
  const run = async (tx: DbOrTx) => {
    const tree = await scopedSubtree(resource, id, caller, tx);
    const before = await ARCHIVE[resource].rowsOf([id], tx);

    for (const [key, ids] of Object.entries(tree) as Array<[ArchiveResource, number[]]>) {
      await ARCHIVE[key].stamp(ids, value, tx);
    }

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action,
        resourceType: resource,
        resourceId: id,
        before: before[0] ?? null,
        after: { archivedAt: value ? value.toISOString() : null, rows: tree },
      },
      tx,
    );

    return tree;
  };

  return database ? run(database) : db.transaction(run);
};

export const archiveRow = (
  resource: ArchiveResource,
  id: number,
  caller: Caller,
  database?: DbOrTx,
) => stamp(resource, id, caller, new Date(), "archive", database);

export const restoreRow = (
  resource: ArchiveResource,
  id: number,
  caller: Caller,
  database?: DbOrTx,
) => stamp(resource, id, caller, null, "restore", database);

/* ---------- browse ---------- */

export type ArchiveQuery = {
  resource?: ArchiveResource;
  search: string;
  limit: number;
  offset: number;
};

export type ArchiveEntry = {
  resource: ArchiveResource;
  total: number;
  rows: Labelled[];
};

// The archived rows of one resource, or of every resource the caller may read.
export const listArchive = async (
  query: ArchiveQuery,
  readable: (subject: Subject) => boolean,
  database?: DbOrTx,
): Promise<ArchiveEntry[]> => {
  const wanted = query.resource
    ? [query.resource]
    : ARCHIVE_RESOURCES.filter((resource) => readable(ARCHIVE[resource].subject));

  const entries: ArchiveEntry[] = [];
  for (const resource of wanted) {
    // a named resource the caller cannot read is a refusal, not an empty list
    if (!readable(ARCHIVE[resource].subject)) {
      throw notFound(resource);
    }

    entries.push({
      resource,
      total: await ARCHIVE[resource].count(database ?? db),
      rows: await ARCHIVE[resource].list(query.search, query.limit, query.offset, database ?? db),
    });
  }

  return entries;
};

/* ---------- permanent removal ---------- */

// What a removal takes, counted before anything is deleted. The same walk
// serves the preview and the delete, so the two cannot disagree.
export const removalCounts = async (
  resource: ArchiveResource,
  id: number,
  caller: Caller,
  database?: DbOrTx,
): Promise<Record<string, number>> => {
  const tree = await scopedSubtree(resource, id, caller, database ?? db);
  return countsOf(tree);
};

const countsOf = (tree: Subtree) =>
  Object.fromEntries(Object.entries(tree).map(([key, ids]) => [key, ids.length]));

// flow: subtree > delete deepest level first > audit — one tx
export const removeArchived = async (
  resource: ArchiveResource,
  id: number,
  caller: Caller,
  database?: DbOrTx,
): Promise<Record<string, number>> => {
  const run = async (tx: DbOrTx) => {
    const tree = await scopedSubtree(resource, id, caller, tx);
    const before = await ARCHIVE[resource].rowsOf([id], tx);

    // Deepest first: the child rows carry the foreign keys.
    const order = [...ARCHIVE_RESOURCES].reverse().filter((key) => tree[key]?.length);
    for (const key of order) {
      await deleteRows(key, tree[key]!, tx);
    }

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "remove",
        resourceType: resource,
        resourceId: id,
        before: before[0] ?? null,
        after: { rows: tree },
      },
      tx,
    );

    return countsOf(tree);
  };

  return database ? run(database) : db.transaction(run);
};

// One switch for the deletes, mirroring the stamps above.
const deleteRows = async (resource: ArchiveResource, ids: number[], database: DbOrTx) => {
  switch (resource) {
    case "project":
      await database.delete(project).where(inArray(project.projectId, ids));
      return;
    case "session":
      await database.delete(session).where(inArray(session.sessionId, ids));
      return;
    case "taskGroup":
      await database.delete(taskGroup).where(inArray(taskGroup.taskGroupId, ids));
      return;
    case "taskCode":
      await database.delete(taskCode).where(inArray(taskCode.taskCodeId, ids));
      return;
    case "description":
      await database.delete(description).where(inArray(description.descriptionId, ids));
      return;
    case "type":
      await database.delete(type).where(inArray(type.typeId, ids));
      return;
    case "partCode":
      await database.delete(partCode).where(inArray(partCode.partCodeId, ids));
  }
};
