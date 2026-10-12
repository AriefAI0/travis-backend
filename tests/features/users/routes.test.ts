import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import { bearer, createTestUser, grant, TEST_PASSWORD } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { createAuth } from "../../../src/lib/auth/auth";
import { authRoutes } from "../../../src/features/auth/routes";
import { permissionRoutes } from "../../../src/features/permissions/routes";
import { userRoutes } from "../../../src/features/users/routes";
import { organization } from "../../../src/db/schema";

const app = appFor(testDb, userRoutes, authRoutes, permissionRoutes);

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

const auth = (token: string) => bearer(token);

const call = (
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
) =>
  app.request(path, {
    method: init.method ?? "GET",
    headers: {
      ...auth(token),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

// a caller holding the Admin preset, which is the only one that can manage users
const admin = () => createTestUser({ preset: "Admin" });

describe("GET /api/v1/users", () => {
  it("lists the org's users with a preset label", async () => {
    const boss = await admin();
    await createTestUser({ preset: "Viewer" });

    const res = await call("/api/v1/users", boss.token);

    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ preset: string; email: string }> }>(res);
    expect(body.data).toHaveLength(2);
    expect(body.data.map((row) => row.preset).sort()).toEqual(["Admin", "Viewer"]);
  });

  it("reads a set that no longer matches a preset as Custom", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });
    await grant(worker.userId, "modify", "Project", testDb);

    const res = await call("/api/v1/users", boss.token);

    const body = await json<{ data: Array<{ userId: string; preset: string }> }>(res);
    const found = body.data.find((row) => row.userId === worker.userId);
    expect(found?.preset).toBe("Custom");
  });

  it("refuses a caller without read User", async () => {
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call("/api/v1/users", worker.token);

    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe("forbidden");
  });

  it("refuses a caller with no token", async () => {
    expect((await app.request("/api/v1/users")).status).toBe(401);
  });
});

describe("lastSignInAt", () => {
  // The list carries one stamp per account: the newest session row. An account
  // an admin just created has never signed in, and must read as null rather
  // than as the creation time.
  it("is null for an account that never signed in", async () => {
    const boss = await admin();

    await call("/api/v1/users", boss.token, {
      method: "POST",
      body: { email: "fresh@example.local", name: "Fresh", preset: "Viewer" },
    });

    const body = await json<{ data: Array<{ email: string; lastSignInAt: string | null }> }>(
      await call("/api/v1/users", boss.token),
    );
    const fresh = body.data.find((row) => row.email === "fresh@example.local");
    expect(fresh?.lastSignInAt).toBeNull();
  });

  it("reads the newest session once the account signs in", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });

    const body = await json<{ data: Array<{ userId: string; lastSignInAt: string | null }> }>(
      await call("/api/v1/users", boss.token),
    );
    const row = body.data.find((entry) => entry.userId === worker.userId);

    expect(row?.lastSignInAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(row!.lastSignInAt!))).toBe(false);
  });
});

describe("GET /api/v1/users/:id/permissions", () => {
  it("returns the rows behind the tick sheet", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${worker.userId}/permissions`, boss.token);

    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ action: string; subject: string }> }>(res);
    const holds = body.data.some((row) => row.action === "read" && row.subject === "Recording");
    expect(holds).toBe(true);
  });

  it("answers 404 on another org's user", async () => {
    const boss = await admin();
    const other = await testDb
      .insert(organization)
      .values({ name: `other-${crypto.randomUUID()}` })
      .returning()
      .then((rows) => rows[0]!.organizationId);
    const stranger = await createTestUser({ organizationId: other, preset: "Viewer" });

    const res = await call(`/api/v1/users/${stranger.userId}/permissions`, boss.token);

    expect(res.status).toBe(404);
  });

  it("refuses a caller without manage Permission", async () => {
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${worker.userId}/permissions`, worker.token);

    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/permissions/catalog", () => {
  it("serves the vocabulary the grid renders", async () => {
    const boss = await admin();

    const res = await call("/api/v1/permissions/catalog", boss.token);

    expect(res.status).toBe(200);
    const body = await json<{
      data: {
        actions: string[];
        subjects: string[];
        structureLevels: string[];
        grantable: Record<string, string[]>;
        presets: Record<string, Array<{ action: string; subject: string }>>;
      };
    }>(res);

    expect(body.data.actions).toContain("manage");
    expect(body.data.subjects).toContain("Permission");
    expect(body.data.structureLevels[0]).toBe("project");
    expect(body.data.grantable.read).toContain("Project");
    expect(body.data.presets.Viewer).toContainEqual({ action: "read", subject: "Recording" });
  });

  it("offers only pairs the backend accepts", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });

    const body = await json<{ data: { grantable: Record<string, string[]> } }>(
      await call("/api/v1/permissions/catalog", boss.token),
    );
    // every pair the catalog offers saves without a 400
    const permissions = Object.entries(body.data.grantable).flatMap(([action, subjects]) =>
      subjects.map((subject) => ({ action, subject })),
    );

    const res = await call(`/api/v1/users/${worker.userId}/permissions`, boss.token, {
      method: "PUT",
      body: { permissions },
    });

    expect(res.status).toBe(200);
  });

  it("refuses a caller without manage Permission", async () => {
    const worker = await createTestUser({ preset: "Viewer" });

    expect((await call("/api/v1/permissions/catalog", worker.token)).status).toBe(403);
  });

  it("refuses a caller with no token", async () => {
    expect((await app.request("/api/v1/permissions/catalog")).status).toBe(401);
  });
});

