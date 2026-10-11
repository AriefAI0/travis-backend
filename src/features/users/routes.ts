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
  updateUser,
} from "../../db/services/user.service";
import { requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import { notFound } from "../../lib/error";
import { compactUpdate, parseBody } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  createUserSchema,
  replacePermissionsSchema,
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

  routes.get("/api/v1/users", requireCan("read", "User"), async (c) =>
    ok(c, await listUsers(c.get("organizationId"), database)),
  );

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
      database,
    );

    return ok(c, { userId: user.id, name: user.name, email: user.email, password }, 201);
  });

  routes.patch("/api/v1/users/:id", requireCan("manage", "User"), async (c) => {
    const input = compactUpdate(await parseBody(c, updateUserSchema));
    const user = await updateUser(c.req.param("id"), c.get("organizationId"), input, database);
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
      organizationId,
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
    const result = await resetUserPassword(
      c.req.param("id"),
      c.get("organizationId"),
      database,
    );
    if (!result) throw notFound("User");

    return ok(c, result);
  });

  return routes;
};
