import { Hono } from "hono";
import { db, type DbOrTx } from "../../db/client";
import {
  getBsiDetailByResultId,
  getCgbDetailByResultId,
  getCiDetailByResultId,
  getCpDetailByResultId,
  getCviDetailByResultId,
  getDviDetailByResultId,
  getFmdDetailByResultId,
  getGviDetailByResultId,
  getPipelineDetailByResultId,
  getResultById,
  getResultEvidence,
  getResultFormState,
  getResultMgiDetailByResultId,
  getRiserDetailByResultId,
  getScourDetailByResultId,
  getSeabedDetailByResultId,
  listProjectSummary,
} from "../../db/services/result.service";
import { listResultImageSummariesByResultIds } from "../../db/services/result-media.service";
import {
  createAnnotatedUploadTicket,
  createImageUploadTicket,
  removeResultImage,
} from "../../db/services/result-image.service";
import { listSessionRecordingsByProjectId } from "../../db/services/video.service";
import { getTargetResultSidebar, getTargetResultsBatch } from "../../db/services/target-results.service";
import { projectIdOfTarget } from "../../db/services/task-structure.service";
import { findResultImageById } from "../../db/repositories/result-image.repository";
import { findProjectById } from "../../db/repositories/project.repository";
import { callerOf, requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import type { Caller } from "../../lib/caller";
import { notFound } from "../../lib/error";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { createResultImageSchema, resultIdsSchema, targetIdsSchema } from "../../types/api";

// read-only views: sidebar, summary, evidence, typed details.
// App parity: "no data" is data:null, never 404 — and that includes a row in
// another org, so an id can never be probed for existence.
//
// Scoping is a check-then-read rather than a filtered query. A read has no
// transaction to keep the check and the query together, and a stale check
// costs a null response, never a leak.
// flow: id > owning project > org check > read, else null
// Only these two prefixes are guarded with use(). Every other route here sits
// under a prefix another feature also owns — /api/v1/projects, /api/v1/images,
// /api/v1/descriptions — and a wildcard guard would run requireUser on that
// feature's routes too. Those take the guard inline instead.
const PREFIXES = ["/api/v1/results", "/api/v1/images"];

export const resultRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();
  // inline guard for a route under a shared prefix
  const guard = requireUser(database);

  for (const prefix of PREFIXES) {
    routes.use(prefix, requireUser(database));
    routes.use(`${prefix}/*`, requireUser(database));
  }

  // flow: a row's project > org check
  const projectVisible = async (projectId: number | null, caller: Caller) =>
    projectId !== null && (await findProjectById(projectId, caller.organizationId, database)) !== null;

  const resultVisible = async (resultId: number, caller: Caller) => {
    const row = await getResultById(resultId, database);
    return row !== null && (await projectVisible(row.projectId, caller));
  };

  const imageVisible = async (imageId: number, caller: Caller) => {
    const row = await findResultImageById(imageId, database);
    return row !== null && (await resultVisible(row.resultId, caller));
  };

  const targetVisible = async (
    target: { descriptionId?: number | null; partCodeId?: number | null },
    caller: Caller,
  ) => projectVisible(await projectIdOfTarget(target, database ?? db), caller);

  /* ---------- target sidebars ---------- */
  routes.get(
    "/api/v1/descriptions/:id/results",
    guard,
    requireCan("read", "Result"),
    async (c) => {
      const descriptionId = parseId(c, "id");
      const caller = callerOf(c);
      if (!(await targetVisible({ descriptionId }, caller))) return ok(c, []);

      return ok(c, await getTargetResultSidebar({ descriptionId }, database));
    },
  );

  routes.get("/api/v1/part-codes/:id/results", guard, requireCan("read", "Result"), async (c) => {
    const partCodeId = parseId(c, "id");
    const caller = callerOf(c);
    if (!(await targetVisible({ partCodeId }, caller))) return ok(c, []);

    return ok(c, await getTargetResultSidebar({ partCodeId }, database));
  });

  // batch target sidebars: one call for every visible grid row, capped at 100 ids
  routes.post("/api/v1/targets/results", guard, requireCan("read", "Result"), async (c) => {
    const body = await parseBody(c, targetIdsSchema);
    const caller = callerOf(c);

    // The contract is one entry per requested target, never a gap. Every id is
    // passed through, and one the caller may not see comes back blank — the
    // same shape the service gives an id that does not exist at all.
    const batch = await getTargetResultsBatch(body, database);

    for (const descriptionId of body.descriptionIds) {
      if (!(await targetVisible({ descriptionId }, caller))) {
        batch[`description:${descriptionId}`] = {
          target: { descriptionId, partCodeId: null },
          sessions: [],
        };
      }
    }
    for (const partCodeId of body.partCodeIds) {
      if (!(await targetVisible({ partCodeId }, caller))) {
        batch[`partCode:${partCodeId}`] = {
          target: { descriptionId: null, partCodeId },
          sessions: [],
        };
      }
    }

    return ok(c, batch);
  });

  /* ---------- project-scoped reads ---------- */
  // mirrors the app's result:listProjectRecordings channel
  routes.get(
    "/api/v1/projects/:projectId/recordings",
    guard,
    requireCan("read", "Recording"),
    async (c) => {
      const projectId = parseId(c, "projectId");
      if (!(await projectVisible(projectId, callerOf(c)))) return ok(c, []);

      return ok(c, await listSessionRecordingsByProjectId(projectId, database));
    },
  );

  routes.get(
    "/api/v1/projects/:projectId/results/summary",
    guard,
    requireCan("read", "Result"),
    async (c) => {
      const projectId = parseId(c, "projectId");
      if (!(await projectVisible(projectId, callerOf(c)))) return ok(c, null);

      return ok(c, await listProjectSummary(projectId, database));
    },
  );

  /* ---------- per-result reads ---------- */
  // clips + images for one result; always arrays, never 404
  routes.get("/api/v1/results/:id/evidence", requireCan("read", "Result"), async (c) => {
    const resultId = parseId(c, "id");
    if (!(await resultVisible(resultId, callerOf(c)))) return ok(c, { clips: [], images: [] });

    return ok(c, await getResultEvidence(resultId, database));
  });

  // row-only form state for Continue — null when the result is gone
  routes.get("/api/v1/results/:id/form-state", requireCan("read", "Result"), async (c) => {
    const resultId = parseId(c, "id");
    if (!(await resultVisible(resultId, callerOf(c)))) return ok(c, null);

    return ok(c, await getResultFormState(resultId, database));
  });

  // typed details: null when the result has no detail of that type
  const detail = (
    path: string,
    read: (resultId: number, database?: DbOrTx) => Promise<unknown>,
  ) =>
    routes.get(path, requireCan("read", "Result"), async (c) => {
      const resultId = parseId(c, "id");
      if (!(await resultVisible(resultId, callerOf(c)))) return ok(c, null);

      return ok(c, await read(resultId, database));
    });

  detail("/api/v1/results/:id/mgi", getResultMgiDetailByResultId);
  detail("/api/v1/results/:id/cp", getCpDetailByResultId);
  detail("/api/v1/results/:id/fmd", getFmdDetailByResultId);
  detail("/api/v1/results/:id/scour", getScourDetailByResultId);
  detail("/api/v1/results/:id/gvi", getGviDetailByResultId);
  detail("/api/v1/results/:id/cvi", getCviDetailByResultId);
  detail("/api/v1/results/:id/dvi", getDviDetailByResultId);
  detail("/api/v1/results/:id/bsi", getBsiDetailByResultId);
  // CAISSON is served under its payload kind "ci", like the stop route
  detail("/api/v1/results/:id/cgb", getCgbDetailByResultId);
  detail("/api/v1/results/:id/riser", getRiserDetailByResultId);
  detail("/api/v1/results/:id/ci", getCiDetailByResultId);
  detail("/api/v1/results/:id/seabed", getSeabedDetailByResultId);
  detail("/api/v1/results/:id/pipeline", getPipelineDetailByResultId);

  // batch read: resultId -> image summaries
  routes.post("/api/v1/images/by-result-ids", requireCan("read", "Result"), async (c) => {
    const body = await parseBody(c, resultIdsSchema);
    const caller = callerOf(c);

    const visible: number[] = [];
    for (const resultId of body.resultIds) {
      if (await resultVisible(resultId, caller)) visible.push(resultId);
    }

    return ok(c, Object.fromEntries(await listResultImageSummariesByResultIds(visible, database)));
  });

  /* ---------- evidence image writes ---------- */
  // evidence image write: mint the row, hand back a presigned PUT.
  // Needs no clip — an image on a result with a failed recording still works.
  routes.post(
    "/api/v1/results/:resultId/images",
    requireCan("create", "Result"),
    async (c) => {
      const resultId = parseId(c, "resultId");
      const caller = callerOf(c);
      if (!(await resultVisible(resultId, caller))) throw notFound("Result");

      const body = await parseBody(c, createResultImageSchema);
      const ticket = await createImageUploadTicket({ resultId, ...body }, caller, database);
      return ok(c, ticket, 201);
    },
  );

  // annotated twin of an EXISTING image — same imageId, second upload
  routes.post("/api/v1/images/:imageId/annotated", requireCan("modify", "Result"), async (c) => {
    const imageId = parseId(c, "imageId");
    const caller = callerOf(c);
    if (!(await imageVisible(imageId, caller))) throw notFound("Image");

    return ok(c, await createAnnotatedUploadTicket(imageId, caller, database), 201);
  });

  routes.delete("/api/v1/images/:imageId", requireCan("remove", "Result"), async (c) => {
    const imageId = parseId(c, "imageId");
    const caller = callerOf(c);
    if (!(await imageVisible(imageId, caller))) throw notFound("Image");

    return ok(c, await removeResultImage(imageId, caller, database));
  });

  return routes;
};
