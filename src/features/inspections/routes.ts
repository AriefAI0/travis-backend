import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  cancelInspection,
  getActiveInspectionByPair,
  listOpenInspectionsBySessionId,
  startInspection,
  stopInspection,
} from "../../db/services/inspection.service";
import { parseBody, parseId, parseQuery } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  activeInspectionQuerySchema,
  startInspectionSchema,
  stopInspectionSchema,
} from "../../types/api";

// inspection lifecycle over HTTP: start, stop, cancel, active.
// flow: parse > inspection.service > ok()
export const inspectionRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  // literal path first so :resultId can never shadow it
  routes.get("/api/v1/inspections/active", async (c) => {
    const query = parseQuery(c, activeInspectionQuerySchema);
    return ok(
      c,
      await getActiveInspectionByPair(
        query.sessionId,
        query.itemId,
        query.inspectionTypeCode,
        database,
      ),
    );
  });

  // session-scoped: open results + clip state for the app's stop-master dialog
  routes.get("/api/v1/sessions/:sessionId/open-inspections", async (c) =>
    ok(c, await listOpenInspectionsBySessionId(parseId(c, "sessionId"), database)),
  );

  routes.post("/api/v1/inspections/start", async (c) => {
    const input = await parseBody(c, startInspectionSchema);
    return ok(c, await startInspection(input, database), 201);
  });

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
