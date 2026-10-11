import { Hono, type Context } from "hono";
import type { DbOrTx } from "../../db/client";
import { getSessionById } from "../../db/services/session.service";
import {
  listSessionInspectionMarkers,
  listSessionInspectionRows,
} from "../../db/services/inspection.service";
import { callerOf, requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import { notFound } from "../../lib/error";
import { parseId } from "../../lib/parse";
import { ok } from "../../lib/response";

// session timeline reads: event-table rows and playback layer markers
// flow: requireUser > requireCan > session in org > read
//
// The guard is inline on each route, never a "*" or a session wildcard. This
// feature shares /api/v1/sessions with the sessions feature and mounts before
// it, so a wildcard here would double-guard every session route after it.
export const sessionTimelineRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  // The org check rides on getSessionById: a session in another org reads as
  // absent, so the id can never be probed for existence.
  const scopedSessionId = async (c: Context<{ Variables: AuthVariables }>) => {
    const sessionId = parseId(c, "sessionId");
    if (!(await getSessionById(sessionId, callerOf(c), database))) throw notFound("Session");
    return sessionId;
  };

  routes.get(
    "/api/v1/sessions/:sessionId/results",
    requireUser(database),
    requireCan("read", "Result"),
    async (c) => ok(c, await listSessionInspectionRows(await scopedSessionId(c), database)),
  );

  routes.get(
    "/api/v1/sessions/:sessionId/inspection-markers",
    requireUser(database),
    requireCan("read", "Result"),
    async (c) => ok(c, await listSessionInspectionMarkers(await scopedSessionId(c), database)),
  );

  return routes;
};
