import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  createPlannedInspectionRecord,
  deletePlannedInspectionById,
  listPlannedInspectionRecordsByProjectId,
} from "../../db/repositories/planned-inspection.repository";
import { findProjectById } from "../../db/repositories/project.repository";
import { callerOf, requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import { notFound } from "../../lib/error";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { createPlannedInspectionSchema } from "../../types/api";

// planned inspection CRUD (parse > repository > ok); the unique constraint
// answers duplicates with 409 and a missing target with 404, via onError
// flow: requireUser > requireCan > project in org > repository > ok
//
// The rows are structure planning data, so they carry the Structure subject.
// An operator holds no `create Structure`, so unplanned inspection setup is an
// admin's job unless an admin ticks the box for that operator.
//
// Guards sit on the two own prefixes only. The project-scoped list shares
// /api/v1/projects with other features, so its guard goes inline.
export const plannedInspectionRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.use("/api/v1/planned-inspections", requireUser(database));
  routes.use("/api/v1/planned-inspections/*", requireUser(database));

  // A project in another org reads as absent, so the id can never be probed.
  const assertProjectInOrg = async (projectId: number, organizationId: number) => {
    if (!(await findProjectById(projectId, organizationId, database))) {
      throw notFound("Project");
    }
  };

  routes.get(
    "/api/v1/projects/:projectId/planned-inspections",
    requireUser(database),
    requireCan("read", "Structure"),
    async (c) => {
      const projectId = parseId(c, "projectId");
      await assertProjectInOrg(projectId, callerOf(c).organizationId);
      return ok(c, await listPlannedInspectionRecordsByProjectId(projectId, database));
    },
  );

  routes.post("/api/v1/planned-inspections", requireCan("create", "Structure"), async (c) => {
    const input = await parseBody(c, createPlannedInspectionSchema);
    await assertProjectInOrg(input.projectId, callerOf(c).organizationId);
    return ok(c, await createPlannedInspectionRecord(input, database), 201);
  });

  // The org filter rides the DELETE statement itself: a check-then-delete would
  // leave a window where a row crosses orgs between the two calls.
  routes.delete("/api/v1/planned-inspections/:id", requireCan("remove", "Structure"), async (c) => {
    const row = await deletePlannedInspectionById(
      parseId(c, "id"),
      callerOf(c).organizationId,
      database,
    );
    if (!row) throw notFound("Planned inspection");
    return ok(c, row);
  });

  return routes;
};
