import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import { bearer, createTestUser } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import type { DbOrTx } from "../../../src/db/client";
import { requireUser, type AuthVariables } from "../../../src/lib/auth/middleware";

// A stand-in for a real feature factory: one guarded read that echoes what the
// middleware resolved.
const guardedRoutes = (database?: DbOrTx) => {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireUser(database));
  app.get("/guarded", (c) =>
    c.json({ ok: true, data: { user: c.get("user"), organizationId: c.get("organizationId") } }),
  );
  return app;
};

const app = appFor(testDb, guardedRoutes);

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

describe("requireUser", () => {
  it("refuses a request with no token", async () => {
    const res = await app.request("/guarded");

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect((await json<{ code: string }>(res)).code).toBe("unauthorized");
  });

  it("refuses a token that matches no session", async () => {
    const res = await app.request("/guarded", { headers: bearer("not-a-real-token") });

    expect(res.status).toBe(401);
  });

  it("puts the user and the org on the context", async () => {
    const user = await createTestUser();

    const res = await app.request("/guarded", { headers: bearer(user.token) });

    expect(res.status).toBe(200);
    const body = await json<{ data: { user: { userId: string }; organizationId: number } }>(res);
    expect(body.data.user.userId).toBe(user.userId);
    expect(typeof body.data.organizationId).toBe("number");
  });

  it("never puts the token on the context", async () => {
    const user = await createTestUser();

    const res = await app.request("/guarded", { headers: bearer(user.token) });
    const text = await res.text();

    expect(text).not.toContain(user.token);
  });

  it("refuses a disabled account", async () => {
    const user = await createTestUser({ disabled: true });

    const res = await app.request("/guarded", { headers: bearer(user.token) });

    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe("forbidden");
  });
});
