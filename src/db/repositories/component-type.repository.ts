import { and, asc, eq, ilike, isNull, or } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { componentType } from "../schema";

export const createComponentTypeRecord = async (
  data: typeof componentType.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(componentType).values(data).returning();
  return created[0] ?? null;
};

// catalog autocomplete: match code or label, project-scoped
export const listComponentTypeRecordsByProjectId = async (
  projectId: number,
  query?: string,
  database: DbOrTx = db,
) =>
  database.query.componentType.findMany({
    where: and(
      eq(componentType.projectId, projectId),
      isNull(componentType.archivedAt),
      query
        ? or(
            ilike(componentType.typeCode, `%${query}%`),
            ilike(componentType.label, `%${query}%`),
          )
        : undefined,
    ),
    orderBy: [asc(componentType.typeCode)],
  });

export const findComponentTypeById = async (
  componentTypeId: number,
  database: DbOrTx = db,
) =>
  (await database.query.componentType.findFirst({
    where: eq(componentType.componentTypeId, componentTypeId),
  })) ?? null;

export const findComponentTypeByProjectIdAndCode = async (
  projectId: number,
  typeCode: string,
  database: DbOrTx = db,
) =>
  (await database.query.componentType.findFirst({
    where: and(eq(componentType.projectId, projectId), eq(componentType.typeCode, typeCode)),
  })) ?? null;

// rename in place: id stays, code and label change together
export const updateComponentTypeById = async (
  componentTypeId: number,
  data: Partial<typeof componentType.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(componentType)
    .set(data)
    .where(eq(componentType.componentTypeId, componentTypeId))
    .returning();
  return updated[0] ?? null;
};

export const deleteComponentTypeById = async (
  componentTypeId: number,
  database: DbOrTx = db,
) => {
  const deleted = await database
    .delete(componentType)
    .where(eq(componentType.componentTypeId, componentTypeId))
    .returning();
  return deleted[0] ?? null;
};
