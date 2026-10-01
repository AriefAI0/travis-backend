import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  createDescription,
  createPartCode,
  createTaskCode,
  createTaskGroup,
  createType,
  deleteDescription,
  deletePartCode,
  deleteTaskCode,
  deleteTaskGroup,
  deleteTaskStructureSelection,
  deleteType,
  getDescriptionById,
  getPartCodeById,
  getTaskCodeById,
  getTaskGroupById,
  getTypeById,
  listPartCodesByTypeId,
  listProjectTaskStructureTree,
  listTaskCodesByGroupId,
  listTypeCatalog,
  previewTaskStructureDelete,
  updateDescription,
  updatePartCode,
  updateTaskCode,
  updateTaskGroup,
  updateType,
} from "../../db/services/task-structure.service";
import { notFound } from "../../lib/error";
import { compactUpdate, parseBody, parseId, parseQuery } from "../../lib/parse";
import { ok } from "../../lib/response";
import {
  bulkDeleteTaskStructureSchema,
  createDescriptionSchema,
  createPartCodeSchema,
  createTaskCodeSchema,
  createTaskGroupSchema,
  createTypeSchema,
  typeCatalogQuerySchema,
  updateDescriptionSchema,
  updatePartCodeSchema,
  updateTaskCodeSchema,
  updateTaskGroupSchema,
  updateTypeSchema,
} from "../../types/api";

// task tree reads + per-level CRUD (parse > service > ok)
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

  /* descriptions */
  routes.post("/api/v1/descriptions", async (c) => {
    const input = await parseBody(c, createDescriptionSchema);
    return ok(c, await createDescription(input, database), 201);
  });

  routes.get("/api/v1/descriptions/:id", async (c) => {
    const row = await getDescriptionById(parseId(c, "id"), database);
    if (!row) throw notFound("Description");
    return ok(c, row);
  });

  routes.patch("/api/v1/descriptions/:id", async (c) => {
    const input = compactUpdate(await parseBody(c, updateDescriptionSchema));
    const row = await updateDescription(parseId(c, "id"), input, database);
    if (!row) throw notFound("Description");
    return ok(c, row);
  });

  routes.delete("/api/v1/descriptions/:id", async (c) => {
    const row = await deleteDescription(parseId(c, "id"), database);
    if (!row) throw notFound("Description");
    return ok(c, row);
  });

  /* types (owned by one description) */
  routes.post("/api/v1/types", async (c) => {
    const input = await parseBody(c, createTypeSchema);
    return ok(c, await createType(input, database), 201);
  });

  routes.get("/api/v1/types/:id", async (c) => {
    const row = await getTypeById(parseId(c, "id"), database);
    if (!row) throw notFound("Type");
    return ok(c, row);
  });

  routes.patch("/api/v1/types/:id", async (c) => {
    const input = compactUpdate(await parseBody(c, updateTypeSchema));
    const row = await updateType(parseId(c, "id"), input, database);
    if (!row) throw notFound("Type");
    return ok(c, row);
  });

  routes.delete("/api/v1/types/:id", async (c) => {
    const row = await deleteType(parseId(c, "id"), database);
    if (!row) throw notFound("Type");
    return ok(c, row);
  });

  /* part codes */
  routes.post("/api/v1/part-codes", async (c) => {
    const input = await parseBody(c, createPartCodeSchema);
    return ok(c, await createPartCode(input, database), 201);
  });

  routes.get("/api/v1/part-codes/:id", async (c) => {
    const row = await getPartCodeById(parseId(c, "id"), database);
    if (!row) throw notFound("Part code");
    return ok(c, row);
  });

  routes.patch("/api/v1/part-codes/:id", async (c) => {
    const input = compactUpdate(await parseBody(c, updatePartCodeSchema));
    const row = await updatePartCode(parseId(c, "id"), input, database);
    if (!row) throw notFound("Part code");
    return ok(c, row);
  });

  routes.delete("/api/v1/part-codes/:id", async (c) => {
    const row = await deletePartCode(parseId(c, "id"), database);
    if (!row) throw notFound("Part code");
    return ok(c, row);
  });

  /* project type vocabulary: autocomplete from the tree, no catalog table */
  routes.get("/api/v1/projects/:projectId/type-catalog", async (c) => {
    const projectId = parseId(c, "projectId");
    parseQuery(c, typeCatalogQuerySchema);
    return ok(c, await listTypeCatalog(projectId, database));
  });

  /* bulk delete: one route, preview reads and delete writes the same selection */
  routes.post("/api/v1/task-structure/bulk-delete", async (c) => {
    const input = await parseBody(c, bulkDeleteTaskStructureSchema);
    const preview =
      input.mode === "preview"
        ? await previewTaskStructureDelete(input.nodes, database)
        : await deleteTaskStructureSelection(input.nodes, database);
    return ok(c, preview);
  });

  return routes;
};
