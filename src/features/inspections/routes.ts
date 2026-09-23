import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  cancelInspectionV2,
  listActiveV2BySessionId,
  startInspectionV2,
  stopInspectionV2,
} from "../../db/services/inspection.service";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  startInspectionV2Schema,
  stopInspectionV2Schema,
} from "../../types/api";

// v2 inspection lifecycle over HTTP: start, stop, cancel, active.
// flow: parse > inspection.service > ok()
export const inspectionRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  /* v2 lifecycle — task-tree targets, layers, custom values */
  routes.post("/api/v1/inspections/v2/start", async (c) => {
    const input = await parseBody(c, startInspectionV2Schema);
    return ok(c, await startInspectionV2(input, database), 201);
  });

  // literal path first so :resultId can never shadow it
  routes.get("/api/v1/sessions/:sessionId/inspections/active", async (c) =>
    ok(c, await listActiveV2BySessionId(parseId(c, "sessionId"), database)),
  );

  routes.post("/api/v1/inspections/v2/:resultId/stop", async (c) => {
    const resultId = parseId(c, "resultId");
    const input = await parseBody(c, stopInspectionV2Schema);
    return ok(c, await stopInspectionV2(resultId, input, database));
  });

  routes.post("/api/v1/inspections/v2/:resultId/cancel", async (c) =>
    ok(c, await cancelInspectionV2(parseId(c, "resultId"), database)),
  );

  return routes;
};
