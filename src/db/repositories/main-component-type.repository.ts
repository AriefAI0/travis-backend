import { and, asc, eq, isNull } from "drizzle-orm";

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
