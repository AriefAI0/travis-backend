import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { taskCode } from "../schema";

export const createTaskCodeRecord = async (
  data: typeof taskCode.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(taskCode).values(data).returning();
  return created[0] ?? null;
};

export const listTaskCodeRecordsByTaskGroupId = async (
  taskGroupId: number,
  database: DbOrTx = db,
) =>
  database.query.taskCode.findMany({
    where: and(eq(taskCode.taskGroupId, taskGroupId), isNull(taskCode.archivedAt)),
    orderBy: [asc(taskCode.displayOrder), asc(taskCode.taskCodeId)],
  });

// batched tree read: all codes under a set of groups
export const listTaskCodeRecordsByTaskGroupIds = async (
  taskGroupIds: number[],
  database: DbOrTx = db,
) =>
  taskGroupIds.length
    ? database.query.taskCode.findMany({
        where: and(inArray(taskCode.taskGroupId, taskGroupIds), isNull(taskCode.archivedAt)),
        orderBy: [asc(taskCode.displayOrder), asc(taskCode.taskCodeId)],
      })
    : [];

export const findTaskCodeById = async (taskCodeId: number, database: DbOrTx = db) =>
  (await database.query.taskCode.findFirst({
    where: eq(taskCode.taskCodeId, taskCodeId),
  })) ?? null;

export const findTaskCodeByTaskGroupIdAndCode = async (
  taskGroupId: number,
  code: string,
  database: DbOrTx = db,
) =>
  (await database.query.taskCode.findFirst({
    where: and(eq(taskCode.taskGroupId, taskGroupId), eq(taskCode.code, code)),
  })) ?? null;

export const updateTaskCodeById = async (
  taskCodeId: number,
  data: Partial<typeof taskCode.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(taskCode)
    .set(data)
    .where(eq(taskCode.taskCodeId, taskCodeId))
    .returning();
  return updated[0] ?? null;
};

export const deleteTaskCodeById = async (taskCodeId: number, database: DbOrTx = db) => {
  const deleted = await database
    .delete(taskCode)
    .where(eq(taskCode.taskCodeId, taskCodeId))
    .returning();
  return deleted[0] ?? null;
};
