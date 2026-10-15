import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  createSession,
  getSessionById,
  listSessionsByProjectId,
  updateSession,
} from "../../db/services/session.service";
import { callerOf, requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import { notFound } from "../../lib/error";
import { compactUpdate, parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { createSessionSchema, updateSessionSchema } from "../../types/api";

// sessions for the engine arm flow (no IPC today, REST-first)
// flow: requireUser > requireCan > service > ok
//
// No lifecycle rules by design: whoever holds the action may act on any session
// in the org. There is no owner check and no stuck-session override.
//
// The guard is scoped to this session prefix, never "*": Hono merges a
// sub-app's wildcard middleware at the mount prefix and would guard every
// feature mounted after this one. The project-scoped list route takes the guard
// inline instead, so it never sits in front of the project routes themselves.
export const sessionRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.use("/api/v1/sessions", requireUser(database));
  routes.use("/api/v1/sessions/*", requireUser(database));

  routes.get(
    "/api/v1/projects/:projectId/sessions",
    requireUser(database),
    requireCan("read", "Session"),
    async (c) => {
      const projectId = parseId(c, "projectId");
      return ok(c, await listSessionsByProjectId(projectId, callerOf(c), database));
    },
  );

  routes.post("/api/v1/sessions", requireCan("create", "Session"), async (c) => {
    const input = await parseBody(c, createSessionSchema);
    return ok(c, await createSession(input, callerOf(c), database), 201);
  });

  routes.get("/api/v1/sessions/:id", requireCan("read", "Session"), async (c) => {
    const session = await getSessionById(parseId(c, "id"), callerOf(c), database);
    if (!session) throw notFound("Session");
    return ok(c, session);
  });

  // service normalize honors name only (startedAt/endedAt are insert-time today)
  routes.patch("/api/v1/sessions/:id", requireCan("modify", "Session"), async (c) => {
    const input = await parseBody(c, updateSessionSchema);
    const session = await updateSession(
      parseId(c, "id"),
      compactUpdate(input),
      callerOf(c),
      database,
    );
    if (!session) throw notFound("Session");
    return ok(c, session);
  });

  return routes;
};
