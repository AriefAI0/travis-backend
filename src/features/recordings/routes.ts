import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  cancelInspectionClip,
  startInspectionClip,
  startInspectionClipFromRecording,
  stopInspectionClip,
} from "../../db/services/inspection-clip.service";
import { getResultById } from "../../db/services/result.service";
import { listSessionsByProjectId } from "../../db/services/session.service";
import {
  createMasterVideo,
  getMasterVideoById,
  getMasterVideoPlaybackData,
  listActiveVideoClips,
  listUnfinishedMasterVideos,
  listVideoClipPlaybackByResultIds,
  markMasterVideoFinalizationFailed,
  markMasterVideoFinalized,
  markMasterVideoInterrupted,
} from "../../db/services/video.service";
import { notFound } from "../../lib/error";
import { parseBody, parseId, parseQuery } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  activeClipsQuerySchema,
  createMasterVideoSchema,
  failMasterVideoSchema,
  finalizeMasterVideoSchema,
  interruptMasterVideoSchema,
  playbackQuerySchema,
  resultIdsSchema,
  startInspectionClipSchema,
  startRecordingInspectionClipSchema,
  stopInspectionClipBodySchema,
  unfinishedRecordingsQuerySchema,
} from "../../types/api";

// TWO resources: /recordings (masters, engine lifecycle) + /clips (inspection
// lifecycle). Static paths registered before :id siblings.
export const recordingRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  // engine registers a master before first segment lands
  routes.post("/api/v1/recordings", async (c) => {
    const input = await parseBody(c, createMasterVideoSchema);
    // startedAt arrives as ISO string over REST, service wants Date
    const video = await createMasterVideo(
      {
        ...input,
        startedAt: input.startedAt != null ? new Date(input.startedAt) : input.startedAt,
      },
      database,
    );
    return ok(c, video, 201);
  });

  // recovery sweep: optional project filter (engine reads all by default)
  routes.get("/api/v1/recordings/unfinished", async (c) => {
    const query = parseQuery(c, unfinishedRecordingsQuerySchema);
    const rows = await listUnfinishedMasterVideos(database);
    if (query.projectId === undefined) return ok(c, rows);

    const sessionIds = new Set(
      (await listSessionsByProjectId(query.projectId, database)).map((s) => s.sessionId),
    );
    return ok(c, rows.filter((row) => sessionIds.has(row.sessionId)));
  });

  routes.get("/api/v1/recordings/:id", async (c) => {
    const video = await getMasterVideoById(parseId(c, "id"), database);
    if (!video) throw notFound("Master video");
    return ok(c, video);
  });

  // playback bundle; non-finalized throws -> 409 via onError map
  routes.get("/api/v1/recordings/:id/playback", async (c) => {
    const id = parseId(c, "id");
    const query = parseQuery(c, playbackQuerySchema);
    const playback = await getMasterVideoPlaybackData(query.projectId, id, database);
    if (!playback) throw notFound("Master video playback");
    return ok(c, playback);
  });

  routes.post("/api/v1/recordings/:id/finalize", async (c) => {
    const body = await parseBody(c, finalizeMasterVideoSchema);
    const video = await markMasterVideoFinalized(
      parseId(c, "id"),
      {
        stoppedAt: new Date(body.stoppedAt),
        durationMs: body.durationMs,
        fileSize: body.fileSize,
        endEpoch: body.endEpoch,
      },
      database,
    );
    if (!video) throw notFound("Master video");
    return ok(c, video);
  });

  routes.post("/api/v1/recordings/:id/fail", async (c) => {
    const body = await parseBody(c, failMasterVideoSchema);
    const video = await markMasterVideoFinalizationFailed(parseId(c, "id"), body.error, database);
    if (!video) throw notFound("Master video");
    return ok(c, video);
  });

  routes.post("/api/v1/recordings/:id/interrupt", async (c) => {
    const body = await parseBody(c, interruptMasterVideoSchema);
    const video = await markMasterVideoInterrupted(
      parseId(c, "id"),
      { recoveryStatus: body.recoveryStatus, fileSize: body.fileSize, error: body.error },
      database,
    );
    if (!video) throw notFound("Master video");
    return ok(c, video);
  });

  routes.post("/api/v1/clips", async (c) => {
    const input = await parseBody(c, startInspectionClipSchema);
    return ok(c, await startInspectionClip(input, database), 201);
  });

  // resolve session item + denorm ids server-side, one call for the engine
  routes.post("/api/v1/clips/from-recording", async (c) => {
    const input = await parseBody(c, startRecordingInspectionClipSchema);
    return ok(c, await startInspectionClipFromRecording(input, database), 201);
  });

  // batch read: resultId -> playback clips (keys stringify in JSON)
  routes.post("/api/v1/clips/by-result-ids", async (c) => {
    const body = await parseBody(c, resultIdsSchema);
    const clips = await listVideoClipPlaybackByResultIds(body.resultIds, database);
    return ok(c, Object.fromEntries(clips));
  });

  // open clips (endOffsetMs null); optional project/session filter via result
  routes.get("/api/v1/clips/active", async (c) => {
    const query = parseQuery(c, activeClipsQuerySchema);
    const rows = await listActiveVideoClips(database);
    if (query.projectId === undefined && query.sessionId === undefined) {
      return ok(c, rows);
    }

    // clips carry only resultId; cache parent results across rows
    const results = new Map<number, Awaited<ReturnType<typeof getResultById>>>();
    const matches = async (resultId: number) => {
      const result =
        results.get(resultId) ?? (await getResultById(resultId, database));
      results.set(resultId, result);
      if (!result) return false;
      if (query.projectId !== undefined && result.projectId !== query.projectId) return false;
      if (query.sessionId !== undefined && result.sessionId !== query.sessionId) return false;
      return true;
    };

    const filtered: typeof rows = [];
    for (const row of rows) {
      if (await matches(row.resultId)) filtered.push(row);
    }
    return ok(c, filtered);
  });

  // flow: complete clip > update result > write typed detail, one tx
  routes.post("/api/v1/clips/:id/stop", async (c) => {
    const body = await parseBody(c, stopInspectionClipBodySchema);
    const lifecycle = await stopInspectionClip(
      { clipId: parseId(c, "id"), ...body },
      database,
    );
    if (!lifecycle) throw notFound("Video clip");
    return ok(c, lifecycle);
  });

  // flow: check clip open > delete clip > delete result, one tx
  routes.post("/api/v1/clips/:id/cancel", async (c) => {
    const lifecycle = await cancelInspectionClip({ clipId: parseId(c, "id") }, database);
    if (!lifecycle) throw notFound("Video clip");
    return ok(c, lifecycle);
  });

  return routes;
};
