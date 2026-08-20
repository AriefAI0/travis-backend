import { and, asc, eq, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { component } from "../schema";

export const createComponentRecord = async (
  data: typeof component.$inferInsert,
  database: DbOrTx = db,
) => {
  const createdComponents = await database
    .insert(component)
    .values(data)
    .returning();

  return createdComponents[0] ?? null;
};

export const listComponentRecords = async (database: DbOrTx = db) =>
  database.query.component.findMany({
    where: isNull(component.archivedAt),
    orderBy: [asc(component.assetId), asc(component.componentId)],
  });

export const listComponentRecordsByAssetId = async (
  assetId: number,
  database: DbOrTx = db,
) =>
  database.query.component.findMany({
    where: and(eq(component.assetId, assetId), isNull(component.archivedAt)),
    orderBy: asc(component.componentId),
  });

/** Batched via denormalized projectId (indexed) — used to kill the structure-tree N+1. */
export const listComponentRecordsByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
) =>
  database.query.component.findMany({
    where: and(eq(component.projectId, projectId), isNull(component.archivedAt)),
    orderBy: [asc(component.assetId), asc(component.componentId)],
  });

export const findComponentById = async (
  componentId: number,
  database: DbOrTx = db,
) =>
  (await database.query.component.findFirst({
    where: eq(component.componentId, componentId),
  })) ?? null;

export const findComponentByAssetIdAndName = async (
  assetId: number,
  name: string,
  database: DbOrTx = db,
) =>
  (await database.query.component.findFirst({
    where: and(eq(component.assetId, assetId), eq(component.name, name)),
  })) ?? null;

export const updateComponentById = async (
  componentId: number,
  data: Partial<typeof component.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updatedComponents = await database
    .update(component)
    .set(data)
    .where(eq(component.componentId, componentId))
    .returning();

  return updatedComponents[0] ?? null;
};

export const deleteComponentById = async (
  componentId: number,
  database: DbOrTx = db,
) => {
  const deletedComponents = await database
    .delete(component)
    .where(eq(component.componentId, componentId))
    .returning();

  return deletedComponents[0] ?? null;
};
