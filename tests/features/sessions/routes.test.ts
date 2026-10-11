import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import { bearer, createTestUser, type TestUser } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import * as schema from "../../../src/db/schema";
import { auditLog } from "../../../src/lib/auth/schema";
import { sessionRoutes } from "../../../src/features/sessions/routes";

const app = appFor(testDb, sessionRoutes);

// Seeded directly: projectRoutes is guarded now, and this suite is about
// sessions. A project row is all it needs.
const seedProject = async () => {
  const rows = await testDb
    .insert(schema.project)
    .values({ organizationId: testOrgId, displayNumber: 1, title: "Alpha" })
    .returning();
  return rows[0]!.projectId;
};

// flow: project > sessions scoped to it
describe("sessions routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  // The Operator preset holds create and modify on Session, which is what these
  // routes check. No owner rule is applied.
  let operator: TestUser;
  beforeEach(async () => {
    await truncateTestDatabase();
    operator = await createTestUser({ preset: "Operator" });
  });

  const call = (
    path: string,
    init: { method?: string; body?: unknown } = {},
    token: string = operator.token,
  ) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        ...bearer(token),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  it("create > list-by-project > get > patch round-trip", async () => {
    const projectId = await seedProject();

    const post = await call("/api/v1/sessions", {
      method: "POST",
      body: { projectId, name: "Run 1" },
    });
    expect(post.status).toBe(201);
    const { data } = await json(post);
    expect(data.name).toBe("Run 1");
    const sessionId = data.sessionId as number;

    const list = await call(`/api/v1/projects/${projectId}/sessions`);
    expect(list.status).toBe(200);
    expect((await json(list)).data).toHaveLength(1);

    const get = await call(`/api/v1/sessions/${sessionId}`);
    expect(get.status).toBe(200);

    // service normalize honors name only
    const patch = await call(`/api/v1/sessions/${sessionId}`, {
      method: "PATCH",
      body: { name: "Run 1 (edited)" },
    });
    expect(patch.status).toBe(200);
    expect((await json(patch)).data.name).toBe("Run 1 (edited)");
  });

  it("writes one audit row per write", async () => {
    const projectId = await seedProject();
    const created = await json<{ data: { sessionId: number } }>(
      await call("/api/v1/sessions", { method: "POST", body: { projectId, name: "Audited" } }),
    );

    await call(`/api/v1/sessions/${created.data.sessionId}`, {
      method: "PATCH",
      body: { name: "Renamed" },
    });

    const rows = await testDb.select().from(auditLog).orderBy(auditLog.auditLogId);
    expect(rows.map((row) => row.action)).toEqual(["create", "modify"]);
    expect(rows.every((row) => row.resourceType === "Session")).toBe(true);
    expect(rows.every((row) => row.userId === operator.userId)).toBe(true);
    expect(rows[1]!.before).toMatchObject({ name: "Audited" });
    expect(rows[1]!.after).toMatchObject({ name: "Renamed" });
  });

  it("lets any holder of modify Session edit any session, with no owner rule", async () => {
    const projectId = await seedProject();
    const created = await json<{ data: { sessionId: number } }>(
      await call("/api/v1/sessions", { method: "POST", body: { projectId, name: "Mine" } }),
    );

    // a second operator, who never created this session
    const other = await createTestUser({ preset: "Operator" });

    const patch = await call(
      `/api/v1/sessions/${created.data.sessionId}`,
      { method: "PATCH", body: { name: "Theirs now" } },
      other.token,
    );

    expect(patch.status).toBe(200);
    expect((await json(patch)).data.name).toBe("Theirs now");
  });

  it("GET missing session is 404 not_found", async () => {
    const res = await call("/api/v1/sessions/99999");
    expect(res.status).toBe(404);
    expect(await json<unknown>(res)).toEqual({
      status: 404,
      code: "not_found",
      title: "Session not found",
    });
  });

  it("session with missing project FK is 404 not_found", async () => {
    const res = await call("/api/v1/sessions", {
      method: "POST",
      body: { projectId: 99999, name: "Ghost" },
    });
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe("not_found");
  });

  it("refuses a request with no token", async () => {
    const projectId = await seedProject();

    expect((await app.request("/api/v1/sessions")).status).toBe(401);
    expect((await app.request(`/api/v1/projects/${projectId}/sessions`)).status).toBe(401);
    expect(
      (
        await app.request("/api/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, name: "Anonymous" }),
        })
      ).status,
    ).toBe(401);
  });

  it("lets a Viewer read sessions but not write one", async () => {
    const projectId = await seedProject();
    const viewer = await createTestUser({ preset: "Viewer" });

    // the Viewer preset grants read on Session, so the list is allowed
    expect((await call(`/api/v1/projects/${projectId}/sessions`, {}, viewer.token)).status).toBe(200);

    const post = await call(
      "/api/v1/sessions",
      { method: "POST", body: { projectId, name: "Nope" } },
      viewer.token,
    );
    expect(post.status).toBe(403);
    expect((await json<{ code: string }>(post)).code).toBe("forbidden");
  });

  it("refuses a caller holding no Session right at all", async () => {
    const projectId = await seedProject();
    // no preset, so nothing is granted
    const nobody = await createTestUser();

    expect((await call(`/api/v1/projects/${projectId}/sessions`, {}, nobody.token)).status).toBe(403);
    expect((await call("/api/v1/sessions/1", {}, nobody.token)).status).toBe(403);
  });

  it("answers 404, not 403, on another org's session", async () => {
    const other = await testDb
      .insert(schema.organization)
      .values({ name: `other-${crypto.randomUUID()}` })
      .returning()
      .then((rows) => rows[0]!);
    const foreignProject = await testDb
      .insert(schema.project)
      .values({ organizationId: other.organizationId, displayNumber: 1, title: "Theirs" })
      .returning()
      .then((rows) => rows[0]!);
    const foreignSession = await testDb
      .insert(schema.session)
      .values({ projectId: foreignProject.projectId, displayNumber: 1, name: "Their run" })
      .returning()
      .then((rows) => rows[0]!);

    expect((await call(`/api/v1/sessions/${foreignSession.sessionId}`)).status).toBe(404);

    const patch = await call(`/api/v1/sessions/${foreignSession.sessionId}`, {
      method: "PATCH",
      body: { name: "Hijacked" },
    });
    expect(patch.status).toBe(404);

    // their list is empty, and their row is untouched
    expect(
      await json<{ data: unknown[] }>(await call(`/api/v1/projects/${foreignProject.projectId}/sessions`)),
    ).toMatchObject({ data: [] });
    expect(
      (await testDb.select().from(schema.session))[0]!.name,
    ).toBe("Their run");
  });

  it("leaves no audit row when a write is refused", async () => {
    const viewer = await createTestUser({ preset: "Viewer" });
    const projectId = await seedProject();

    await call("/api/v1/sessions", { method: "POST", body: { projectId, name: "Nope" } }, viewer.token);

    expect(await testDb.select().from(auditLog)).toHaveLength(0);
  });
});
