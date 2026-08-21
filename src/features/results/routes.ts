import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  getCpDetailByResultId,
  getCviDetailByResultId,
  getFmdDetailByResultId,
  getItemResultSidebar,
  getGviDetailByResultId,
  getResultEvidence,
  getResultMgiDetailByResultId,
  getScourDetailByResultId,
  listProjectSummary,
} from "../../db/services/result.service";
import { listResultImageSummariesByResultIds } from "../../db/services/result-media.service";
import { listMasterVideosByProjectId } from "../../db/services/video.service";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { resultIdsSchema } from "../../types/api";

// read-only views: sidebar, summary, evidence, typed details.
// App parity: "no data" is data:null, never 404.
export const resultRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  // per-item sidebar (sessions + results); null when item has no results
  routes.get("/api/v1/items/:itemId/results", async (c) => {
    const itemId = parseId(c, "itemId");
    return ok(c, await getItemResultSidebar(itemId, database));
  });

  // mirrors the app's result:listProjectRecordings channel
  routes.get("/api/v1/projects/:projectId/recordings", async (c) => {
    const projectId = parseId(c, "projectId");
    return ok(c, await listMasterVideosByProjectId(projectId, database));
  });

  routes.get("/api/v1/projects/:projectId/results/summary", async (c) => {
    const projectId = parseId(c, "projectId");
    return ok(c, await listProjectSummary(projectId, database));
  });

  // clips + images for one result; always arrays, never 404
  routes.get("/api/v1/results/:id/evidence", async (c) => {
    const resultId = parseId(c, "id");
    return ok(c, await getResultEvidence(resultId, database));
  });

  // typed details: null when the result has no detail of that type
  routes.get("/api/v1/results/:id/mgi", async (c) =>
    ok(c, await getResultMgiDetailByResultId(parseId(c, "id"), database)));
  routes.get("/api/v1/results/:id/cp", async (c) =>
    ok(c, await getCpDetailByResultId(parseId(c, "id"), database)));
  routes.get("/api/v1/results/:id/fmd", async (c) =>
    ok(c, await getFmdDetailByResultId(parseId(c, "id"), database)));
  routes.get("/api/v1/results/:id/scour", async (c) =>
    ok(c, await getScourDetailByResultId(parseId(c, "id"), database)));
  routes.get("/api/v1/results/:id/gvi", async (c) =>
    ok(c, await getGviDetailByResultId(parseId(c, "id"), database)));
  routes.get("/api/v1/results/:id/cvi", async (c) =>
    ok(c, await getCviDetailByResultId(parseId(c, "id"), database)));

  // batch read: resultId -> image summaries (read-only this phase)
  routes.post("/api/v1/images/by-result-ids", async (c) => {
    const body = await parseBody(c, resultIdsSchema);
    const images = await listResultImageSummariesByResultIds(body.resultIds, database);
    return ok(c, Object.fromEntries(images));
  });

  return routes;
};
