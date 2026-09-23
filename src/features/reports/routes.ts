import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import { AppError } from "../../lib/error";
import { parseId } from "../../lib/parse";

// report placeholder only — no report API wiring in this redesign
export const reportRoutes = (_database?: DbOrTx) => {
  const routes = new Hono();

  routes.get("/api/v1/projects/:projectId/report/preview", (c) => {
    parseId(c, "projectId");
    throw new AppError(501, "not_implemented", "Report generation is not wired yet");
  });

  return routes;
};
