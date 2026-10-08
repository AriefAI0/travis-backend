import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import { importProjectTaskStructure } from "../../db/services/import.service";
import { parseBody } from "../../lib/parse";
import { ok } from "../../lib/response";
import { importTaskStructureSchema } from "../../types/api";

// Bulk import (parse > service > ok). One request carries a whole sheet, and the
// service lands it in one transaction, so a failure writes nothing at all.
// A dryRun walks the same path and rolls back, which is what the app previews.
export const importRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  routes.post("/api/v1/import/task-structure", async (c) => {
    const input = await parseBody(c, importTaskStructureSchema);
    return ok(c, await importProjectTaskStructure(input, database));
  });

  return routes;
};
