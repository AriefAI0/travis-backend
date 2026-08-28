import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { sessionRoutes } from "../../../src/features/sessions/routes";
import { projectRoutes } from "../../../src/features/projects/routes";

const app = appFor(testDb, sessionRoutes, projectRoutes);

// flow: project > sessions scoped to it
describe("sessions routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("create > list-by-project > get > patch round-trip", async () => {
    const project = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Alpha" }),
    });
    const projectId = (await json(project)).data.projectId as number;

    const post = await app.request("/api/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, name: "Run 1" }),
    });
    expect(post.status).toBe(201);
    const { data } = await json(post);
    expect(data.name).toBe("Run 1");
    const sessionId = data.sessionId as number;

    const list = await app.request(`/api/v1/projects/${projectId}/sessions`);
    expect(list.status).toBe(200);
    expect((await json(list)).data).toHaveLength(1);

    const get = await app.request(`/api/v1/sessions/${sessionId}`);
    expect(get.status).toBe(200);

    // service normalize honors name only
    const patch = await app.request(`/api/v1/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Run 1 (edited)" }),
    });
    expect(patch.status).toBe(200);
    expect((await json(patch)).data.name).toBe("Run 1 (edited)");
  });

  it("GET missing session is 404 not_found", async () => {
    const res = await app.request("/api/v1/sessions/99999");
    expect(res.status).toBe(404);
    expect(await json<unknown>(res)).toEqual({
      status: 404,
      code: "not_found",
      title: "Session not found",
    });
  });

  it("session with missing project FK is 404 not_found", async () => {
    const res = await app.request("/api/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: 99999, name: "Ghost" }),
    });
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe("not_found");
  });
});
