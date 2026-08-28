import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  createProject,
  deleteProject,
  getProjectById,
  listDashboard,
  updateProject,
} from "../../db/services/project.service";
import { gatherReportData, gatherReportSignature } from "../../db/services/report.service";
import { notFound } from "../../lib/error";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { projectInputSchema } from "../../types/api";

// thin transport: parse > service > ok(); database injectable for tests
export const projectRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  routes.get("/api/v1/projects", async (c) => ok(c, await listDashboard(database)));

  routes.post("/api/v1/projects", async (c) => {
    const input = await parseBody(c, projectInputSchema);
    return ok(c, await createProject(input, database), 201);
  });

  routes.get("/api/v1/projects/:id", async (c) => {
    const project = await getProjectById(parseId(c, "id"), database);
    if (!project) throw notFound("Project");
    return ok(c, project);
  });

  routes.patch("/api/v1/projects/:id", async (c) => {
    const input = await parseBody(c, projectInputSchema);
    const project = await updateProject(parseId(c, "id"), input, database);
    if (!project) throw notFound("Project");
    return ok(c, project);
  });

  routes.delete("/api/v1/projects/:id", async (c) => {
    const project = await deleteProject(parseId(c, "id"), database);
    if (!project) throw notFound("Project");
    return ok(c, project);
  });

  // staleness fingerprint for re-compose-on-dirty (app parity: empty for no rows)
  routes.get("/api/v1/projects/:id/report-signature", async (c) => {
    const id = parseId(c, "id");
    return ok(c, await gatherReportSignature(id, database));
  });

  // aggregated gather model: one call replacing the app's 10+ service walks
  routes.get("/api/v1/projects/:id/report-data", async (c) => {
    const id = parseId(c, "id");
    return ok(c, await gatherReportData(id, database));
  });

  return routes;
};
