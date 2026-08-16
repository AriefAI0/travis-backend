import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../../lib/error";
import { ok } from "../../lib/response";
import { appendSegment, createSession, getSessionStatus, heartbeat, stopSession } from "./service";

const createBody = z.object({
  appSessionId: z.string().min(1),
  kind: z.enum(["master", "clip"]),
});

export const minioHandlerRoutes = new Hono();

minioHandlerRoutes.post("/api/minio_handler/sessions", async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(400, "bad_request", "body must be { appSessionId: string, kind: 'master' | 'clip' }");
  }
  const rec = await createSession(parsed.data.appSessionId, parsed.data.kind);
  return ok(c, rec, 201);
});

minioHandlerRoutes.get("/api/minio_handler/sessions/:id", (c) => ok(c, getSessionStatus(c.req.param("id"))));

minioHandlerRoutes.post("/api/minio_handler/sessions/:id/segments", async (c) => {
  const idx = Number(c.req.query("index"));
  if (!Number.isInteger(idx) || idx < 0) {
    throw new AppError(400, "bad_index", "query param index (integer >= 0) is required");
  }
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength === 0) {
    throw new AppError(400, "empty_body", "segment body must not be empty");
  }
  const res = await appendSegment(c.req.param("id"), idx, body);
  return ok(c, res);
});

minioHandlerRoutes.post("/api/minio_handler/sessions/:id/heartbeat", (c) => ok(c, heartbeat(c.req.param("id"))));

minioHandlerRoutes.post("/api/minio_handler/sessions/:id/stop", async (c) => ok(c, await stopSession(c.req.param("id")), 202));
