import { Hono } from "hono";
import { db, type DbOrTx } from "../../db/client";
import {
  createResultRecord,
  deleteRestrictedAccessById,
  listRestrictedAccessRecordsByProjectId,
  updateRestrictedAccessRemarks,
} from "../../db/repositories/result.repository";
import { findProjectById } from "../../db/repositories/project.repository";
import { projectIdOfTarget } from "../../db/services/task-structure.service";
import { callerOf, requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import { AppError, notFound } from "../../lib/error";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  createRestrictedAccessSchema,
  updateRestrictedAccessSchema,
} from "../../types/api";

// restricted-access marks (parse > repository > ok); the partial unique index
// answers duplicates with 409 and a missing target with 404, via onError
// flow: requireUser > requireCan > project in org > repository > ok
//
// A mark is a result row, so it carries the Result subject. `remove Result` is
// an admin right by design, so an operator unmarks a mark only when an admin
// ticks that box for the account.
//
// The list shares /api/v1/projects with other features, so its guard is inline.
export const restrictedAccessRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.use("/api/v1/restricted-access", requireUser(database));
  routes.use("/api/v1/restricted-access/*", requireUser(database));

  // A project in another org reads as absent, so the id can never be probed.
  const assertProjectInOrg = async (projectId: number, organizationId: number) => {
    if (!(await findProjectById(projectId, organizationId, database))) {
      throw notFound("Project");
    }
  };

  // A target from another org would otherwise ride a same-org projectId in.
  // flow: target > owning project > must equal the project in the body
  const assertTargetInProject = async (target: {
    descriptionId?: number | null;
    partCodeId?: number | null;
  }, projectId: number) => {
    if ((await projectIdOfTarget(target, database ?? db)) !== projectId) {
      throw new AppError(404, "not_found", "Target not found");
    }
  };

  routes.get(
    "/api/v1/projects/:projectId/restricted-access",
    requireUser(database),
    requireCan("read", "Result"),
    async (c) => {
      const projectId = parseId(c, "projectId");
      await assertProjectInOrg(projectId, callerOf(c).organizationId);
      return ok(c, await listRestrictedAccessRecordsByProjectId(projectId, database));
    },
  );

  routes.post("/api/v1/restricted-access", requireCan("create", "Result"), async (c) => {
    const input = await parseBody(c, createRestrictedAccessSchema);
    await assertProjectInOrg(input.projectId, callerOf(c).organizationId);
    await assertTargetInProject(input, input.projectId);

    // an RA row is sessionless: no session, no layer, ordinal 0 unused
    const row = await createResultRecord(
      {
        ...input,
        inspectionTypeCode: "RA",
        isRa: true,
        sessionId: null,
        displayNumber: 0,
      },
      database,
    );
    return ok(c, row, 201);
  });

  // The mark is created when its card opens, so the operator's remarks land
  // here afterwards. A null clears them.
  routes.patch("/api/v1/restricted-access/:id", requireCan("modify", "Result"), async (c) => {
    const input = await parseBody(c, updateRestrictedAccessSchema);
    const row = await updateRestrictedAccessRemarks(
      parseId(c, "id"),
      input.remarks ?? null,
      callerOf(c).organizationId,
      database,
    );
    if (!row) throw notFound("Restricted access mark");
    return ok(c, row);
  });

  routes.delete("/api/v1/restricted-access/:id", requireCan("remove", "Result"), async (c) => {
    const row = await deleteRestrictedAccessById(
      parseId(c, "id"),
      callerOf(c).organizationId,
      database,
    );
    if (!row) throw notFound("Restricted access mark");
    return ok(c, row);
  });

  return routes;
};
