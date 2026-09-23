import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { componentCode } from "../schema";

export const createComponentCodeRecord = async (
  data: typeof componentCode.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(componentCode).values(data).returning();
  return created[0] ?? null;
};

export const listComponentCodeRecordsByMainComponentTypeId = async (
  mainComponentTypeId: number,
  database: DbOrTx = db,
) =>
  database.query.componentCode.findMany({
    where: and(
      eq(componentCode.mainComponentTypeId, mainComponentTypeId),
      isNull(componentCode.archivedAt),
    ),
    orderBy: [asc(componentCode.displayOrder), asc(componentCode.componentCodeId)],
  });

// batched tree read: all component codes under a set of type branches
export const listComponentCodeRecordsByMainComponentTypeIds = async (
  mainComponentTypeIds: number[],
  database: DbOrTx = db,
) =>
  mainComponentTypeIds.length
    ? database.query.componentCode.findMany({
        where: and(
          inArray(componentCode.mainComponentTypeId, mainComponentTypeIds),
          isNull(componentCode.archivedAt),
        ),
        orderBy: [asc(componentCode.displayOrder), asc(componentCode.componentCodeId)],
      })
    : [];

export const findComponentCodeById = async (
  componentCodeId: number,
  database: DbOrTx = db,
) =>
  (await database.query.componentCode.findFirst({
    where: eq(componentCode.componentCodeId, componentCodeId),
  })) ?? null;

export const findComponentCodeByBranchAndCode = async (
  mainComponentTypeId: number,
  code: string,
  database: DbOrTx = db,
) =>
  (await database.query.componentCode.findFirst({
    where: and(
      eq(componentCode.mainComponentTypeId, mainComponentTypeId),
      eq(componentCode.code, code),
    ),
  })) ?? null;

export const updateComponentCodeById = async (
  componentCodeId: number,
  data: Partial<typeof componentCode.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(componentCode)
    .set(data)
    .where(eq(componentCode.componentCodeId, componentCodeId))
    .returning();
  return updated[0] ?? null;
};

export const deleteComponentCodeById = async (
  componentCodeId: number,
  database: DbOrTx = db,
) => {
  const deleted = await database
    .delete(componentCode)
    .where(eq(componentCode.componentCodeId, componentCodeId))
    .returning();
  return deleted[0] ?? null;
};