describe("GET /api/v1/users/me/permissions", () => {
  it("returns the caller's own rows", async () => {
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call("/api/v1/users/me/permissions", worker.token);

    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ action: string; subject: string }> }>(res);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((row) => row.action === "read" || row.action === "watch")).toBe(true);
  });

  it("is not shadowed by the /users/:id/permissions route", async () => {
    const worker = await createTestUser({ preset: "Viewer" });

    // a 404 here would mean "me" was parsed as a user id
    expect((await call("/api/v1/users/me/permissions", worker.token)).status).toBe(200);
  });
});

describe("POST /api/v1/users", () => {
  it("creates a user, returns the password once, and lets them sign in", async () => {
    const boss = await admin();

    const res = await call("/api/v1/users", boss.token, {
      method: "POST",
      body: { email: "newcomer@example.local", name: "Newcomer", preset: "Operator" },
    });

    expect(res.status).toBe(201);
    const created = await json<{ data: { userId: string; password: string } }>(res);
    expect(created.data.password.length).toBeGreaterThanOrEqual(12);

    // the minted password works, and the account is told to change it
    const signIn = await app.request("/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "newcomer@example.local",
        password: created.data.password,
      }),
    });
    expect(signIn.status).toBe(200);

    const listed = await json<{ data: Array<{ preset: string; mustChangePassword: boolean }> }>(
      await call("/api/v1/users", boss.token),
    );
    const row = listed.data.find((r) => r.preset === "Operator");
    expect(row?.mustChangePassword).toBe(true);
  });

  it("refuses a duplicate email", async () => {
    const boss = await admin();
    const body = { email: "twice@example.local", name: "Twice", preset: "Viewer" };

    await call("/api/v1/users", boss.token, { method: "POST", body });
    const again = await call("/api/v1/users", boss.token, { method: "POST", body });

    expect(again.status).toBe(409);
  });

  it("refuses a bad body before it reaches the service", async () => {
    const boss = await admin();

    const res = await call("/api/v1/users", boss.token, {
      method: "POST",
      body: { email: "not-an-email", name: "X", preset: "Wizard" },
    });

    expect(res.status).toBe(400);
    expect((await json<{ code: string }>(res)).code).toBe("validation_error");
  });

  it("refuses a caller without manage User", async () => {
    const worker = await createTestUser({ preset: "Operator" });

    const res = await call("/api/v1/users", worker.token, {
      method: "POST",
      body: { email: "x@example.local", name: "X", preset: "Viewer" },
    });

    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/v1/users/:id", () => {
  it("renames a user", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${worker.userId}`, boss.token, {
      method: "PATCH",
      body: { name: "Renamed" },
    });

    expect(res.status).toBe(200);
    expect((await json<{ data: { name: string } }>(res)).data.name).toBe("Renamed");
  });

  it("disables a user and cuts their token off", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${worker.userId}`, boss.token, {
      method: "PATCH",
      body: { disabled: true },
    });
    expect(res.status).toBe(200);

    const after = await call("/api/v1/users/me/permissions", worker.token);
    expect(after.status).toBe(403);
  });

  it("refuses an empty body", async () => {
    const boss = await admin();

    const res = await call(`/api/v1/users/${boss.userId}`, boss.token, {
      method: "PATCH",
      body: {},
    });

    expect(res.status).toBe(400);
  });
});

