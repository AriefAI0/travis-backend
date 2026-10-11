import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  createResultRecord,
  deleteRestrictedAccessById,
  listRestrictedAccessRecordsByProjectId,
  updateRestrictedAccessRemarks,
} from "../../db/repositories/result.repository";
import { notFound } from "../../lib/error";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  createRestrictedAccessSchema,
  updateRestrictedAccessSchema,
} from "../../types/api";

// restricted-access marks (parse > repository > ok); the partial unique index
// answers duplicates with 409 and a missing target with 404, via onError
export const restrictedAccessRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  routes.get("/api/v1/projects/:projectId/restricted-access", async (c) => {
    const projectId = parseId(c, "projectId");
    return ok(c, await listRestrictedAccessRecordsByProjectId(projectId, database));
  });

  routes.post("/api/v1/restricted-access", async (c) => {
    const input = await parseBody(c, createRestrictedAccessSchema);
    // an RA row is sessionless: no session, no layer, ordinal 0 unused
    const row = await createResultRecord(
      {
        ...input,
        inspectionTypeCode: "RA",
        isRa: true,
        sessionId: null,
        displayNumber: 0,
      },
      database,
    );
    return ok(c, row, 201);
  });

  // The mark is created when its card opens, so the operator's remarks land
  // here afterwards. A null clears them.
  routes.patch("/api/v1/restricted-access/:id", async (c) => {
    const input = await parseBody(c, updateRestrictedAccessSchema);
    const row = await updateRestrictedAccessRemarks(
      parseId(c, "id"),
      input.remarks ?? null,
      database,
    );
    if (!row) throw notFound("Restricted access mark");
    return ok(c, row);
  });

  routes.delete("/api/v1/restricted-access/:id", async (c) => {
    const row = await deleteRestrictedAccessById(parseId(c, "id"), database);
    if (!row) throw notFound("Restricted access mark");
    return ok(c, row);
  });

  return routes;
};
