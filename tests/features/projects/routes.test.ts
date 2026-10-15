import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import {
  bearer,
  createTestUser,
  type TestUser,
} from "../../helpers/auth";
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
import { projectRoutes } from "../../../src/features/projects/routes";

// the media sweep is stubbed: these tests pin the HTTP contract, and a real
// bucket round trip would turn a dropped connection into a slow test
const swept = { prefixes: [] as string[], keys: [] as string[] };

const app = appFor(testDb, (database) =>
  projectRoutes(database, {
    removePrefix: async (keyPrefix) => {
      swept.prefixes.push(keyPrefix);
    },
    removeKeys: async (keys) => {
      swept.keys.push(...keys);
    },
  }),
);

// happy paths use one app.request per verb; errors assert the steve contract
describe("projects routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  // every route is behind a token, and the Admin preset holds the write rights
  let admin: TestUser;
  beforeEach(async () => {
    await truncateTestDatabase();
    swept.prefixes = [];
    swept.keys = [];
    admin = await createTestUser({ preset: "Admin" });
  });

  const call = (
    path: string,
    init: { method?: string; body?: unknown } = {},
    token: string = admin.token,
  ) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        ...bearer(token),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  it("GET /api/v1/projects on empty db is 200 + []", async () => {
    const res = await call("/api/v1/projects");
    expect(res.status).toBe(200);
    expect(await json<unknown>(res)).toEqual({ ok: true, data: [] });
  });

  it("POST > GET > PATCH > DELETE round-trip", async () => {
    const post = await call("/api/v1/projects", {
      method: "POST",
      body: { title: "Alpha", description: "campaign" },
    });
    expect(post.status).toBe(201);
    const { data } = await json(post);
    expect(data.title).toBe("Alpha");
    expect(typeof data.projectId).toBe("number");

    const get = await call(`/api/v1/projects/${data.projectId}`);
    expect(get.status).toBe(200);

    const patch = await call(`/api/v1/projects/${data.projectId}`, {
      method: "PATCH",
      body: { title: "Beta" },
    });
    expect(patch.status).toBe(200);
    expect((await json(patch)).data.title).toBe("Beta");

    const del = await call(`/api/v1/projects/${data.projectId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // deleted id now 404s with the problem+json body
    const missing = await call(`/api/v1/projects/${data.projectId}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/problem+json");
    expect(await json<unknown>(missing)).toEqual({
      status: 404,
      code: "not_found",
      title: "Project not found",
    });
  });

  it("writes one audit row per write, on the caller's transaction", async () => {
    const created = await json<{ data: { projectId: number } }>(
      await call("/api/v1/projects", { method: "POST", body: { title: "Audited" } }),
    );
    const projectId = created.data.projectId;

    await call(`/api/v1/projects/${projectId}`, { method: "PATCH", body: { title: "Renamed" } });
    await call(`/api/v1/projects/${projectId}`, { method: "DELETE" });

    const rows = await testDb
      .select()
      .from(auditLog)
      .orderBy(auditLog.auditLogId);

    expect(rows.map((row) => row.action)).toEqual(["create", "modify", "remove"]);
    expect(rows.every((row) => row.organizationId === testOrgId)).toBe(true);
    expect(rows.every((row) => row.userId === admin.userId)).toBe(true);
    expect(rows.every((row) => row.resourceType === "Project")).toBe(true);

    // the modify row carries both versions
    expect(rows[1]!.before).toMatchObject({ title: "Audited" });
    expect(rows[1]!.after).toMatchObject({ title: "Renamed" });
  });

  it("POST without title is 400 validation_error", async () => {
    const res = await call("/api/v1/projects", {
      method: "POST",
      body: { description: "no title" },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("validation_error");
  });

  it("GET /:id with non-numeric id is 400 validation_error", async () => {
    const res = await call("/api/v1/projects/not-a-number");
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("validation_error");
  });

  it("refuses a caller with no token", async () => {
    const list = await app.request("/api/v1/projects");
    expect(list.status).toBe(401);

    const post = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Anonymous" }),
    });
    expect(post.status).toBe(401);
  });

  it("refuses a Viewer, who may only read", async () => {
    const viewer = await createTestUser({ preset: "Viewer" });

    // the read is granted
    expect((await call("/api/v1/projects", {}, viewer.token)).status).toBe(200);

    const post = await call("/api/v1/projects", { method: "POST", body: { title: "Nope" } }, viewer.token);
    expect(post.status).toBe(403);
    expect((await json<{ code: string }>(post)).code).toBe("forbidden");

    const del = await call("/api/v1/projects/1", { method: "DELETE" }, viewer.token);
    expect(del.status).toBe(403);
  });

  it("answers 404, not 403, on another org's project", async () => {
    const other = await testDb
      .insert(schema.organization)
      .values({ name: `other-${crypto.randomUUID()}` })
      .returning()
      .then((rows) => rows[0]!);

    const foreign = await testDb
      .insert(schema.project)
      .values({ organizationId: other.organizationId, displayNumber: 1, title: "Theirs" })
      .returning()
      .then((rows) => rows[0]!);

    const get = await call(`/api/v1/projects/${foreign.projectId}`);
    expect(get.status).toBe(404);

    const patch = await call(`/api/v1/projects/${foreign.projectId}`, {
      method: "PATCH",
      body: { title: "Hijacked" },
    });
    expect(patch.status).toBe(404);

    // and the list never shows it
    expect(await json<{ data: unknown[] }>(await call("/api/v1/projects"))).toMatchObject({
      data: [],
    });
    // the row is untouched
    expect(
      (await testDb.select().from(schema.project))[0]!.title,
    ).toBe("Theirs");
  });

  // project > session > description > result > clip + master ingest
  const seedProjectWithClip = async (openIngest: boolean) => {
    const project = await testDb
      .insert(schema.project)
      .values({ organizationId: testOrgId, displayNumber: 1, title: "Rig Alpha" })
      .returning()
      .then((rows) => rows[0]!);
    const session = await testDb
      .insert(schema.session)
      .values({ projectId: project.projectId, displayNumber: 1, startEpoch: 1000 })
      .returning()
      .then((rows) => rows[0]!);
    const group = await testDb
      .insert(schema.taskGroup)
      .values({ projectId: project.projectId, code: "100" })
      .returning()
      .then((rows) => rows[0]!);
    const taskCode = await testDb
      .insert(schema.taskCode)
      .values({ taskGroupId: group.taskGroupId, code: "101" })
      .returning()
      .then((rows) => rows[0]!);
    const description = await testDb
      .insert(schema.description)
      .values({ taskCodeId: taskCode.taskCodeId, label: "JL-01" })
      .returning()
      .then((rows) => rows[0]!);
    const result = await testDb
      .insert(schema.result)
      .values({
        displayNumber: 1,
        inspectionTypeCode: "GVI",
        projectId: project.projectId,
        sessionId: session.sessionId,
        descriptionId: description.descriptionId,
        layer: 1,
        masterStartMs: 0,
      })
      .returning()
      .then((rows) => rows[0]!);

    await testDb.insert(schema.videoClip).values({
      resultId: result.resultId,
      sessionId: session.sessionId,
      startOffsetMs: 0,
    });
    await testDb.insert(schema.recordingIngest).values({
      kind: "master",
      sessionId: session.sessionId,
      ticketHash: "ticket-hash",
      keyDate: "2026-01-01",
      keyPrefix: "1-rig-alpha-2026-01-01/session-1-2026-01-01-1000/master-video",
      closedAt: openIngest ? null : new Date(),
    });

    return project;
  };

  // the reported bug: the clip blocked the session cascade, and the FK violation
  // surfaced to the app as not_found (404) "Referenced record not found"
  it("DELETE a project that holds a clip is 200, not 404", async () => {
    const project = await seedProjectWithClip(false);

    const res = await call(`/api/v1/projects/${project.projectId}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await testDb.select().from(schema.videoClip)).toHaveLength(0);
    expect(await testDb.select().from(schema.session)).toHaveLength(0);
    // the sweep targets the frozen ingest prefix, never a rebuilt one
    expect(swept.prefixes).toEqual([
      "1-rig-alpha-2026-01-01/session-1-2026-01-01-1000/master-video",
    ]);
  });

  it("DELETE is 409 while a recording is still open", async () => {
    const project = await seedProjectWithClip(true);

    const res = await call(`/api/v1/projects/${project.projectId}`, { method: "DELETE" });

    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("wrong_state");
    // nothing moved: no rows gone, no objects swept
    expect(await testDb.select().from(schema.project)).toHaveLength(1);
    expect(swept.prefixes).toEqual([]);
    // and a refused write leaves no audit row
    expect(await testDb.select().from(auditLog)).toHaveLength(0);
  });
});
