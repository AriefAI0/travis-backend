import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { ForcedSubject } from "@casl/ability";

import type { DbOrTx } from "../../db/client";
import type { Caller } from "../caller";
import { listPermissionsByUser } from "../../db/repositories/user-permission.repository";
import { AppError } from "../error";
import { buildAbility, type AppAbility } from "./ability";
import { authFor } from "./auth";
import type { Action, Subject } from "./permissions";

// What a resolved caller looks like downstream. Never a token: the token stops
// here, so no handler can leak it.
export type AuthUser = {
  userId: string;
  // The session row this request came in on. A password change drops every
  // other session and keeps this one, so the caller stays signed in.
  sessionId: string;
  name: string;
  email: string;
  organizationId: number;
  disabled: boolean;
  mustChangePassword: boolean;
};

// Hono context carried by every guarded route.
export type AuthVariables = {
  user: AuthUser;
  organizationId: number;
  ability: AppAbility;
};

// flow: bearer header > better-auth session lookup > permission rows > ability
// A factory, not a global app.use: tests mount route factories only, and
// /health, /api/v2/hls, /api/v2/ingests and /api/v2/exports must stay open.
// The ability is built here, once per request, so requireCan never re-reads
// the rows and a revoke still bites on the next request.
export const requireUser = (database?: DbOrTx) =>
  createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const session = await authFor(database).api.getSession({
      headers: c.req.raw.headers,
    });

    const resolved = session?.user as (Partial<AuthUser> & { id?: string }) | undefined;
    if (!resolved?.id) {
      throw new AppError(401, "unauthorized", "Sign in to continue");
    }
    if (resolved.disabled) {
      throw new AppError(403, "forbidden", "This account is disabled");
    }
    if (typeof resolved.organizationId !== "number") {
      // every account is org-scoped; a missing org is a broken row, not a 401
      throw new AppError(403, "forbidden", "This account has no organization");
    }

    const user: AuthUser = {
      userId: resolved.id,
      sessionId: session?.session?.id ?? "",
      name: resolved.name ?? "",
      email: resolved.email ?? "",
      organizationId: resolved.organizationId,
      disabled: resolved.disabled ?? false,
      mustChangePassword: resolved.mustChangePassword ?? false,
    };

    c.set("user", user);
    c.set("organizationId", user.organizationId);
    c.set("ability", buildAbility(await listPermissionsByUser(user.userId, database)));

    await next();
  });

// flow: ability on the context > can() > 403 or the handler
// A subject instance is passed when the rule carries a condition, e.g. a
// Structure level.
export const requireCan = (
  action: Action,
  subject: Subject | ForcedSubject<Subject>,
) =>
  createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const ability = c.get("ability");
    if (!ability) {
      // requireCan without requireUser is a wiring mistake, not a client error
      throw new AppError(401, "unauthorized", "Sign in to continue");
    }
    if (!ability.can(action, subject)) {
      // a subject instance would print as [object Object]; name its type
      const label =
        typeof subject === "string" ? subject : subject.__caslSubjectType__;
      throw new AppError(403, "forbidden", `Not allowed to ${action} ${label}`);
    }

    await next();
  });

// The caller behind requireUser: the org for scoping, the user for the audit
// row. Every guarded handler builds one of these rather than reading the
// context twice.
export const callerOf = (c: Context<{ Variables: AuthVariables }>): Caller => ({
  userId: c.get("user").userId,
  organizationId: c.get("organizationId"),
});
