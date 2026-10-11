import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import { getSessionById } from "../../db/services/session.service";
import {
  cancelInspection,
  listActiveBySessionId,
  startInspection,
  stopInspection,
} from "../../db/services/inspection.service";
import { callerOf, requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import { notFound } from "../../lib/error";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  startInspectionSchema,
  stopInspectionSchema,
} from "../../types/api";

// Inspection lifecycle over HTTP: start, stop, cancel, active.
// flow: requireUser > requireCan > service > ok()
//
// An inspection is a result, so every route carries the Result subject.
// Cancel is a draft the operator discards, not a finished result, so it needs
// `create Result` — the right that starts one. `remove Result` stays the
// admin's permanent removal of a finished result with its evidence.
//
// Both prefixes are shared: /api/v1/sessions with the sessions and timeline
// features, /api/v1/inspections with nothing else yet. The guards go inline so
// a wildcard can never reach another feature's routes.
export const inspectionRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  /* Inspection lifecycle — task-tree targets, layers, custom values */
  routes.post(
    "/api/v1/inspections/start",
    requireUser(database),
    requireCan("create", "Result"),
    async (c) => {
      const input = await parseBody(c, startInspectionSchema);
      return ok(c, await startInspection(input, callerOf(c), database), 201);
    },
  );

  // literal path first so :resultId can never shadow it
  routes.get(
    "/api/v1/sessions/:sessionId/inspections/active",
    requireUser(database),
    requireCan("read", "Result"),
    async (c) => {
      const sessionId = parseId(c, "sessionId");
      // A session in another org reads as absent, so the id cannot be probed.
      if (!(await getSessionById(sessionId, callerOf(c), database))) throw notFound("Session");
      return ok(c, await listActiveBySessionId(sessionId, database));
    },
  );

  routes.post(
    "/api/v1/inspections/:resultId/stop",
    requireUser(database),
    requireCan("modify", "Result"),
    async (c) => {
      const resultId = parseId(c, "resultId");
      const input = await parseBody(c, stopInspectionSchema);
      return ok(c, await stopInspection(resultId, input, callerOf(c), database));
    },
  );

  routes.post(
    "/api/v1/inspections/:resultId/cancel",
    requireUser(database),
    requireCan("create", "Result"),
    async (c) => ok(c, await cancelInspection(parseId(c, "resultId"), callerOf(c), database)),
  );

  return routes;
};
