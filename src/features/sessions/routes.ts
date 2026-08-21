import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  createSession,
  getSessionById,
  listSessionsByProjectId,
  updateSession,
} from "../../db/services/session.service";
import { notFound } from "../../lib/error";
import { compactUpdate, parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { createSessionSchema, updateSessionSchema } from "../../types/api";

// sessions for the engine arm flow (no IPC today, REST-first)
export const sessionRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  routes.get("/api/v1/projects/:projectId/sessions", async (c) => {
    const projectId = parseId(c, "projectId");
    return ok(c, await listSessionsByProjectId(projectId, database));
  });

  routes.post("/api/v1/sessions", async (c) => {
    const input = await parseBody(c, createSessionSchema);
    return ok(c, await createSession(input, database), 201);
  });

  routes.get("/api/v1/sessions/:id", async (c) => {
    const session = await getSessionById(parseId(c, "id"), database);
    if (!session) throw notFound("Session");
    return ok(c, session);
  });

  // service normalize honors name only (startedAt/endedAt are insert-time today)
  routes.patch("/api/v1/sessions/:id", async (c) => {
    const input = await parseBody(c, updateSessionSchema);
    const session = await updateSession(parseId(c, "id"), compactUpdate(input), database);
    if (!session) throw notFound("Session");
    return ok(c, session);
  });

  return routes;
};
