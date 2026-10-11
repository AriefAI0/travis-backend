import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import {
  description,
  partCode,
  project,
  result,
  taskCode,
  taskGroup,
  type,
} from "../schema";

// Field names are kept from the item-model era so the app contract holds; the
// counts now describe the task tree: groups, task codes, targets, done targets.
export type ProjectDashboardRow = {
  projectId: number;
  displayNumber: number;
  title: string;
  description: string | null;
  documentId: string | null;
  totalAssets: number;
  totalComponents: number;
  totalItems: number;
  completedItems: number;
};

export const createProjectRecord = async (
  data: typeof project.$inferInsert,
  database: DbOrTx = db,
) => {
  const createdProjects = await database.insert(project).values(data).returning();

  return createdProjects[0] ?? null;
};

// highest assigned ordinal in one org; archived rows keep their number, so
// they count. Races on max+1 are caught by the uniq index and retried.
export const maxProjectDisplayNumber = async (
  organizationId: number,
  database: DbOrTx = db,
) => {
  const rows = await database
    .select({ displayNumber: project.displayNumber })
    .from(project)
    .where(
      and(
        isNotNull(project.displayNumber),
        eq(project.organizationId, organizationId),
      ),
    )
    .orderBy(desc(project.displayNumber))
    .limit(1);

  return rows[0]?.displayNumber ?? null;
};

export const listProjectRecords = async (organizationId: number, database: DbOrTx = db) =>
  database.query.project.findMany({
    where: and(isNull(project.archivedAt), eq(project.organizationId, organizationId)),
    orderBy: asc(project.projectId),
  });

// The org's project ids, for a read whose own query cannot join the project
// table. Archived projects stay in: their recordings are still readable.
export const listProjectIdsByOrganizationId = async (
  organizationId: number,
  database: DbOrTx = db,
) =>
  (
    await database
      .select({ projectId: project.projectId })
      .from(project)
      .where(eq(project.organizationId, organizationId))
  ).map((row) => row.projectId);

// Org is part of the lookup, so another org's id is simply not found.
export const findProjectById = async (
  projectId: number,
  organizationId: number,
  database: DbOrTx = db,
) =>
  (await database.query.project.findFirst({
    where: and(
      eq(project.projectId, projectId),
      eq(project.organizationId, organizationId),
    ),
  })) ?? null;

// NO org filter. Only for a project id that a trusted server-side path already
// established: an ingest ticket's project, or a result row the caller fetched
// through a scoped route. A route handler serving a client-supplied id must
// use findProjectById with a caller instead.
export const findProjectByIdInternal = async (
  projectId: number,
  database: DbOrTx = db,
) =>
  (await database.query.project.findFirst({
    where: eq(project.projectId, projectId),
  })) ?? null;

// flow: tree counts > target counts > finished-target counts > merge by project
// Only the project list is org-filtered; every count joins on projectId, so it
// is scoped by construction.
export const listProjectDashboardRows = async (
  organizationId: number,
  database: DbOrTx = db,
): Promise<ProjectDashboardRow[]> => {
  const count = (expr: ReturnType<typeof sql>) => sql<number>`${expr}`.mapWith(Number);

  const [projects, groups, codes, components, codesPerBranch, finished] = await Promise.all([
    database.query.project.findMany({
      where: and(isNull(project.archivedAt), eq(project.organizationId, organizationId)),
      orderBy: asc(project.projectId),
    }),

    database
      .select({
        projectId: taskGroup.projectId,
        value: count(sql`count(distinct ${taskGroup.taskGroupId})`),
      })
      .from(taskGroup)
      .groupBy(taskGroup.projectId),

    database
      .select({
        projectId: taskGroup.projectId,
        value: count(sql`count(distinct ${taskCode.taskCodeId})`),
      })
      .from(taskCode)
      .innerJoin(taskGroup, eq(taskGroup.taskGroupId, taskCode.taskGroupId))
      .groupBy(taskGroup.projectId),

    database
      .select({
        projectId: taskGroup.projectId,
        value: count(sql`count(distinct ${description.descriptionId})`),
      })
      .from(description)
      .innerJoin(taskCode, eq(taskCode.taskCodeId, description.taskCodeId))
      .innerJoin(taskGroup, eq(taskGroup.taskGroupId, taskCode.taskGroupId))
      .groupBy(taskGroup.projectId),

    database
      .select({
        projectId: taskGroup.projectId,
        value: count(sql`count(distinct ${partCode.partCodeId})`),
      })
      .from(partCode)
      .innerJoin(
        type,
        eq(type.typeId, partCode.typeId),
      )
      .innerJoin(description, eq(description.descriptionId, type.descriptionId))
      .innerJoin(taskCode, eq(taskCode.taskCodeId, description.taskCodeId))
      .innerJoin(taskGroup, eq(taskGroup.taskGroupId, taskCode.taskGroupId))
      .groupBy(taskGroup.projectId),

    // a target counts as done once it has a finished (stopped) inspection
    database
      .select({
        projectId: result.projectId,
        value: count(
          sql`count(distinct (coalesce(${result.descriptionId}, -1), coalesce(${result.partCodeId}, -1)))`,
        ),
      })
      .from(result)
      .where(isNotNull(result.masterEndMs))
      .groupBy(result.projectId),
  ]);

  const asMap = (rows: Array<{ projectId: number; value: number }>): Map<number, number> =>
    new Map(rows.map((row) => [row.projectId, row.value]));
  const groupCounts = asMap(groups);
  const codeCounts = asMap(codes);
  const componentCounts = asMap(components);
  const componentCodeCounts = asMap(codesPerBranch);
  const finishedCounts = asMap(finished);

  return projects.map((row) => ({
    projectId: row.projectId,
    displayNumber: row.displayNumber,
    title: row.title,
    description: row.description,
    documentId: row.documentId,
    totalAssets: groupCounts.get(row.projectId) ?? 0,
    totalComponents: codeCounts.get(row.projectId) ?? 0,
    totalItems:
      (componentCounts.get(row.projectId) ?? 0) + (componentCodeCounts.get(row.projectId) ?? 0),
    completedItems: finishedCounts.get(row.projectId) ?? 0,
  }));
};

export const updateProjectById = async (
  projectId: number,
  organizationId: number,
  data: Partial<typeof project.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updatedProjects = await database
    .update(project)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(project.projectId, projectId), eq(project.organizationId, organizationId)))
    .returning();

  return updatedProjects[0] ?? null;
};

export const deleteProjectById = async (
  projectId: number,
  organizationId: number,
  database: DbOrTx = db,
) => {
  const deletedProjects = await database
    .delete(project)
    .where(and(eq(project.projectId, projectId), eq(project.organizationId, organizationId)))
    .returning();

  return deletedProjects[0] ?? null;
};
