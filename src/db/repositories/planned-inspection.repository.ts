import { asc, eq } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { plannedInspection } from "../schema";

export const createPlannedInspectionRecord = async (
  data: typeof plannedInspection.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(plannedInspection).values(data).returning();
  return created[0] ?? null;
};

// insertion order is stable enough for the table view; no user reordering yet
export const listPlannedInspectionRecordsByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
) =>
  database.query.plannedInspection.findMany({
    where: eq(plannedInspection.projectId, projectId),
    orderBy: [asc(plannedInspection.plannedInspectionId)],
  });

export const deletePlannedInspectionById = async (
  plannedInspectionId: number,
  database: DbOrTx = db,
) => {
  const deleted = await database
    .delete(plannedInspection)
    .where(eq(plannedInspection.plannedInspectionId, plannedInspectionId))
    .returning();
  return deleted[0] ?? null;
};
