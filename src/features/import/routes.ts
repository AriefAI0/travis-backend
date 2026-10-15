import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import { importProjectTaskStructure } from "../../db/services/import.service";
import { structureAt } from "../../lib/auth/ability";
import {
  callerOf,
  requireCan,
  requireUser,
  type AuthVariables,
} from "../../lib/auth/middleware";
import { parseBody } from "../../lib/parse";
import { ok } from "../../lib/response";
import { importTaskStructureSchema } from "../../types/api";

// Bulk import (parse > service > ok). One request carries a whole sheet, and the
// service lands it in one transaction, so a failure writes nothing at all.
// A dryRun walks the same path and rolls back, which is what the app previews.
// flow: requireUser > requireCan(Structure) > import > ok
export const importRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const PREFIX = "/api/v1/import";
  // scoped to this prefix, never "*": a wildcard guards every feature after it
  routes.use(PREFIX, requireUser(database));
  routes.use(`${PREFIX}/*`, requireUser(database));

  routes.post(
    PREFIX + "/task-structure",
    requireCan("create", structureAt("taskGroup")),
    async (c) => {
      const input = await parseBody(c, importTaskStructureSchema);
      return ok(c, await importProjectTaskStructure(input, callerOf(c), database));
    },
  );

  return routes;
};
