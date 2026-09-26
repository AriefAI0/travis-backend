import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { description, taskCode, taskGroup, type } from "../schema";

export const createTypeRecord = async (
  data: typeof type.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(type).values(data).returning();
  return created[0] ?? null;
};

export const listTypeRecordsByDescriptionId = async (
  descriptionId: number,
  database: DbOrTx = db,
) =>
  database.query.type.findMany({
    where: and(eq(type.descriptionId, descriptionId), isNull(type.archivedAt)),
    orderBy: [asc(type.displayOrder), asc(type.typeId)],
  });

// batched tree read: all types under a set of descriptions
export const listTypeRecordsByDescriptionIds = async (
  descriptionIds: number[],
  database: DbOrTx = db,
) =>
  descriptionIds.length
    ? database.query.type.findMany({
        where: and(inArray(type.descriptionId, descriptionIds), isNull(type.archivedAt)),
        orderBy: [asc(type.displayOrder), asc(type.typeId)],
      })
    : [];

export const findTypeById = async (typeId: number, database: DbOrTx = db) =>
  (await database.query.type.findFirst({
    where: eq(type.typeId, typeId),
  })) ?? null;

export const findTypeByDescriptionIdAndCode = async (
  descriptionId: number,
  code: string,
  database: DbOrTx = db,
) =>
  (await database.query.type.findFirst({
    where: and(eq(type.descriptionId, descriptionId), eq(type.code, code)),
  })) ?? null;

// rename in place: id stays, code and label change together
export const updateTypeById = async (
  typeId: number,
  data: Partial<typeof type.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(type)
    .set(data)
    .where(eq(type.typeId, typeId))
    .returning();
  return updated[0] ?? null;
};

export const deleteTypeById = async (typeId: number, database: DbOrTx = db) => {
  const deleted = await database.delete(type).where(eq(type.typeId, typeId)).returning();
  return deleted[0] ?? null;
};

// project-wide type vocabulary for autocomplete: distinct code+label pairs
// walked down the tree chain (no catalog table anymore)
export const listTypeCatalogByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
) =>
  database
    .selectDistinct({ code: type.code, label: type.label })
    .from(type)
    .innerJoin(description, eq(description.descriptionId, type.descriptionId))
    .innerJoin(taskCode, eq(taskCode.taskCodeId, description.taskCodeId))
    .innerJoin(taskGroup, eq(taskGroup.taskGroupId, taskCode.taskGroupId))
    .where(and(eq(taskGroup.projectId, projectId), isNull(type.archivedAt)))
    .orderBy(asc(type.code));
