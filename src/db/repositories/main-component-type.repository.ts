import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { mainComponentType } from "../schema";

export const createMainComponentTypeRecord = async (
  data: typeof mainComponentType.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(mainComponentType).values(data).returning();
  return created[0] ?? null;
};

export const listMainComponentTypeRecordsByMainComponentId = async (
  mainComponentId: number,
  database: DbOrTx = db,
) =>
  database.query.mainComponentType.findMany({
    where: and(
      eq(mainComponentType.mainComponentId, mainComponentId),
      isNull(mainComponentType.archivedAt),
    ),
    orderBy: [asc(mainComponentType.displayOrder), asc(mainComponentType.mainComponentTypeId)],
  });

// batched tree read: all type branches under a set of main components
export const listMainComponentTypeRecordsByMainComponentIds = async (
  mainComponentIds: number[],
  database: DbOrTx = db,
) =>
  mainComponentIds.length
    ? database.query.mainComponentType.findMany({
        where: and(
          inArray(mainComponentType.mainComponentId, mainComponentIds),
          isNull(mainComponentType.archivedAt),
        ),
        orderBy: [
          asc(mainComponentType.displayOrder),
          asc(mainComponentType.mainComponentTypeId),
        ],
      })
    : [];

// in-use check before a catalog delete
export const listMainComponentTypeRecordsByComponentTypeId = async (
  componentTypeId: number,
  database: DbOrTx = db,
) =>
  database.query.mainComponentType.findMany({
    where: eq(mainComponentType.componentTypeId, componentTypeId),
  });

export const findMainComponentTypeById = async (
  mainComponentTypeId: number,
  database: DbOrTx = db,
) =>
  (await database.query.mainComponentType.findFirst({
    where: eq(mainComponentType.mainComponentTypeId, mainComponentTypeId),
  })) ?? null;

export const findMainComponentTypeByPair = async (
  mainComponentId: number,
  componentTypeId: number,
  database: DbOrTx = db,
) =>
  (await database.query.mainComponentType.findFirst({
    where: and(
      eq(mainComponentType.mainComponentId, mainComponentId),
      eq(mainComponentType.componentTypeId, componentTypeId),
    ),
  })) ?? null;

export const updateMainComponentTypeById = async (
  mainComponentTypeId: number,
  data: Partial<typeof mainComponentType.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(mainComponentType)
    .set(data)
    .where(eq(mainComponentType.mainComponentTypeId, mainComponentTypeId))
    .returning();
  return updated[0] ?? null;
};

export const deleteMainComponentTypeById = async (
  mainComponentTypeId: number,
  database: DbOrTx = db,
) => {
  const deleted = await database
    .delete(mainComponentType)
    .where(eq(mainComponentType.mainComponentTypeId, mainComponentTypeId))
    .returning();
  return deleted[0] ?? null;
};