describe("PUT /api/v1/users/:id/permissions", () => {
  it("replaces the whole set", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${worker.userId}/permissions`, boss.token, {
      method: "PUT",
      body: { permissions: [{ action: "read", subject: "Report" }] },
    });

    expect(res.status).toBe(200);
    const rows = await json<{ data: Array<{ action: string; subject: string }> }>(res);
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0]).toMatchObject({ action: "read", subject: "Report" });
  });

  it("refuses a subject that does not exist", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${worker.userId}/permissions`, boss.token, {
      method: "PUT",
      body: { permissions: [{ action: "read", subject: "Reporting" }] },
    });

    expect(res.status).toBe(400);
  });

  it("refuses a pair the grid cannot grant", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${worker.userId}/permissions`, boss.token, {
      method: "PUT",
      body: { permissions: [{ action: "publish", subject: "Project" }] },
    });

    expect(res.status).toBe(400);
  });

  it("refuses the same tick twice", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${worker.userId}/permissions`, boss.token, {
      method: "PUT",
      body: {
        permissions: [
          { action: "read", subject: "Project" },
          { action: "read", subject: "Project" },
        ],
      },
    });

    expect(res.status).toBe(400);
  });

  it("refuses a caller without manage Permission", async () => {
    const worker = await createTestUser({ preset: "Operator" });
    const other = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${other.userId}/permissions`, worker.token, {
      method: "PUT",
      body: { permissions: [] },
    });

    expect(res.status).toBe(403);
  });
});

describe("the last-manager lockout guard", () => {
  it("refuses to strip manage User from the last holder", async () => {
    const boss = await admin();

    const res = await call(`/api/v1/users/${boss.userId}/permissions`, boss.token, {
      method: "PUT",
      body: { permissions: [{ action: "read", subject: "Project" }] },
    });

    // a refusal, not a crash
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("wrong_state");

    // and the rows are untouched
    const rows = await call("/api/v1/users/me/permissions", boss.token);
    const body = await json<{ data: Array<{ action: string }> }>(rows);
    expect(body.data.some((row) => row.action === "manage")).toBe(true);
  });

  it("refuses to disable the last holder", async () => {
    const boss = await admin();

    const res = await call(`/api/v1/users/${boss.userId}`, boss.token, {
      method: "PATCH",
      body: { disabled: true },
    });

    expect(res.status).toBe(409);
  });

  it("allows it once a second manager exists", async () => {
    const boss = await admin();
    const second = await admin();

    const res = await call(`/api/v1/users/${boss.userId}/permissions`, boss.token, {
      method: "PUT",
      body: { permissions: [{ action: "read", subject: "Project" }] },
    });

    expect(res.status).toBe(200);
    expect(second.userId).not.toBe(boss.userId);
  });

  it("ignores the guard for a user who never held manage User", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${worker.userId}/permissions`, boss.token, {
      method: "PUT",
      body: { permissions: [] },
    });

    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/users/:id/reset-password", () => {
  it("returns a new password and kills every live session", async () => {
    const boss = await admin();
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${worker.userId}/reset-password`, boss.token, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await json<{ data: { password: string; revokedSessions: number } }>(res);
    expect(body.data.revokedSessions).toBeGreaterThan(0);

    // the old token is dead
    const after = await call("/api/v1/users/me/permissions", worker.token);
    expect(after.status).toBe(401);

    // the new password signs in, the old one does not
    const signIn = (password: string) =>
      app.request("/api/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: worker.email, password }),
      });

    expect((await signIn(body.data.password)).status).toBe(200);
    expect((await signIn(TEST_PASSWORD)).status).toBe(401);
  });

  it("refuses a caller without manage User", async () => {
    const worker = await createTestUser({ preset: "Operator" });
    const other = await createTestUser({ preset: "Viewer" });

    const res = await call(`/api/v1/users/${other.userId}/reset-password`, worker.token, {
      method: "POST",
    });

    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/v1/users/me", () => {
  const patch = (token: string, body: unknown) =>
    call("/api/v1/users/me", token, { method: "PATCH", body });

  it("renames the caller with the right current password", async () => {
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await patch(worker.token, {
      name: "Renamed Myself",
      currentPassword: TEST_PASSWORD,
    });

    expect(res.status).toBe(200);
    const body = await json<{ data: { name: string } }>(res);
    expect(body.data.name).toBe("Renamed Myself");
  });

  // No admin right is involved: a Viewer edits their own row.
  it("needs no right beyond being signed in", async () => {
    const viewer = await createTestUser({ preset: "Viewer" });

    const res = await patch(viewer.token, {
      name: "Still A Viewer",
      currentPassword: TEST_PASSWORD,
    });

    expect(res.status).toBe(200);
  });

  it("refuses a wrong current password and writes nothing", async () => {
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await patch(worker.token, {
      name: "Hijacked",
      currentPassword: "not-the-password",
    });

    expect(res.status).toBe(400);
    expect((await json<{ code: string }>(res)).code).toBe("wrong_password");

    const listed = await json<{ data: Array<{ userId: string; name: string }> }>(
      await call("/api/v1/users", (await admin()).token),
    );
    expect(listed.data.find((row) => row.userId === worker.userId)?.name).toBe(worker.name);
  });

  it("changes the password and clears the first-sign-in flag", async () => {
    const worker = await createTestUser({ preset: "Viewer" });
    const next = "a-new-password-42";

    const res = await patch(worker.token, {
      currentPassword: TEST_PASSWORD,
      newPassword: next,
    });
    expect(res.status).toBe(200);
    expect((await json<{ data: { mustChangePassword: boolean } }>(res)).data.mustChangePassword).toBe(
      false,
    );

    const signIn = (password: string) =>
      app.request("/api/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: worker.email, password }),
      });

    expect((await signIn(next)).status).toBe(200);
    expect((await signIn(TEST_PASSWORD)).status).toBe(401);
  });

  it("keeps the caller signed in while dropping other machines", async () => {
    const worker = await createTestUser({ preset: "Viewer" });

    // a second sign-in, the way another machine would leave one behind
    const context = await createAuth(testDb).$context;
    const elsewhere = await context.internalAdapter.createSession(worker.userId);
    expect(elsewhere.token).not.toBe(worker.token);

    const res = await patch(worker.token, {
      currentPassword: TEST_PASSWORD,
      newPassword: "another-password-43",
    });
    expect(res.status).toBe(200);

    expect((await call("/api/v1/users/me/permissions", worker.token)).status).toBe(200);
    expect(
      (await call("/api/v1/users/me/permissions", elsewhere.token)).status,
    ).toBe(401);
  });

  it("refuses a new password under the policy", async () => {
    const worker = await createTestUser({ preset: "Viewer" });

    const short = await patch(worker.token, {
      currentPassword: TEST_PASSWORD,
      newPassword: "abc1",
    });
    expect(short.status).toBe(400);

    // 12 characters, but no letter
    const digits = await patch(worker.token, {
      currentPassword: TEST_PASSWORD,
      newPassword: "123456789012",
    });
    expect(digits.status).toBe(400);
  });

  it("refuses an empty body and a caller with no token", async () => {
    const worker = await createTestUser({ preset: "Viewer" });

    expect((await patch(worker.token, {})).status).toBe(400);
    expect(
      (await app.request("/api/v1/users/me", { method: "PATCH" })).status,
    ).toBe(401);
  });

  // The route is registered before `/users/:id`, so "me" is never an id.
  it("is not shadowed by the /users/:id route", async () => {
    const worker = await createTestUser({ preset: "Viewer" });

    const res = await patch(worker.token, {
      name: worker.name,
      currentPassword: TEST_PASSWORD,
    });

    expect(res.status).toBe(200);
  });
});

describe("the guard stays inside its own prefix", () => {
  // A wildcard guard in a sub-app mounted at "/" is merged at the mount
  // prefix, so `use("*")` here would put requireUser in front of every route
  // of every feature mounted after this one.
  it("leaves another feature's route reachable without a token", async () => {
    const user = await createTestUser();

    const res = await app.request("/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, password: TEST_PASSWORD }),
    });

    expect(res.status).toBe(200);
  });

  it("still guards its own prefix", async () => {
    expect((await app.request("/api/v1/users")).status).toBe(401);
  });
});

describe("org scoping", () => {
  // A second org. Organization rows outlive the truncate, so the name carries
  // a suffix rather than tripping the unique index on a second call.
  const otherOrgId = async () => {
    const rows = await testDb
      .insert(organization)
      .values({ name: `other-${crypto.randomUUID()}` })
      .returning();
    return rows[0]!.organizationId;
  };

  it("hides another org's user from the list", async () => {
    const boss = await admin();
    await createTestUser({ organizationId: await otherOrgId(), preset: "Admin" });

    const body = await json<{ data: unknown[] }>(await call("/api/v1/users", boss.token));

    expect(body.data).toHaveLength(1);
  });

  it("answers 404, not 403, on another org's user", async () => {
    const boss = await admin();
    const stranger = await createTestUser({
      organizationId: await otherOrgId(),
      preset: "Admin",
    });

    const patch = await call(`/api/v1/users/${stranger.userId}`, boss.token, {
      method: "PATCH",
      body: { name: "Hijacked" },
    });
    expect(patch.status).toBe(404);

    const reset = await call(`/api/v1/users/${stranger.userId}/reset-password`, boss.token, {
      method: "POST",
    });
    expect(reset.status).toBe(404);
  });

  it("answers 404 on an id that does not exist at all", async () => {
    const boss = await admin();

    const res = await call("/api/v1/users/no-such-user/reset-password", boss.token, {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });
});
