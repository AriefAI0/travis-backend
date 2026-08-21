import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { structureRoutes } from "../../../src/features/structure/routes";
import { projectRoutes } from "../../../src/features/projects/routes";

const app = appFor(testDb, structureRoutes, projectRoutes);

// flow: project > asset > component > item > tree
describe("structure routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  const seedProject = async () => {
    const res = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Alpha" }),
    });
    return (await json(res)).data.projectId as number;
  };

  it("builds the tree and returns it nested", async () => {
    const projectId = await seedProject();

    const asset = await app.request("/api/v1/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, name: "Platform A" }),
    });
    expect(asset.status).toBe(201);
    const assetId = (await json(asset)).data.assetId as number;

    const component = await app.request("/api/v1/components", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId, name: "Jacket Leg" }),
    });
    expect(component.status).toBe(201);
    const componentId = (await json(component)).data.componentId as number;

    const item = await app.request("/api/v1/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ componentId, itemLabel: "JL-01", position: "North" }),
    });
    expect(item.status).toBe(201);
    const itemId = (await json(item)).data.itemId as number;

    const tree = await app.request(`/api/v1/projects/${projectId}/structure`);
    expect(tree.status).toBe(200);
    const { data } = await json(tree);
    expect(data).toHaveLength(1);
    expect(data[0].components).toHaveLength(1);
    expect(data[0].components[0].items).toHaveLength(1);
    expect(data[0].components[0].items[0].itemId).toBe(itemId);

    // patch + delete close the loop
    const patch = await app.request(`/api/v1/items/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "complete" }),
    });
    expect(patch.status).toBe(200);
    expect((await json(patch)).data.status).toBe("complete");

    const del = await app.request(`/api/v1/items/${itemId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    // second delete of the same id is the 404 path
    const after = await app.request(`/api/v1/items/${itemId}`, { method: "DELETE" });
    expect(after.status).toBe(404);
    expect((await json(after)).code).toBe("not_found");
  });

  it("tree for unknown project is 200 + [] (app parity)", async () => {
    const res = await app.request("/api/v1/projects/999/structure");
    expect(res.status).toBe(200);
    expect(await json<unknown>(res)).toEqual({ ok: true, data: [] });
  });

  it("component with missing asset FK is 404 not_found", async () => {
    const res = await app.request("/api/v1/components", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId: 99999, name: "Ghost" }),
    });
    expect(res.status).toBe(404);
    expect(await json<unknown>(res)).toEqual({
      status: 404,
      code: "not_found",
      title: "Parent asset not found",
    });
  });

  it("item patch with status null means no change (app parity)", async () => {
    const projectId = await seedProject();
    const asset = await app.request("/api/v1/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, name: "Platform A" }),
    });
    const assetId = (await json(asset)).data.assetId as number;
    const component = await app.request("/api/v1/components", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId, name: "Jacket Leg" }),
    });
    const componentId = (await json(component)).data.componentId as number;
    const item = await app.request("/api/v1/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ componentId, itemLabel: "JL-01", status: "pending" }),
    });
    const itemId = (await json(item)).data.itemId as number;

    // status null means "no change"; a null-only patch has nothing to set
    const patch = await app.request(`/api/v1/items/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: null }),
    });
    expect(patch.status).toBe(400);
    expect((await json(patch)).code).toBe("validation_error");

    const after = await app.request(`/api/v1/items/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemLabel: "JL-01", status: null }),
    });
    expect(after.status).toBe(200);
    expect((await json(after)).data.status).toBe("pending");
  });
});
