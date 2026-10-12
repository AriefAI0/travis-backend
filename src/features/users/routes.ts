import { Hono } from "hono";

import type { DbOrTx } from "../../db/client";
import {
  createUser,
  getOrgUser,
  listOwnPermissions,
  listUsers,
  mintPassword,
  replaceUserPermissions,
  resetUserPassword,
  updateOwnAccount,
  updateUser,
} from "../../db/services/user.service";
import {
  callerOf,
  requireCan,
  requireUser,
  type AuthVariables,
} from "../../lib/auth/middleware";
import { notFound } from "../../lib/error";
import { compactUpdate, parseBody } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  createUserSchema,
  replacePermissionsSchema,
  updateOwnAccountSchema,
  updateUserSchema,
} from "../../types/api";

// The admin surface: who exists, what they may do, and how to get them back in.
// flow: requireUser > requireCan > service > ok
// Every route is org-scoped, so a cross-org id reads as a 404.
//
// The guard is scoped to this feature's own prefix, never "*". Hono merges a
// sub-app's wildcard middleware at the mount prefix, so a `use("*")` here would
// run requireUser on every route of every feature mounted after it.
const PREFIX = "/api/v1/users";

export const userRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();
  routes.use(PREFIX, requireUser(database));
  routes.use(`${PREFIX}/*`, requireUser(database));

  // Registered first: `/users/me/permissions` also matches `/users/:id/...`,
  // and Hono takes the first match.
  // Any signed-in user reads their own rows, to know what to ask an admin for.
  routes.get("/api/v1/users/me/permissions", async (c) =>
    ok(c, await listOwnPermissions(c.get("user").userId, database)),
  );

  // Self-service: the caller edits their own display name and password. No
  // right is needed beyond being signed in, and no admin can read the result.
  // Registered before `/users/:id` so "me" is never read as a user id.
  routes.patch("/api/v1/users/me", async (c) => {
    const input = await parseBody(c, updateOwnAccountSchema);
    const user = await updateOwnAccount(
      c.get("user").userId,
      c.get("user").sessionId,
      input,
      database,
    );

    return ok(c, {
      id: user.id,
      name: user.name,
      email: user.email,
      organizationId: user.organizationId,
      mustChangePassword: user.mustChangePassword,
      disabled: user.disabled,
    });
  });

  routes.get("/api/v1/users", requireCan("read", "User"), async (c) =>
    ok(c, await listUsers(c.get("organizationId"), database)),
  );

  // The rows behind the tick sheet: what the account holds right now, so the
  // grid opens on the truth rather than on the preset label.
  routes.get("/api/v1/users/:id/permissions", requireCan("manage", "Permission"), async (c) => {
    const userId = c.req.param("id");
    const target = await getOrgUser(userId, c.get("organizationId"), database);
    if (!target) throw notFound("User");

    return ok(c, await listOwnPermissions(userId, database));
  });

  // The backend mints the first password and returns it once. Nothing stores
  // the plaintext, and the account must change it at first sign-in.
  routes.post("/api/v1/users", requireCan("manage", "User"), async (c) => {
    const input = await parseBody(c, createUserSchema);
    const password = mintPassword();

    const user = await createUser(
      {
        email: input.email,
        name: input.name,
        preset: input.preset,
        password,
        organizationId: c.get("organizationId"),
        mustChangePassword: true,
      },
      callerOf(c),
      database,
    );

    return ok(c, { userId: user.id, name: user.name, email: user.email, password }, 201);
  });

  routes.patch("/api/v1/users/:id", requireCan("manage", "User"), async (c) => {
    const input = compactUpdate(await parseBody(c, updateUserSchema));
    const user = await updateUser(c.req.param("id"), callerOf(c), input, database);
    if (!user) throw notFound("User");

    return ok(c, {
      userId: user.id,
      name: user.name,
      email: user.email,
      disabled: user.disabled,
    });
  });

  // Replace the whole set: the sheet sends every tick, not a delta.
  routes.put("/api/v1/users/:id/permissions", requireCan("manage", "Permission"), async (c) => {
    const userId = c.req.param("id");
    const organizationId = c.get("organizationId");

    const target = await getOrgUser(userId, organizationId, database);
    if (!target) throw notFound("User");

    const { permissions } = await parseBody(c, replacePermissionsSchema);
    await replaceUserPermissions(
      userId,
      callerOf(c),
      permissions.map((tick) => ({
        action: tick.action,
        subject: tick.subject,
        conditions: tick.conditions ?? null,
      })),
      database,
    );

    return ok(c, await listOwnPermissions(userId, database));
  });

  // Returns the new password once and kills every live session for the user.
  routes.post("/api/v1/users/:id/reset-password", requireCan("manage", "User"), async (c) => {
    const result = await resetUserPassword(c.req.param("id"), callerOf(c), database);
    if (!result) throw notFound("User");

    return ok(c, result);
  });

  return routes;
};
