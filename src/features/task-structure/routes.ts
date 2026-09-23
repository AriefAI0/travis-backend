import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  attachMainComponentType,
  createComponentCode,
  createComponentType,
  createMainComponent,
  createTaskCode,
  createTaskGroup,
  deleteComponentCode,
  deleteComponentType,
  deleteMainComponent,
  deleteMainComponentType,
  deleteTaskCode,
  deleteTaskGroup,
  getComponentCodeById,
  getMainComponentById,
  getMainComponentTypeById,
  getTaskCodeById,
  getTaskGroupById,
  listComponentTypes,
  listProjectTaskStructureTree,
  renameComponentType,
  updateComponentCode,
  updateMainComponent,
  updateMainComponentType,
  updateTaskCode,
  updateTaskGroup,
} from "../../db/services/task-structure.service";
import { notFound } from "../../lib/error";
import { compactUpdate, parseBody, parseId, parseQuery } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  attachMainComponentTypeSchema,
  componentTypeQuerySchema,
  createComponentCodeSchema,
  createComponentTypeSchema,
  createMainComponentSchema,
  createTaskCodeSchema,
  createTaskGroupSchema,
  updateComponentCodeSchema,
  updateComponentTypeSchema,
  updateMainComponentSchema,
  updateMainComponentTypeSchema,
  updateTaskCodeSchema,
  updateTaskGroupSchema,
} from "../../types/api";

// task tree reads + per-level CRUD + project type catalog (parse > service > ok)
export const taskStructureRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  routes.get("/api/v1/projects/:projectId/task-structure", async (c) => {
    const projectId = parseId(c, "projectId");
    return ok(c, await listProjectTaskStructureTree(projectId, database));
  });

  /* task groups */
  routes.post("/api/v1/task-groups", async (c) => {
    const input = await parseBody(c, createTaskGroupSchema);
    return ok(c, await createTaskGroup(input, database), 201);
  });

  routes.get("/api/v1/task-groups/:id", async (c) => {
    const row = await getTaskGroupById(parseId(c, "id"), database);
    if (!row) throw notFound("Task group");
    return ok(c, row);
  });

  routes.patch("/api/v1/task-groups/:id", async (c) => {
    const input = compactUpdate(await parseBody(c, updateTaskGroupSchema));
    const row = await updateTaskGroup(parseId(c, "id"), input, database);
    if (!row) throw notFound("Task group");
    return ok(c, row);
  });

  routes.delete("/api/v1/task-groups/:id", async (c) => {
    const row = await deleteTaskGroup(parseId(c, "id"), database);
    if (!row) throw notFound("Task group");
    return ok(c, row);
  });

  /* task codes */
  routes.post("/api/v1/task-codes", async (c) => {
    const input = await parseBody(c, createTaskCodeSchema);
    return ok(c, await createTaskCode(input, database), 201);
  });

  routes.get("/api/v1/task-codes/:id", async (c) => {
    const row = await getTaskCodeById(parseId(c, "id"), database);
    if (!row) throw notFound("Task code");
    return ok(c, row);
  });

  routes.patch("/api/v1/task-codes/:id", async (c) => {
    const input = compactUpdate(await parseBody(c, updateTaskCodeSchema));
    const row = await updateTaskCode(parseId(c, "id"), input, database);
    if (!row) throw notFound("Task code");
    return ok(c, row);
  });

  routes.delete("/api/v1/task-codes/:id", async (c) => {
    const row = await deleteTaskCode(parseId(c, "id"), database);
    if (!row) throw notFound("Task code");
    return ok(c, row);
  });

  /* main components */
  routes.post("/api/v1/main-components", async (c) => {
    const input = await parseBody(c, createMainComponentSchema);
    return ok(c, await createMainComponent(input, database), 201);
  });

  routes.get("/api/v1/main-components/:id", async (c) => {
    const row = await getMainComponentById(parseId(c, "id"), database);
    if (!row) throw notFound("Main component");
    return ok(c, row);
  });

  routes.patch("/api/v1/main-components/:id", async (c) => {
    const input = compactUpdate(await parseBody(c, updateMainComponentSchema));
    const row = await updateMainComponent(parseId(c, "id"), input, database);
    if (!row) throw notFound("Main component");
    return ok(c, row);
  });

  routes.delete("/api/v1/main-components/:id", async (c) => {
    const row = await deleteMainComponent(parseId(c, "id"), database);
    if (!row) throw notFound("Main component");
    return ok(c, row);
  });

  /* type branches (catalog value created on first use) */
  routes.post("/api/v1/main-component-types", async (c) => {
    const input = await parseBody(c, attachMainComponentTypeSchema);
    return ok(c, await attachMainComponentType(input, database), 201);
  });

  routes.get("/api/v1/main-component-types/:id", async (c) => {
    const row = await getMainComponentTypeById(parseId(c, "id"), database);
    if (!row) throw notFound("Main component type");
    return ok(c, row);
  });

  routes.patch("/api/v1/main-component-types/:id", async (c) => {
    const input = compactUpdate(await parseBody(c, updateMainComponentTypeSchema));
    const row = await updateMainComponentType(parseId(c, "id"), input, database);
    if (!row) throw notFound("Main component type");
    return ok(c, row);
  });

  routes.delete("/api/v1/main-component-types/:id", async (c) => {
    const row = await deleteMainComponentType(parseId(c, "id"), database);
    if (!row) throw notFound("Main component type");
    return ok(c, row);
  });

  /* project type catalog: autocomplete + rename in place */
  routes.get("/api/v1/projects/:projectId/component-types", async (c) => {
    const projectId = parseId(c, "projectId");
    const { q } = parseQuery(c, componentTypeQuerySchema);
    return ok(c, await listComponentTypes(projectId, q, database));
  });

  routes.post("/api/v1/projects/:projectId/component-types", async (c) => {
    const projectId = parseId(c, "projectId");
    const input = await parseBody(c, createComponentTypeSchema);
    return ok(c, await createComponentType(projectId, input, database), 201);
  });

  routes.patch("/api/v1/component-types/:id", async (c) => {
    const input = await parseBody(c, updateComponentTypeSchema);
    const row = await renameComponentType(parseId(c, "id"), input, database);
    return ok(c, row);
  });

  routes.delete("/api/v1/component-types/:id", async (c) => {
    const row = await deleteComponentType(parseId(c, "id"), database);
    if (!row) throw notFound("Component type");
    return ok(c, row);
  });

  /* component codes */
  routes.post("/api/v1/component-codes", async (c) => {
    const input = await parseBody(c, createComponentCodeSchema);
    return ok(c, await createComponentCode(input, database), 201);
  });

  routes.get("/api/v1/component-codes/:id", async (c) => {
    const row = await getComponentCodeById(parseId(c, "id"), database);
    if (!row) throw notFound("Component code");
    return ok(c, row);
  });

  routes.patch("/api/v1/component-codes/:id", async (c) => {
    const input = compactUpdate(await parseBody(c, updateComponentCodeSchema));
    const row = await updateComponentCode(parseId(c, "id"), input, database);
    if (!row) throw notFound("Component code");
    return ok(c, row);
  });

  routes.delete("/api/v1/component-codes/:id", async (c) => {
    const row = await deleteComponentCode(parseId(c, "id"), database);
    if (!row) throw notFound("Component code");
    return ok(c, row);
  });

  return routes;
};
