import { and, asc, eq, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { taskGroup } from "../schema";

export const createTaskGroupRecord = async (
  data: typeof taskGroup.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(taskGroup).values(data).returning();
  return created[0] ?? null;
};

export const listTaskGroupRecordsByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
) =>
  database.query.taskGroup.findMany({
    where: and(eq(taskGroup.projectId, projectId), isNull(taskGroup.archivedAt)),
    orderBy: [asc(taskGroup.taskGroupId)],
  });

export const findTaskGroupById = async (taskGroupId: number, database: DbOrTx = db) =>
  (await database.query.taskGroup.findFirst({
    where: eq(taskGroup.taskGroupId, taskGroupId),
  })) ?? null;

export const findTaskGroupByProjectIdAndCode = async (
  projectId: number,
  code: string,
  database: DbOrTx = db,
) =>
  (await database.query.taskGroup.findFirst({
    where: and(eq(taskGroup.projectId, projectId), eq(taskGroup.code, code)),
  })) ?? null;

export const updateTaskGroupById = async (
  taskGroupId: number,
  data: Partial<typeof taskGroup.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(taskGroup)
    .set(data)
    .where(eq(taskGroup.taskGroupId, taskGroupId))
    .returning();
  return updated[0] ?? null;
};

export const deleteTaskGroupById = async (taskGroupId: number, database: DbOrTx = db) => {
  const deleted = await database
    .delete(taskGroup)
    .where(eq(taskGroup.taskGroupId, taskGroupId))
    .returning();
  return deleted[0] ?? null;
};
