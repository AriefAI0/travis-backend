import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { taskStructureRoutes } from "../../../src/features/task-structure/routes";
import { projectRoutes } from "../../../src/features/projects/routes";

const app = appFor(testDb, taskStructureRoutes, projectRoutes);

const post = async (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const patch = async (path: string, body: unknown) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// full chain: project > group > task code > main component > type branch > component code
const seedChain = async () => {
  const projectId = (await json(await post("/api/v1/projects", { title: "Alpha" }))).data
    .projectId as number;

  const groupRes = await post("/api/v1/task-groups", {
    projectId,
    groupCode: "100",
    label: "Row inspections",
  });
  expect(groupRes.status).toBe(201);
  const taskGroupId = (await json(groupRes)).data.taskGroupId as number;

  const codeRes = await post("/api/v1/task-codes", {
    taskGroupId,
    code: "101",
    label: "Row A tasks",
  });
  expect(codeRes.status).toBe(201);
  const taskCodeId = (await json(codeRes)).data.taskCodeId as number;

  const compRes = await post("/api/v1/main-components", {
    taskCodeId,
    description: "Row A",
  });
  expect(compRes.status).toBe(201);
  const mainComponentId = (await json(compRes)).data.mainComponentId as number;

  const branchRes = await post("/api/v1/main-component-types", {
    mainComponentId,
    typeCode: "VDM",
    label: "Vertical Diagonal Member",
  });
  expect(branchRes.status).toBe(201);
  const mainComponentTypeId = (await json(branchRes)).data.mainComponentTypeId as number;

  const codeRowRes = await post("/api/v1/component-codes", {
    mainComponentTypeId,
    code: "101-105",
  });
  expect(codeRowRes.status).toBe(201);
  const componentCodeId = (await json(codeRowRes)).data.componentCodeId as number;

  return { projectId, taskGroupId, taskCodeId, mainComponentId, mainComponentTypeId, componentCodeId };
};

const seedProject = async () => {
  const res = await post("/api/v1/projects", { title: "Alpha" });
  return (await json(res)).data.projectId as number;
};

// flow: seed chain > tree read > catalog rules > cascade
describe("task structure routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("builds the tree and returns it nested", async () => {
    const { projectId } = await seedChain();

    // anode-style branch: main component with no type children
    const anodeGroup = await json(
      await post("/api/v1/task-groups", { projectId, groupCode: "800", label: "Anodes" }),
    );
    const anodeCode = await json(
      await post("/api/v1/task-codes", {
        taskGroupId: anodeGroup.data.taskGroupId,
        code: "801",
        label: "Anode A-1",
      }),
    );
    await post("/api/v1/main-components", {
      taskCodeId: anodeCode.data.taskCodeId,
      description: "Anode A-1",
    });

    const treeRes = await app.request(`/api/v1/projects/${projectId}/task-structure`);
    expect(treeRes.status).toBe(200);
    const tree = (await json(treeRes)).data as Array<Record<string, any>>;

    expect(tree).toHaveLength(2);
    expect(tree[0].groupCode).toBe("100");
    expect(tree[0].taskCodes[0].code).toBe("101");
    expect(tree[0].taskCodes[0].mainComponents[0].description).toBe("Row A");
    expect(tree[0].taskCodes[0].mainComponents[0].types[0].typeCode).toBe("VDM");
    expect(tree[0].taskCodes[0].mainComponents[0].types[0].componentCodes[0].code).toBe("101-105");
    expect(tree[1].groupCode).toBe("800");
    expect(tree[1].taskCodes[0].mainComponents[0].types).toEqual([]);
  });

  it("rejects a duplicate group code within the project", async () => {
    const projectId = await seedProject();
    await post("/api/v1/task-groups", { projectId, groupCode: "100", label: "First" });

    const dup = await post("/api/v1/task-groups", { projectId, groupCode: "100", label: "Second" });
    expect(dup.status).toBe(409);
  });

  it("creates the catalog type once and reuses it across components", async () => {
    const { projectId, taskCodeId } = await seedChain();

    const comp2 = await json(
      await post("/api/v1/main-components", { taskCodeId, description: "Row B" }),
    );
    await post("/api/v1/main-component-types", {
      mainComponentId: comp2.data.mainComponentId,
      typeCode: "VDM",
      label: "Vertical Diagonal Member",
    });

    const catalogRes = await app.request(`/api/v1/projects/${projectId}/component-types`);
    const catalog = (await json(catalogRes)).data as Array<Record<string, any>>;
    expect(catalog).toHaveLength(1);
  });

  it("renames a catalog type in place and the tree follows", async () => {
    const { projectId } = await seedChain();

    const catalog = (await json(
      await app.request(`/api/v1/projects/${projectId}/component-types`),
    )).data as Array<Record<string, any>>;
    const typeId = catalog[0].componentTypeId;

    const renamed = await patch(`/api/v1/component-types/${typeId}`, {
      typeCode: "VHM",
      label: "Vertical Horizontal Member",
    });
    expect(renamed.status).toBe(200);
    expect((await json(renamed)).data.componentTypeId).toBe(typeId);

    const tree = (await json(
      await app.request(`/api/v1/projects/${projectId}/task-structure`),
    )).data as Array<Record<string, any>>;
    expect(tree[0].taskCodes[0].mainComponents[0].types[0].typeCode).toBe("VHM");
  });

  it("refuses to delete an in-use catalog type and deletes an unused one", async () => {
    const { projectId } = await seedChain();

    const catalog = (await json(
      await app.request(`/api/v1/projects/${projectId}/component-types`),
    )).data as Array<Record<string, any>>;
    const inUseId = catalog[0].componentTypeId;

    const refused = await app.request(`/api/v1/component-types/${inUseId}`, { method: "DELETE" });
    expect(refused.status).toBe(409);

    const created = await json(
      await post(`/api/v1/projects/${projectId}/component-types`, {
        typeCode: "UNUSED",
        label: "Unused type",
      }),
    );
    const deleted = await app.request(`/api/v1/component-types/${created.data.componentTypeId}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
  });

  it("deleting a task group cascades the whole subtree", async () => {
    const { projectId, taskGroupId } = await seedChain();

    const del = await app.request(`/api/v1/task-groups/${taskGroupId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const tree = (await json(
      await app.request(`/api/v1/projects/${projectId}/task-structure`),
    )).data as unknown[];
    expect(tree).toHaveLength(0);
  });

  it("filters the type catalog by query", async () => {
    const { projectId } = await seedChain();
    await post(`/api/v1/projects/${projectId}/component-types`, {
      typeCode: "VHM",
      label: "Vertical Horizontal Member",
    });

    const filtered = (await json(
      await app.request(`/api/v1/projects/${projectId}/component-types?q=vh`),
    )).data as Array<Record<string, any>>;
    expect(filtered).toHaveLength(1);
    expect(filtered[0].typeCode).toBe("VHM");
  });
});
