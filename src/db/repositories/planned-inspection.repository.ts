import { and, asc, eq, inArray } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { plannedInspection, project } from "../schema";

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

// Org-scoped delete: the subquery keeps the row's project inside the caller's
// org, so a foreign id deletes nothing and reads as absent.
// flow: id + org filter > delete > returning
export const deletePlannedInspectionById = async (
  plannedInspectionId: number,
  organizationId: number,
  database: DbOrTx = db,
) => {
  const deleted = await database
    .delete(plannedInspection)
    .where(
      and(
        eq(plannedInspection.plannedInspectionId, plannedInspectionId),
        inArray(
          plannedInspection.projectId,
          database
            .select({ projectId: project.projectId })
            .from(project)
            .where(eq(project.organizationId, organizationId)),
        ),
      ),
    )
    .returning();
  return deleted[0] ?? null;
};
