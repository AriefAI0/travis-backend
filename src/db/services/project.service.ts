import { db, type DbOrTx } from "../client";
import { AppError } from "../../lib/error";
import type { Caller } from "../../lib/caller";
import { removeMediaKeys, removeMediaPrefix } from "../../lib/minio_storage/cleanup";
import { imageEvidenceLeaves } from "../../lib/minio_storage/paths";
import { listProjectMediaTargets } from "../repositories/project-media.repository";
import { writeAudit } from "./audit.service";
import {

  createProjectRecord,
  findProjectById,
  deleteProjectById,
  listProjectRecords,
  listProjectDashboardRows,
  maxProjectDisplayNumber,
  updateProjectById,
} from "../repositories/project.repository";
import { project } from "../schema";

export type ProjectDashboardItem = {
  projectId: number;
  displayNumber: number;
  title: string;
  description: string | null;
  documentId: string | null;
  totalAssets: number;
  totalComponents: number;
  totalItems: number;
  completedItems: number;
  pendingItems: number;
  overallProgress: number;
};

export type CreateProjectInput = {
  title: string;
  description?: string | null;
  documentId?: string | null;
};

const calculateProgress = (completedItems: number, totalItems: number) => {
  if (totalItems === 0) {
    return 0;
  }

  return Math.round((completedItems / totalItems) * 100);
};

const normalizeOptionalText = (value?: string | null) => {
  const trimmedValue = value?.trim();

  return trimmedValue ? trimmedValue : null;
};

const normalizeProjectUpdate = (
  data: Partial<typeof project.$inferInsert>,
): Partial<typeof project.$inferInsert> => {
  const nextData: Partial<typeof project.$inferInsert> = {};

  if ("title" in data) {
    const title = data.title?.trim();

    if (!title) {
      throw new Error("Project title is required");
    }

    nextData.title = title;
  }

  if ("description" in data) {
    nextData.description = normalizeOptionalText(data.description);
  }

  if ("documentId" in data) {
    nextData.documentId = normalizeOptionalText(data.documentId);
  }

  return nextData;
};

// Ordinal assignment mirrors createSession: max+1 over the org's live rows,
// with the uniq index as the race guard. A caller-supplied transaction gets a
// single attempt — a failed statement aborts that transaction.
export const createProject = async (
  data: CreateProjectInput,
  caller: Caller,
  database?: DbOrTx,
) => {
  const title = data.title.trim();

  if (!title) {
    throw new Error("Project title is required");
  }

  // flow: org ordinal > insert > audit, one transaction
  const attempt = async (tx: DbOrTx) => {
    // display_number is per-org, so the ordinal restarts at 1 in each org
    const max = await maxProjectDisplayNumber(caller.organizationId, tx);
    const created = await createProjectRecord(
      {
        title,
        description: normalizeOptionalText(data.description),
        documentId: normalizeOptionalText(data.documentId),
        organizationId: caller.organizationId,
        displayNumber: (max ?? 0) + 1,
      },
      tx,
    );

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "create",
        resourceType: "Project",
        resourceId: created?.projectId ?? null,
        after: created,
      },
      tx,
    );

    return created;
  };

  // A caller-supplied transaction gets a single attempt — a failed statement
  // aborts that transaction. Otherwise the race loser retries on a fresh one.
  if (database) return attempt(database);

  for (let count = 0; ; count++) {
    try {
      return await db.transaction(attempt);
    } catch (err) {
      // the uq_project_display_org index is the race guard
      const lostRace = count < 2 && String(err).includes("uq_project_display");
      if (!lostRace) throw err;
    }
  }
};

export const listProjects = async (caller: Caller, database?: DbOrTx) =>
  listProjectRecords(caller.organizationId, database);

export const getProjectById = async (
  projectId: number,
  caller: Caller,
  database?: DbOrTx,
) => findProjectById(projectId, caller.organizationId, database);

export const listDashboard = async (
  caller: Caller,
  database?: DbOrTx,
): Promise<ProjectDashboardItem[]> => {
  const rows = await listProjectDashboardRows(caller.organizationId, database);
  return rows.map((row) => ({
    projectId: row.projectId,
    displayNumber: row.displayNumber,
    title: row.title,
    description: row.description,
    documentId: row.documentId,
    totalAssets: row.totalAssets,
    totalComponents: row.totalComponents,
    totalItems: row.totalItems,
    completedItems: row.completedItems,
    pendingItems: row.totalItems - row.completedItems,
    overallProgress: calculateProgress(row.completedItems, row.totalItems),
  }));
};

// flow: read before > update > audit both versions, one transaction
export const updateProject = async (
  projectId: number,
  data: Partial<typeof project.$inferInsert>,
  caller: Caller,
  database?: DbOrTx,
) => {
  const run = async (tx: DbOrTx) => {
    const before = await findProjectById(projectId, caller.organizationId, tx);
    if (!before) return null;

    const after = await updateProjectById(
      projectId,
      caller.organizationId,
      normalizeProjectUpdate(data),
      tx,
    );

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "modify",
        resourceType: "Project",
        resourceId: projectId,
        before,
        after,
      },
      tx,
    );

    return after;
  };

  return database ? run(database) : db.transaction(run);
};

// The bucket side of a project delete, injectable so a test can watch the sweep
// without a live MinIO. The default routes to the best-effort helpers, which log
// a storage error and let the delete win.
export type ProjectMediaCleanup = {
  removePrefix(keyPrefix: string): Promise<void>;
  removeKeys(keys: string[]): Promise<void>;
};

const defaultMediaCleanup: ProjectMediaCleanup = {
  removePrefix: removeMediaPrefix,
  removeKeys: removeMediaKeys,
};

// Delete a project and everything the bucket holds for it.
// flow: open-ingest guard > gather frozen locations > delete rows + audit >
//       commit > sweep objects
export const deleteProject = async (
  projectId: number,
  caller: Caller,
  database?: DbOrTx,
  cleanup: ProjectMediaCleanup = defaultMediaCleanup,
) => {
  const run = async (tx: DbOrTx) => {
    const project = await findProjectById(projectId, caller.organizationId, tx);
    if (!project) return null;

    // read before the delete: the prefixes and stems die with their rows
    const media = await listProjectMediaTargets(projectId, tx);

    // a live pipeline is still writing into a folder about to disappear
    if (media.openIngests > 0) {
      throw new AppError(
        409,
        "wrong_state",
        `project ${projectId} has ${media.openIngests} recording(s) still open`,
      );
    }

    const deleted = await deleteProjectById(projectId, caller.organizationId, tx);

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "remove",
        resourceType: "Project",
        resourceId: projectId,
        before: project,
      },
      tx,
    );

    return { deleted, media };
  };

  const result = database ? await run(database) : await db.transaction(run);
  if (!result) return null;

  // Out of the transaction on purpose: a MinIO call here must not hold a
  // database transaction open. The rows are gone, so a storage error logs and
  // the delete still succeeds.
  for (const prefix of result.media.prefixes) await cleanup.removePrefix(prefix);
  await cleanup.removeKeys([
    ...result.media.imageRows.flatMap((row) => {
      const leaves = imageEvidenceLeaves(row.storageStem, row.imageId, row.contentType);
      return row.hasAnnotated ? [leaves.raw.key, leaves.annotated.key] : [leaves.raw.key];
    }),
    ...result.media.thumbnailKeys,
  ]);

  return result.deleted;
};
