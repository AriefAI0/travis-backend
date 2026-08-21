import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  createAsset,
  createComponent,
  createItem,
  deleteAsset,
  deleteComponent,
  deleteItem,
  listProjectStructureTree,
  updateAsset,
  updateComponent,
  updateItem,
} from "../../db/services/structure.service";
import { notFound } from "../../lib/error";
import { compactUpdate, parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  createAssetSchema,
  createComponentSchema,
  createItemSchema,
  updateAssetSchema,
  updateComponentSchema,
  updateItemSchema,
} from "../../types/api";

// structure tree + asset/component/item CRUD (parse > service > ok)
export const structureRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  // tree read (empty array for unknown project, matching the app IPC)
  routes.get("/api/v1/projects/:projectId/structure", async (c) => {
    const projectId = parseId(c, "projectId");
    return ok(c, await listProjectStructureTree(projectId, database));
  });

  routes.post("/api/v1/assets", async (c) => {
    const input = await parseBody(c, createAssetSchema);
    return ok(c, await createAsset(input, database), 201);
  });

  routes.patch("/api/v1/assets/:id", async (c) => {
    const input = await parseBody(c, updateAssetSchema);
    const asset = await updateAsset(parseId(c, "id"), input, database);
    if (!asset) throw notFound("Asset");
    return ok(c, asset);
  });

  routes.delete("/api/v1/assets/:id", async (c) => {
    const asset = await deleteAsset(parseId(c, "id"), database);
    if (!asset) throw notFound("Asset");
    return ok(c, asset);
  });

  routes.post("/api/v1/components", async (c) => {
    const input = await parseBody(c, createComponentSchema);
    return ok(c, await createComponent(input, database), 201);
  });

  routes.patch("/api/v1/components/:id", async (c) => {
    const input = await parseBody(c, updateComponentSchema);
    const component = await updateComponent(parseId(c, "id"), input, database);
    if (!component) throw notFound("Component");
    return ok(c, component);
  });

  routes.delete("/api/v1/components/:id", async (c) => {
    const component = await deleteComponent(parseId(c, "id"), database);
    if (!component) throw notFound("Component");
    return ok(c, component);
  });

  routes.post("/api/v1/items", async (c) => {
    const input = await parseBody(c, createItemSchema);
    return ok(c, await createItem(input, database), 201);
  });

  routes.patch("/api/v1/items/:id", async (c) => {
    const input = await parseBody(c, updateItemSchema);
    const item = await updateItem(parseId(c, "id"), compactUpdate(input), database);
    if (!item) throw notFound("Item");
    return ok(c, item);
  });

  routes.delete("/api/v1/items/:id", async (c) => {
    const item = await deleteItem(parseId(c, "id"), database);
    if (!item) throw notFound("Item");
    return ok(c, item);
  });

  return routes;
};
