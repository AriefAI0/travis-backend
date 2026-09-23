import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  listSessionInspectionMarkers,
  listSessionInspectionRows,
} from "../../db/services/inspection.service";
import { parseId } from "../../lib/parse";
import { ok } from "../../lib/response";

// session timeline reads: event-table rows and playback layer markers
export const sessionTimelineRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  routes.get("/api/v1/sessions/:sessionId/results", async (c) =>
    ok(c, await listSessionInspectionRows(parseId(c, "sessionId"), database)),
  );

  routes.get("/api/v1/sessions/:sessionId/inspection-markers", async (c) =>
    ok(c, await listSessionInspectionMarkers(parseId(c, "sessionId"), database)),
  );

  return routes;
};
