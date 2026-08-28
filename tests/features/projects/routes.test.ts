import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { projectRoutes } from "../../../src/features/projects/routes";

const app = appFor(testDb, projectRoutes);

// happy paths use one app.request per verb; errors assert the steve contract
describe("projects routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

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

  it("report-signature for unknown project is 200, not 404", async () => {
    const res = await app.request("/api/v1/projects/999/report-signature");
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data.resultIds).toEqual([]);
    expect(data.updatedAtByResultId).toEqual({});
  });
});
