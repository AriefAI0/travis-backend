import type { Context } from "hono";

import type { AuditAction, AuditEntry } from "../db/services/audit.service";
import type { AuthVariables } from "./auth/middleware";

// Builds an audit entry from the request context, so a route names only what
// it changed. The actor and the org come from the token, never from the body.
export const auditFor = (
  c: Context<{ Variables: AuthVariables }>,
  entry: {
    action: AuditAction;
    resourceType: string;
    resourceId?: string | number | null;
    before?: unknown;
    after?: unknown;
  },
): AuditEntry => ({
  organizationId: c.get("organizationId"),
  userId: c.get("user").userId,
  ...entry,
});
