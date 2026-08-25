import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../../lib/error";
import { ok } from "../../lib/response";
import { appendSegment, completePart, createSession, getArtifacts, getSessionStatus, heartbeat, reservePart, stopSession } from "./service";

// integer DB ids from the app side
const id = z.number().int().positive();

// app's receipt of a direct part upload: MinIO's ETag + the range it covers
const completeBody = z.object({
  etag: z.string().min(1),
  firstIndex: z.number().int().nonnegative(),
  lastIndex: z.number().int().nonnegative(),
  sizeBytes: z.number().int().positive(),
});

// server assigns the recording PK; clip create names its evidence result.
// strict: a stale client-assigned id (recordingId, clipId) is a 400, not a strip
const createBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("master"), projectId: id, sessionId: id }).strict(),
  z
    .object({
      kind: z.literal("clip"),
      projectId: id,
      sessionId: id,
      itemId: id,
      resultId: id,
      // optional: old callers keep the 0 default, no server clock exists
      startOffsetMs: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);

export const minioHandlerRoutes = new Hono();

minioHandlerRoutes.post("/api/minio_handler/sessions", async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    // surface the first zod issue so a rejected field names itself
    const issue = parsed.error.issues[0];
    const at = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new AppError(
      400,
      "bad_request",
      `body must be { kind: 'master', projectId, sessionId } or { kind: 'clip', projectId, sessionId, itemId, resultId, startOffsetMs? }. ${at}${issue?.message ?? "not valid json"}`,
    );
  }
  const rec = await createSession(parsed.data);
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

// flow: reserve > sticky part number + fresh presigned upload URL (direct upload)
minioHandlerRoutes.post("/api/minio_handler/sessions/:id/parts", async (c) =>
  ok(c, await reservePart(c.req.param("id"))),
);

// flow: complete > validate contiguity > commit ETag > advance durable marker
minioHandlerRoutes.post("/api/minio_handler/sessions/:id/parts/:partNumber/complete", async (c) => {
  const partNumber = Number(c.req.param("partNumber"));
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    throw new AppError(400, "bad_part_number", "partNumber must be an integer >= 1");
  }
  const parsed = completeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(400, "bad_request", "body must be { etag, firstIndex, lastIndex, sizeBytes }");
  }
  return ok(c, await completePart(c.req.param("id"), partNumber, parsed.data));
});

minioHandlerRoutes.post("/api/minio_handler/sessions/:id/heartbeat", (c) => ok(c, heartbeat(c.req.param("id"))));

minioHandlerRoutes.post("/api/minio_handler/sessions/:id/stop", async (c) => ok(c, await stopSession(c.req.param("id")), 202));

minioHandlerRoutes.get("/api/minio_handler/sessions/:id/artifacts", async (c) => ok(c, await getArtifacts(c.req.param("id"))));
