import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  getCpDetailByResultId,
  getCviDetailByResultId,
  getFmdDetailByResultId,
  getGviDetailByResultId,
  getResultEvidence,
  getResultMgiDetailByResultId,
  getScourDetailByResultId,
  listProjectSummary,
} from "../../db/services/result.service";
import { listResultImageSummariesByResultIds } from "../../db/services/result-media.service";
import {
  createAnnotatedUploadTicket,
  createImageUploadTicket,
  removeResultImage,
} from "../../db/services/result-image.service";
import { listMasterVideosByProjectId } from "../../db/services/video.service";
import { getTargetResultSidebar } from "../../db/services/target-results.service";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { createResultImageSchema, resultIdsSchema } from "../../types/api";

// read-only views: sidebar, summary, evidence, typed details.
// App parity: "no data" is data:null, never 404.
export const resultRoutes = (database?: DbOrTx) => {
  const routes = new Hono();


  // v2 target sidebars: results grouped by session for either target kind
  routes.get("/api/v1/main-components/:id/results", async (c) =>
    ok(c, await getTargetResultSidebar({ mainComponentId: parseId(c, "id") }, database)));
  routes.get("/api/v1/component-codes/:id/results", async (c) =>
    ok(c, await getTargetResultSidebar({ componentCodeId: parseId(c, "id") }, database)));

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

  // batch read: resultId -> image summaries
  routes.post("/api/v1/images/by-result-ids", async (c) => {
    const body = await parseBody(c, resultIdsSchema);
    const images = await listResultImageSummariesByResultIds(body.resultIds, database);
    return ok(c, Object.fromEntries(images));
  });

  // evidence image write: mint the row, hand back a presigned PUT.
  // Needs no clip — an image on a result with a failed recording still works.
  routes.post("/api/v1/results/:resultId/images", async (c) => {
    const body = await parseBody(c, createResultImageSchema);
    const ticket = await createImageUploadTicket(
      { resultId: parseId(c, "resultId"), ...body },
      database,
    );
    return ok(c, ticket, 201);
  });

  // annotated twin of an EXISTING image — same imageId, second upload
  routes.post("/api/v1/images/:imageId/annotated", async (c) =>
    ok(c, await createAnnotatedUploadTicket(parseId(c, "imageId"), database), 201),
  );

  routes.delete("/api/v1/images/:imageId", async (c) =>
    ok(c, await removeResultImage(parseId(c, "imageId"), database)),
  );

  return routes;
};
