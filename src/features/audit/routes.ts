import { Hono } from "hono";

import type { DbOrTx } from "../../db/client";
import { listAuditLog } from "../../db/services/audit.service";
import { requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import { parseQuery } from "../../lib/parse";
import { ok } from "../../lib/response";
import { auditQuerySchema } from "../../types/api";

// The audit read. Admin only: the Viewer preset is granted no `AuditLog` right.
// flow: requireUser > requireCan > filters > page
// There is no write route, and there never will be: rows are written by the
// service that changed the data, inside that change's transaction.
const PREFIX = "/api/v1/audit-logs";

export const auditRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();
  // scoped to this prefix, never "*" — Hono merges a sub-app's wildcard
  // middleware at the mount prefix and would guard every feature after it
  routes.use(PREFIX, requireUser(database));
  routes.use(`${PREFIX}/*`, requireUser(database));

  routes.get(PREFIX, requireCan("read", "AuditLog"), async (c) => {
    const query = parseQuery(c, auditQuerySchema);
    return ok(c, await listAuditLog(c.get("organizationId"), query, database));
  });

  return routes;
};
