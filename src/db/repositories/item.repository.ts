import { and, asc, eq, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { item } from "../schema";

export const createItemRecord = async (
  data: typeof item.$inferInsert,
  database: DbOrTx = db,
) => {
  const createdItems = await database.insert(item).values(data).returning();

  return createdItems[0] ?? null;
};

export const listItemRecords = async (database: DbOrTx = db) =>
  database.query.item.findMany({
    where: isNull(item.archivedAt),
    orderBy: [asc(item.componentId), asc(item.itemId)],
  });

export const listItemRecordsByComponentId = async (
  componentId: number,
  database: DbOrTx = db,
) =>
  database.query.item.findMany({
    where: and(eq(item.componentId, componentId), isNull(item.archivedAt)),
    orderBy: asc(item.itemId),
  });

/** Batched via denormalized projectId (indexed) — used to kill the structure-tree N+1. */
export const listItemRecordsByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
) =>
  database.query.item.findMany({
    where: and(eq(item.projectId, projectId), isNull(item.archivedAt)),
    orderBy: [asc(item.componentId), asc(item.itemId)],
  });

export const findItemById = async (
  itemId: number,
  database: DbOrTx = db,
) =>
  (await database.query.item.findFirst({
    where: eq(item.itemId, itemId),
  })) ?? null;

export const findItemByLabel = async (
  itemLabel: string,
  database: DbOrTx = db,
) =>
  (await database.query.item.findFirst({
    where: eq(item.itemLabel, itemLabel),
  })) ?? null;

export const findItemByComponentIdAndLabel = async (
  componentId: number,
  itemLabel: string,
  database: DbOrTx = db,
) =>
  (await database.query.item.findFirst({
    where: and(
      eq(item.componentId, componentId),
      eq(item.itemLabel, itemLabel),
    ),
  })) ?? null;

export const updateItemById = async (
  itemId: number,
  data: Partial<typeof item.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updatedItems = await database
    .update(item)
    .set(data)
    .where(eq(item.itemId, itemId))
    .returning();

  return updatedItems[0] ?? null;
};

export const deleteItemById = async (
  itemId: number,
  database: DbOrTx = db,
) => {
  const deletedItems = await database
    .delete(item)
    .where(eq(item.itemId, itemId))
    .returning();

  return deletedItems[0] ?? null;
};
