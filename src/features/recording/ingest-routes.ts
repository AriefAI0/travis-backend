// Direct ingest transport: admission, segment, close, status.
// The ticket travels only in Authorization — never a path, query, body, or log.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import type { DbOrTx } from "../../db/client";
import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  admitIngest,
  closeIngest,
  defaultThumbnailDispatch,
  getIngestStatus,
  minioSegmentStorage,
  parseBearerToken,
  parseSegmentContentLength,
  parseSegmentHeaders,
  SEGMENT_MAX_BYTES,
  storeIngestSegment,
  type SegmentStorage,
  type ThumbnailDispatch,
} from "./ingest-service";

const admissionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("master"),
    projectId: z.number().int().positive(),
    startEpoch: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("clip"),
    resultId: z.number().int().positive(),
    masterVideoId: z.number().int().positive(),
    startOffsetMs: z.number().int().min(0),
  }),
]);

// read the body with a hard cap: an oversized segment never lands in memory
const readCappedBody = async (c: Context, cap: number): Promise<Uint8Array> => {
  const reader = c.req.raw.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new AppError(413, "segment_too_large", `body: exceeds the ${cap} byte segment cap`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

// Factory form: tests inject the test db, a fake storage, and a dispatch spy.
export const ingestRoutes = (
  database?: DbOrTx,
  storage: SegmentStorage = minioSegmentStorage,
  dispatch: ThumbnailDispatch = defaultThumbnailDispatch,
) => {
  const routes = new Hono();

  // admission mints identity, so it alone carries the deployment gate
  routes.post("/api/v2/ingests", async (c) => {
    if (
      env.RECORDING_V2_TOKEN &&
      c.req.header("x-travis-deployment-token") !== env.RECORDING_V2_TOKEN
    ) {
      throw new AppError(401, "deployment_unauthorized", "Missing or invalid deployment token");
    }

    const body = await parseBody(c, admissionSchema);
    const admission = await admitIngest(body, database);
    return ok(c, admission, 201);
  });

  // one closed TS segment: headers and length are read before the body
  routes.post("/api/v2/ingests/:ingestId/segments", async (c) => {
    const ingestId = parseId(c, "ingestId");
    const requestHeaders = c.req.raw.headers;
    const segmentHeaders = parseSegmentHeaders(requestHeaders);
    const contentLength = parseSegmentContentLength(requestHeaders);
    const body = await readCappedBody(c, SEGMENT_MAX_BYTES);

    const outcome = await storeIngestSegment(
      {
        ingestId,
        authorization: c.req.header("authorization") ?? null,
        headers: segmentHeaders,
        contentLength,
        body,
        storage,
      },
      database,
    );
    // After the commit, never inside it: stills are best effort and must not
    // hold the segment response. Only a commit that advanced the prefix can
    // have made a new grid point due.
    if (!outcome.replayed && outcome.sequence === outcome.contiguousSequence) {
      if (outcome.kind === "master" && outcome.masterVideoId !== null) {
        dispatch.master(outcome.masterVideoId);
      }

      if (outcome.kind === "clip" && outcome.clipId !== null) {
        dispatch.clip(outcome.clipId);
      }
    }

    // a byte-identical replay is a 200, a fresh object is a 201
    return ok(c, outcome, outcome.replayed ? 200 : 201);
  });

  routes.post("/api/v2/ingests/:ingestId/close", async (c) => {
    const ingestId = parseId(c, "ingestId");
    const ticket = parseBearerToken(c.req.header("authorization") ?? null);
    const result = await closeIngest({ ingestId, ticket, dispatch }, database);
    return ok(c, result);
  });

  routes.get("/api/v2/ingests/:ingestId", async (c) => {
    const ingestId = parseId(c, "ingestId");
    const ticket = parseBearerToken(c.req.header("authorization") ?? null);
    return ok(c, await getIngestStatus(ingestId, ticket, database));
  });

  return routes;
};
