import { and, asc, eq, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { mainComponent } from "../schema";

export const createMainComponentRecord = async (
  data: typeof mainComponent.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(mainComponent).values(data).returning();
  return created[0] ?? null;
};

export const listMainComponentRecordsByTaskCodeId = async (
  taskCodeId: number,
  database: DbOrTx = db,
) =>
  database.query.mainComponent.findMany({
    where: and(eq(mainComponent.taskCodeId, taskCodeId), isNull(mainComponent.archivedAt)),
    orderBy: [asc(mainComponent.displayOrder), asc(mainComponent.mainComponentId)],
  });

export const findMainComponentById = async (
  mainComponentId: number,
  database: DbOrTx = db,
) =>
  (await database.query.mainComponent.findFirst({
    where: eq(mainComponent.mainComponentId, mainComponentId),
  })) ?? null;

export const findMainComponentByTaskCodeIdAndDescription = async (
  taskCodeId: number,
  description: string,
  database: DbOrTx = db,
) =>
  (await database.query.mainComponent.findFirst({
    where: and(eq(mainComponent.taskCodeId, taskCodeId), eq(mainComponent.description, description)),
  })) ?? null;

export const updateMainComponentById = async (
  mainComponentId: number,
  data: Partial<typeof mainComponent.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(mainComponent)
    .set(data)
    .where(eq(mainComponent.mainComponentId, mainComponentId))
    .returning();
  return updated[0] ?? null;
};

export const deleteMainComponentById = async (
  mainComponentId: number,
  database: DbOrTx = db,
) => {
  const deleted = await database
    .delete(mainComponent)
    .where(eq(mainComponent.mainComponentId, mainComponentId))
    .returning();
  return deleted[0] ?? null;
};
