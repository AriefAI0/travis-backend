import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  createProject,
  deleteProject,
  getProjectById,
  listDashboard,
  updateProject,
  type ProjectMediaCleanup,
} from "../../db/services/project.service";
import {
  callerOf,
  requireCan,
  requireUser,
  type AuthVariables,
} from "../../lib/auth/middleware";
import { notFound } from "../../lib/error";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { projectInputSchema } from "../../types/api";

// thin transport: parse > service > ok(); database and the media sweep are
// injectable for tests
// flow: requireUser > requireCan > service > ok
//
// The guard is scoped to this feature's prefix, never "*": Hono merges a
// sub-app's wildcard middleware at the mount prefix, so `use("*")` would run
// requireUser on every route of every feature mounted after this one.
const PREFIX = "/api/v1/projects";

export const projectRoutes = (database?: DbOrTx, cleanup?: ProjectMediaCleanup) => {
  const routes = new Hono<{ Variables: AuthVariables }>();
  routes.use(PREFIX, requireUser(database));
  routes.use(`${PREFIX}/*`, requireUser(database));

  routes.get(PREFIX, requireCan("read", "Project"), async (c) =>
    ok(c, await listDashboard(callerOf(c), database)),
  );

  routes.post(PREFIX, requireCan("create", "Project"), async (c) => {
    const input = await parseBody(c, projectInputSchema);
    return ok(c, await createProject(input, callerOf(c), database), 201);
  });

  routes.get(`${PREFIX}/:id`, requireCan("read", "Project"), async (c) => {
    const project = await getProjectById(parseId(c, "id"), callerOf(c), database);
    if (!project) throw notFound("Project");
    return ok(c, project);
  });

  routes.patch(`${PREFIX}/:id`, requireCan("modify", "Project"), async (c) => {
    const input = await parseBody(c, projectInputSchema);
    const project = await updateProject(parseId(c, "id"), input, callerOf(c), database);
    if (!project) throw notFound("Project");
    return ok(c, project);
  });

  routes.delete(`${PREFIX}/:id`, requireCan("remove", "Project"), async (c) => {
    const project = await deleteProject(parseId(c, "id"), callerOf(c), database, cleanup);
    if (!project) throw notFound("Project");
    return ok(c, project);
  });

  // Report gathers were removed with the item model. Reports are server-owned
  // and land as a placeholder under features/reports.

  return routes;
};
