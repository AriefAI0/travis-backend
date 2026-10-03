import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  createPlannedInspectionRecord,
  deletePlannedInspectionById,
  listPlannedInspectionRecordsByProjectId,
} from "../../db/repositories/planned-inspection.repository";
import { notFound } from "../../lib/error";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { createPlannedInspectionSchema } from "../../types/api";

// planned inspection CRUD (parse > repository > ok); the unique constraint
// answers duplicates with 409 and a missing target with 404, via onError
export const plannedInspectionRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  routes.get("/api/v1/projects/:projectId/planned-inspections", async (c) => {
    const projectId = parseId(c, "projectId");
    return ok(c, await listPlannedInspectionRecordsByProjectId(projectId, database));
  });

  routes.post("/api/v1/planned-inspections", async (c) => {
    const input = await parseBody(c, createPlannedInspectionSchema);
    return ok(c, await createPlannedInspectionRecord(input, database), 201);
  });

  routes.delete("/api/v1/planned-inspections/:id", async (c) => {
    const row = await deletePlannedInspectionById(parseId(c, "id"), database);
    if (!row) throw notFound("Planned inspection");
    return ok(c, row);
  });

  return routes;
};
