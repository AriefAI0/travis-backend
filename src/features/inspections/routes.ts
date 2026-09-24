import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  cancelInspection,
  listActiveBySessionId,
  startInspection,
  stopInspection,
} from "../../db/services/inspection.service";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  startInspectionSchema,
  stopInspectionSchema,
} from "../../types/api";

// Inspection lifecycle over HTTP: start, stop, cancel, active.
// flow: parse > inspection.service > ok()
export const inspectionRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  /* Inspection lifecycle — task-tree targets, layers, custom values */
  routes.post("/api/v1/inspections/start", async (c) => {
    const input = await parseBody(c, startInspectionSchema);
    return ok(c, await startInspection(input, database), 201);
  });

  // literal path first so :resultId can never shadow it
  routes.get("/api/v1/sessions/:sessionId/inspections/active", async (c) =>
    ok(c, await listActiveBySessionId(parseId(c, "sessionId"), database)),
  );

  routes.post("/api/v1/inspections/:resultId/stop", async (c) => {
    const resultId = parseId(c, "resultId");
    const input = await parseBody(c, stopInspectionSchema);
    return ok(c, await stopInspection(resultId, input, database));
  });

  routes.post("/api/v1/inspections/:resultId/cancel", async (c) =>
    ok(c, await cancelInspection(parseId(c, "resultId"), database)),
  );

  return routes;
};
