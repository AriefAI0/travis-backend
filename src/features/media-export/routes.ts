// Clip MKV export plus the old v2 stub.
//
// The real surface is /api/v1/clips/:clipId/export: a durable job row, a
// status read, and a stored-name download URL. The v2 routes stay 501 so no
// client builds on a contract this build never honours.

import { Hono } from "hono";

import type { DbOrTx } from "../../db/client";
import { AppError } from "../../lib/error";
import { notFound } from "../../lib/error";
import {
  callerOf,
  requireCan,
  requireUser,
  type AuthVariables,
} from "../../lib/auth/middleware";
import type { Caller } from "../../lib/caller";
import { parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { findProjectById } from "../../db/repositories/project.repository";
import { findSessionById } from "../../db/repositories/session.repository";
import { findVideoClipById } from "../../db/repositories/video-clip.repository";
import { findPlayableIngestRecord } from "../../db/repositories/recording-ingest.repository";
import {
  clipExportState,
  getClipExport,
  getClipExportDownload,
  startClipExport,
} from "../../db/services/clip-export.service";

// The body POST /api/v2/exports will accept, stated once and returned with
// every stub answer.
const EXPORT_REQUEST_SHAPE = {
  kind: "master | clip",
  targetId: "positive integer: masterVideoId, or clipId when kind is clip",
  startMs: "optional non-negative integer; defaults to the recording start",
  endMs: "optional non-negative integer; defaults to the recording end",
} as const;

// The key the finished artifact will occupy, named so the shape is fixed
// before the work exists: the recorded range's frozen key_prefix, then a
// fixed tail. No leaf minter exists yet, so no builder lives in paths.ts.
const EXPORT_ARTIFACT_KEY = "<frozen key_prefix>/exports/<exportId>.mkv";

// The status answer GET /api/v2/exports/:exportId will carry.
const EXPORT_STATUS_SHAPE = {
  exportId: "positive integer",
  state: "requested | processing | ready | failed",
  objectKey: "the artifact key above, once ready",
  sizeBytes: "artifact size, once ready",
} as const;

const notImplemented = (what: string, shape: Record<string, unknown>): AppError =>
  new AppError(501, "not_implemented", `${what} is not implemented`, {
    requestShape: shape,
    artifactKey: EXPORT_ARTIFACT_KEY,
  });

// Factory form, matching every other feature route.
export const exportRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  // Accepts nothing yet, on purpose: a stub that half-validates teaches a
  // client a contract this build cannot honour.
  routes.post("/api/v2/exports", () => {
    throw notImplemented("Recording export", EXPORT_REQUEST_SHAPE);
  });

  routes.get("/api/v2/exports/:exportId", () => {
    throw notImplemented("Recording export status", EXPORT_STATUS_SHAPE);
  });

  // org scoping walks clip > session > project, then reads as absent
  const clipVisible = async (clipId: number, caller: Caller) => {
    const clip = await findVideoClipById(clipId, database);
    if (!clip) return false;
    const session = await findSessionById(clip.sessionId, database);
    if (!session) return false;
    return (await findProjectById(session.projectId, caller.organizationId, database)) !== null;
  };

  routes.post(
    "/api/v1/clips/:clipId/export",
    requireUser(database),
    requireCan("read", "Recording"),
    async (c) => {
      const clipId = parseId(c, "clipId");
      const caller = callerOf(c);
      if (!(await clipVisible(clipId, caller))) throw notFound("Clip");

      const clip = await findVideoClipById(clipId, database);
      if (!clip || clip.endOffsetMs === null) {
        throw new AppError(409, "clip_open", `clip ${clipId} is still recording`);
      }
      const ingest = await findPlayableIngestRecord({ kind: "clip", id: clipId }, database);
      if (!ingest) {
        throw new AppError(
          409,
          "no_playable_ingest",
          `clip ${clipId} has no playable ingest`,
        );
      }

      const job = await startClipExport(clipId, database);
      return ok(c, clipExportState(job), 202);
    },
  );

  routes.get(
    "/api/v1/clips/:clipId/export",
    requireUser(database),
    requireCan("read", "Recording"),
    async (c) => {
      const clipId = parseId(c, "clipId");
      if (!(await clipVisible(clipId, callerOf(c)))) throw notFound("Clip");

      const state = await getClipExport(clipId, database);
      if (!state) throw notFound(`clip ${clipId} export`);
      return ok(c, state);
    },
  );

  routes.get(
    "/api/v1/clips/:clipId/export/download-url",
    requireUser(database),
    requireCan("read", "Recording"),
    async (c) => {
      const clipId = parseId(c, "clipId");
      if (!(await clipVisible(clipId, callerOf(c)))) throw notFound("Clip");

      return ok(c, await getClipExportDownload(clipId, database));
    },
  );

  return routes;
};
