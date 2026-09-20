import type { DbOrTx } from "../client";
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
  database?: DbOrTx,
) => {
  const title = data.title.trim();

  if (!title) {
    throw new Error("Project title is required");
  }

  const insertOnce = async (dbOrTx?: DbOrTx) => {
    // every project is org-null until better-auth lands, so the ordinal is
    // global today and per-org later
    const max = await maxProjectDisplayNumber(null, dbOrTx);
    return createProjectRecord(
      {
        title,
        description: normalizeOptionalText(data.description),
        documentId: normalizeOptionalText(data.documentId),
        displayNumber: (max ?? 0) + 1,
      },
      dbOrTx,
    );
  };

  if (database) {
    return insertOnce(database);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await insertOnce();
    } catch (err) {
      // covers both partial indexes: uq_project_display_org and _noorg
      const lostRace = attempt < 2 && String(err).includes("uq_project_display");
      if (!lostRace) throw err;
    }
  }
};

export const listProjects = async (database?: DbOrTx) =>
  listProjectRecords(database);

export const getProjectById = async (
  projectId: number,
  database?: DbOrTx,
) => findProjectById(projectId, database);

export const listDashboard = async (
  database?: DbOrTx,
): Promise<ProjectDashboardItem[]> => {
  const rows = await listProjectDashboardRows(database);
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

export const updateProject = async (
  projectId: number,
  data: Partial<typeof project.$inferInsert>,
  database?: DbOrTx,
) => updateProjectById(projectId, normalizeProjectUpdate(data), database);

export const deleteProject = async (
  projectId: number,
  database?: DbOrTx,
) => deleteProjectById(projectId, database);
