import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import { bearer, createTestUser, grant } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import type { DbOrTx } from "../../../src/db/client";
import {
  requireCan,
  requireUser,
  type AuthVariables,
} from "../../../src/lib/auth/middleware";
import { structureAt } from "../../../src/lib/auth/ability";

// Two guarded routes: one plain check and one carrying a Structure condition.
const guardedRoutes = (database?: DbOrTx) => {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireUser(database));
  app.get("/projects", requireCan("read", "Project"), (c) => c.json({ ok: true, data: {} }));
  app.post(
    "/structure/part-code",
    requireCan("modify", structureAt("partCode")),
    (c) => c.json({ ok: true, data: {} }),
  );
  return app;
};

const app = appFor(testDb, guardedRoutes);

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

const get = (path: string, token?: string) =>
  app.request(path, token ? { headers: bearer(token) } : undefined);
const post = (path: string, token?: string) =>
  app.request(path, { method: "POST", headers: token ? bearer(token) : {} });

describe("requireCan", () => {
  it("lets a granted action through", async () => {
    const user = await createTestUser();
    await grant(user.userId, "read", "Project", testDb);

    const res = await get("/projects", user.token);

    expect(res.status).toBe(200);
  });

  it("refuses an action the user was never granted", async () => {
    const user = await createTestUser();
    await grant(user.userId, "read", "Result", testDb);

    const res = await get("/projects", user.token);

    expect(res.status).toBe(403);
    const body = await json<{ code: string; title: string }>(res);
    expect(body.code).toBe("forbidden");
    expect(body.title).toContain("read Project");
  });

  it("refuses a user holding no grants at all", async () => {
    const user = await createTestUser();

    expect((await get("/projects", user.token)).status).toBe(403);
  });

  it("honours a Structure level: the granted level passes", async () => {
    const user = await createTestUser();
    await grant(user.userId, "modify", "Structure", testDb);
    // the grant above is unconditional, so every level passes
    const res = await post("/structure/part-code", user.token);

    expect(res.status).toBe(200);
  });

  it("refuses a Structure level the condition excludes", async () => {
    const user = await createTestUser();
    await grant(user.userId, "modify", "Structure", testDb, { level: "taskGroup" });

    const res = await post("/structure/part-code", user.token);

    expect(res.status).toBe(403);
    expect((await json<{ title: string }>(res)).title).toContain("Structure");
  });

  it("refuses a request with no token before it checks anything", async () => {
    const res = await get("/projects");

    expect(res.status).toBe(401);
    expect((await json<{ code: string }>(res)).code).toBe("unauthorized");
  });
});
