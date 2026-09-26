import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { description } from "../schema";

export const createDescriptionRecord = async (
  data: typeof description.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(description).values(data).returning();
  return created[0] ?? null;
};

export const listDescriptionRecordsByTaskCodeId = async (
  taskCodeId: number,
  database: DbOrTx = db,
) =>
  database.query.description.findMany({
    where: and(eq(description.taskCodeId, taskCodeId), isNull(description.archivedAt)),
    orderBy: [asc(description.displayOrder), asc(description.descriptionId)],
  });

// batched tree read: all descriptions under a set of task codes
export const listDescriptionRecordsByTaskCodeIds = async (
  taskCodeIds: number[],
  database: DbOrTx = db,
) =>
  taskCodeIds.length
    ? database.query.description.findMany({
        where: and(
          inArray(description.taskCodeId, taskCodeIds),
          isNull(description.archivedAt),
        ),
        orderBy: [asc(description.displayOrder), asc(description.descriptionId)],
      })
    : [];

export const findDescriptionById = async (
  descriptionId: number,
  database: DbOrTx = db,
) =>
  (await database.query.description.findFirst({
    where: eq(description.descriptionId, descriptionId),
  })) ?? null;

export const findDescriptionByTaskCodeIdAndLabel = async (
  taskCodeId: number,
  label: string,
  database: DbOrTx = db,
) =>
  (await database.query.description.findFirst({
    where: and(eq(description.taskCodeId, taskCodeId), eq(description.label, label)),
  })) ?? null;

export const updateDescriptionById = async (
  descriptionId: number,
  data: Partial<typeof description.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(description)
    .set(data)
    .where(eq(description.descriptionId, descriptionId))
    .returning();
  return updated[0] ?? null;
};

export const deleteDescriptionById = async (
  descriptionId: number,
  database: DbOrTx = db,
) => {
  const deleted = await database
    .delete(description)
    .where(eq(description.descriptionId, descriptionId))
    .returning();
  return deleted[0] ?? null;
};
