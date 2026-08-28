import { asc, eq, isNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { asset, component, item, project } from "../schema";

export type ProjectDashboardRow = {
  projectId: number;
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

export const listProjectRecords = async (database: DbOrTx = db) =>
  database.query.project.findMany({
    where: isNull(project.archivedAt),
    orderBy: asc(project.projectId),
  });

export const findProjectById = async (
  projectId: number,
  database: DbOrTx = db,
) =>
  (await database.query.project.findFirst({
    where: eq(project.projectId, projectId),
  })) ?? null;

export const listProjectDashboardRows = async (
  database: DbOrTx = db,
): Promise<ProjectDashboardRow[]> => {
  // pg count() returns text — mapWith(Number) keeps the row contract numeric
  const totalAssets = sql<number>`count(distinct ${asset.assetId})`.mapWith(Number);
  const totalComponents =
    sql<number>`count(distinct ${component.componentId})`.mapWith(Number);
  const totalItems = sql<number>`count(distinct ${item.itemId})`.mapWith(Number);
  // Progress follows item.status ('complete'), not result existence.
  const completedItems =
    sql<number>`count(distinct case when ${item.status} = 'complete' then ${item.itemId} end)`.mapWith(Number);

  return database
    .select({
      projectId: project.projectId,
      title: project.title,
      description: project.description,
      documentId: project.documentId,
      totalAssets,
      totalComponents,
      totalItems,
      completedItems,
    })
    .from(project)
    .leftJoin(asset, eq(asset.projectId, project.projectId))
    .leftJoin(component, eq(component.assetId, asset.assetId))
    .leftJoin(item, eq(item.componentId, component.componentId))
    .groupBy(
      project.projectId,
      project.title,
      project.description,
      project.documentId,
    )
    .orderBy(project.projectId);
};

export const updateProjectById = async (
  projectId: number,
  data: Partial<typeof project.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updatedProjects = await database
    .update(project)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(project.projectId, projectId))
    .returning();

  return updatedProjects[0] ?? null;
};

export const deleteProjectById = async (
  projectId: number,
  database: DbOrTx = db,
) => {
  const deletedProjects = await database
    .delete(project)
    .where(eq(project.projectId, projectId))
    .returning();

  return deletedProjects[0] ?? null;
};
