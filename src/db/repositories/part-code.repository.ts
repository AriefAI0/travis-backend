import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { partCode } from "../schema";

export const createPartCodeRecord = async (
  data: typeof partCode.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(partCode).values(data).returning();
  return created[0] ?? null;
};

export const listPartCodeRecordsByTypeId = async (
  typeId: number,
  database: DbOrTx = db,
) =>
  database.query.partCode.findMany({
    where: and(eq(partCode.typeId, typeId), isNull(partCode.archivedAt)),
    orderBy: [asc(partCode.partCodeId)],
  });

// batched tree read: all part codes under a set of types
export const listPartCodeRecordsByTypeIds = async (
  typeIds: number[],
  database: DbOrTx = db,
) =>
  typeIds.length
    ? database.query.partCode.findMany({
        where: and(inArray(partCode.typeId, typeIds), isNull(partCode.archivedAt)),
        orderBy: [asc(partCode.partCodeId)],
      })
    : [];

export const findPartCodeById = async (partCodeId: number, database: DbOrTx = db) =>
  (await database.query.partCode.findFirst({
    where: eq(partCode.partCodeId, partCodeId),
  })) ?? null;

export const findPartCodeByTypeAndCode = async (
  typeId: number,
  code: string,
  database: DbOrTx = db,
) =>
  (await database.query.partCode.findFirst({
    where: and(eq(partCode.typeId, typeId), eq(partCode.code, code)),
  })) ?? null;

export const updatePartCodeById = async (
  partCodeId: number,
  data: Partial<typeof partCode.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(partCode)
    .set(data)
    .where(eq(partCode.partCodeId, partCodeId))
    .returning();
  return updated[0] ?? null;
};

export const deletePartCodeById = async (partCodeId: number, database: DbOrTx = db) => {
  const deleted = await database
    .delete(partCode)
    .where(eq(partCode.partCodeId, partCodeId))
    .returning();
  return deleted[0] ?? null;
};
