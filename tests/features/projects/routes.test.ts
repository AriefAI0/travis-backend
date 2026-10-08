import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import * as schema from "../../../src/db/schema";
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
  beforeEach(async () => {
    await truncateTestDatabase();
    swept.prefixes = [];
    swept.keys = [];
  });

  it("GET /api/v1/projects on empty db is 200 + []", async () => {
    const res = await app.request("/api/v1/projects");
    expect(res.status).toBe(200);
    expect(await json<unknown>(res)).toEqual({ ok: true, data: [] });
  });

  it("POST > GET > PATCH > DELETE round-trip", async () => {
    const post = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Alpha", description: "campaign" }),
    });
    expect(post.status).toBe(201);
    const { data } = await json(post);
    expect(data.title).toBe("Alpha");
    expect(typeof data.projectId).toBe("number");

    const get = await app.request(`/api/v1/projects/${data.projectId}`);
    expect(get.status).toBe(200);

    const patch = await app.request(`/api/v1/projects/${data.projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Beta" }),
    });
    expect(patch.status).toBe(200);
    expect((await json(patch)).data.title).toBe("Beta");

    const del = await app.request(`/api/v1/projects/${data.projectId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    // deleted id now 404s with the problem+json body
    const missing = await app.request(`/api/v1/projects/${data.projectId}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/problem+json");
    expect(await json<unknown>(missing)).toEqual({
      status: 404,
      code: "not_found",
      title: "Project not found",
    });
  });

  it("POST without title is 400 validation_error", async () => {
    const res = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "no title" }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe("validation_error");
  });

  it("GET /:id with non-numeric id is 400 validation_error", async () => {
    const res = await app.request("/api/v1/projects/not-a-number");
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("validation_error");
  });

  // project > session > description > result > clip + master ingest
  const seedProjectWithClip = async (openIngest: boolean) => {
    const project = await testDb
      .insert(schema.project)
      .values({ displayNumber: 1, title: "Rig Alpha" })
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

    const res = await app.request(`/api/v1/projects/${project.projectId}`, { method: "DELETE" });

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

    const res = await app.request(`/api/v1/projects/${project.projectId}`, { method: "DELETE" });

    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("wrong_state");
    // nothing moved: no rows gone, no objects swept
    expect(await testDb.select().from(schema.project)).toHaveLength(1);
    expect(swept.prefixes).toEqual([]);
  });

});
