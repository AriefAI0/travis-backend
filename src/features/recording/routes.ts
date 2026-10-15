import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import { getResultById } from "../../db/services/result.service";
import { getSessionById } from "../../db/services/session.service";
import {
  getSessionPlaybackData,
  listActiveVideoClips,
  listUnfinishedSessions,
  listVideoClipPlaybackByResultIds,
} from "../../db/services/video.service";
import {
  findProjectById,
  listProjectIdsByOrganizationId,
} from "../../db/repositories/project.repository";
import { mintMasterPlaybackUrl } from "../../db/services/recording-playback.service";
import { callerOf, requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import type { Caller } from "../../lib/caller";
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
// flow: requireUser > requireCan > project in org > service > ok
//
// Playback is its own subject, `Recording`, so an admin can withhold it
// without touching `read Session`.
//
// Four prefixes, none shared with another feature: /api/v1/recordings and
// /api/v1/clips are this feature's own.
export const recordingRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  for (const prefix of ["/api/v1/recordings", "/api/v1/clips"]) {
    routes.use(prefix, requireUser(database));
    routes.use(`${prefix}/*`, requireUser(database));
  }

  // The one read that cannot join the project table: an id set for this org.
  const projectIdsInOrg = (caller: Caller) =>
    listProjectIdsByOrganizationId(caller.organizationId, database);

  // A project in another org reads as absent, never as forbidden.
  const projectVisible = async (projectId: number, caller: Caller) =>
    (await findProjectById(projectId, caller.organizationId, database)) !== null;

  // recovery sweep: optional project filter (engine reads all by default)
  routes.get("/api/v1/recordings/unfinished", requireCan("read", "Recording"), async (c) => {
    const query = parseQuery(c, unfinishedRecordingsQuerySchema);
    const inOrg = new Set(await projectIdsInOrg(callerOf(c)));
    const rows = (await listUnfinishedSessions(database)).filter((row) =>
      inOrg.has(row.projectId),
    );
    if (query.projectId === undefined) return ok(c, rows);

    return ok(c, rows.filter((row) => row.projectId === query.projectId));
  });

  // the id is the sessionId: the session IS the master recording
  routes.get("/api/v1/recordings/:id", requireCan("read", "Recording"), async (c) => {
    const session = await getSessionById(parseId(c, "id"), callerOf(c), database);
    if (!session) throw notFound("Session recording");
    return ok(c, session);
  });

  // playback bundle; the master plays as soon as segment zero is committed
  routes.get("/api/v1/recordings/:id/playback", requireCan("read", "Recording"), async (c) => {
    const id = parseId(c, "id");
    const query = parseQuery(c, playbackQuerySchema);
    const caller = callerOf(c);

    // The session's own project is the one that counts: a query naming another
    // project is a mismatch, and reads as absent.
    const session = await getSessionById(id, caller, database);
    if (!session || session.projectId !== query.projectId) {
      throw notFound("Master video playback");
    }

    const playback = await getSessionPlaybackData(query.projectId, id, database);
    if (!playback) throw notFound("Master video playback");
    return ok(c, {
      ...playback,
      hlsUrl: await mintMasterPlaybackUrl(id, database),
    });
  });

  // batch read: resultId -> playback clips (keys stringify in JSON).
  // One entry per requested id, never a gap: a result outside the org comes
  // back with no clips, the same shape the service gives an unknown id.
  routes.post("/api/v1/clips/by-result-ids", requireCan("read", "Recording"), async (c) => {
    const body = await parseBody(c, resultIdsSchema);
    const caller = callerOf(c);

    const visible: number[] = [];
    for (const resultId of body.resultIds) {
      const row = await getResultById(resultId, database);
      if (row && (await projectVisible(row.projectId, caller))) visible.push(resultId);
    }

    return ok(c, Object.fromEntries(await listVideoClipPlaybackByResultIds(visible, database)));
  });

  // open clips (endOffsetMs null); optional project/session filter via result
  routes.get("/api/v1/clips/active", requireCan("read", "Recording"), async (c) => {
    const query = parseQuery(c, activeClipsQuerySchema);
    const caller = callerOf(c);
    const inOrg = new Set(await projectIdsInOrg(caller));
    const rows = await listActiveVideoClips(database);

    // clips carry only resultId; cache parent results across rows. With no
    // filter the org check alone decides, so an unfiltered read still returns
    // only the caller's org.
    const results = new Map<number, Awaited<ReturnType<typeof getResultById>>>();
    const matches = async (resultId: number) => {
      const result =
        results.get(resultId) ?? (await getResultById(resultId, database));
      results.set(resultId, result);
      if (!result) return false;
      if (!inOrg.has(result.projectId)) return false;
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
