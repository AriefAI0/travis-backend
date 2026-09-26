import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import { getResultById } from "../../db/services/result.service";
import { listSessionsByProjectId } from "../../db/services/session.service";
import {
  getSessionPlaybackData,
  listActiveVideoClips,
  listUnfinishedSessions,
  listVideoClipPlaybackByResultIds,
} from "../../db/services/video.service";
import { findSessionById } from "../../db/repositories/session.repository";
import { mintMasterPlaybackUrl } from "../../db/services/recording-playback.service";
import { notFound } from "../../lib/error";
import { parseBody, parseId, parseQuery } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  activeClipsQuerySchema,
  playbackQuerySchema,
  resultIdsSchema,
  unfinishedRecordingsQuerySchema,
} from "../../types/api";

// READ-ONLY recording surface. Recording lifecycle lives on the direct ingest
// transport (/api/v2/ingests) — create there, close on idle timeout.
export const recordingRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  // recovery sweep: optional project filter (engine reads all by default)
  routes.get("/api/v1/recordings/unfinished", async (c) => {
    const query = parseQuery(c, unfinishedRecordingsQuerySchema);
    const rows = await listUnfinishedSessions(database);
    if (query.projectId === undefined) return ok(c, rows);

    const sessionIds = new Set(
      (await listSessionsByProjectId(query.projectId, database)).map((s) => s.sessionId),
    );
    return ok(c, rows.filter((row) => sessionIds.has(row.sessionId)));
  });

  // the id is the sessionId: the session IS the master recording
  routes.get("/api/v1/recordings/:id", async (c) => {
    const session = await findSessionById(parseId(c, "id"), database);
    if (!session) throw notFound("Session recording");
    return ok(c, session);
  });

  // playback bundle; the master plays as soon as segment zero is committed
  routes.get("/api/v1/recordings/:id/playback", async (c) => {
    const id = parseId(c, "id");
    const query = parseQuery(c, playbackQuerySchema);
    const playback = await getSessionPlaybackData(query.projectId, id, database);
    if (!playback) throw notFound("Master video playback");
    return ok(c, {
      ...playback,
      hlsUrl: await mintMasterPlaybackUrl(id, database),
    });
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

  return routes;
};
