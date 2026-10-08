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

// full chain: project > group > task code > description > type > part code
const seedChain = async () => {
  const projectId = (await json(await post("/api/v1/projects", { title: "Alpha" }))).data
    .projectId as number;

  const groupRes = await post("/api/v1/task-groups", {
    projectId,
    code: "100",
  });
  expect(groupRes.status).toBe(201);
  const taskGroupId = (await json(groupRes)).data.taskGroupId as number;

  const codeRes = await post("/api/v1/task-codes", {
    taskGroupId,
    code: "101",
  });
  expect(codeRes.status).toBe(201);
  const taskCodeId = (await json(codeRes)).data.taskCodeId as number;

  const descriptionRes = await post("/api/v1/descriptions", {
    taskCodeId,
    label: "Row A",
  });
  expect(descriptionRes.status).toBe(201);
  const descriptionId = (await json(descriptionRes)).data.descriptionId as number;

  const typeRes = await post("/api/v1/types", {
    descriptionId,
    code: "VDM",
  });
  expect(typeRes.status).toBe(201);
  const typeId = (await json(typeRes)).data.typeId as number;

  const partRes = await post("/api/v1/part-codes", {
    typeId,
    code: "101-105",
  });
  expect(partRes.status).toBe(201);
  const partCodeId = (await json(partRes)).data.partCodeId as number;

  return { projectId, taskGroupId, taskCodeId, descriptionId, typeId, partCodeId };
};

const seedProject = async () => {
  const res = await post("/api/v1/projects", { title: "Alpha" });
  return (await json(res)).data.projectId as number;
};

// flow: seed chain > tree read > type rules > cascade
describe("task structure routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("builds the tree and returns it nested", async () => {
    const { projectId } = await seedChain();

    // anode-style branch: description with no type children
    const anodeGroup = await json(
      await post("/api/v1/task-groups", { projectId, code: "800" }),
    );
    const anodeCode = await json(
      await post("/api/v1/task-codes", {
        taskGroupId: anodeGroup.data.taskGroupId,
        code: "801",
      }),
    );
    await post("/api/v1/descriptions", {
      taskCodeId: anodeCode.data.taskCodeId,
      label: "Anode A-1",
    });

    const treeRes = await app.request(`/api/v1/projects/${projectId}/task-structure`);
    expect(treeRes.status).toBe(200);
    const tree = (await json(treeRes)).data as Array<Record<string, any>>;

    expect(tree).toHaveLength(2);
    expect(tree[0]!.code).toBe("100");
    expect(tree[0]!.taskCodes[0]!.code).toBe("101");
    expect(tree[0]!.taskCodes[0]!.descriptions[0]!.label).toBe("Row A");
    expect(tree[0]!.taskCodes[0]!.descriptions[0]!.types[0]!.code).toBe("VDM");
    expect(tree[0]!.taskCodes[0]!.descriptions[0]!.types[0]!.partCodes[0]!.code).toBe("101-105");
    expect(tree[1]!.code).toBe("800");
    expect(tree[1]!.taskCodes[0]!.descriptions[0]!.types).toEqual([]);
  });

  it("rejects a duplicate group code within the project", async () => {
    const projectId = await seedProject();
    await post("/api/v1/task-groups", { projectId, code: "100" });

    const dup = await post("/api/v1/task-groups", { projectId, code: "100" });
    expect(dup.status).toBe(409);
  });

  it("refuses the same type code twice under one description", async () => {
    const { descriptionId } = await seedChain();

    const dup = await post("/api/v1/types", {
      descriptionId,
      code: "VDM",
    });
    expect(dup.status).toBe(409);

    // the same code under a DIFFERENT description is fine: local vocabulary
    const { taskCodeId } = { taskCodeId: (await seedChain()).taskCodeId };
    const comp2 = await json(await post("/api/v1/descriptions", { taskCodeId, label: "Row B" }));
    const elsewhere = await post("/api/v1/types", {
      descriptionId: comp2.data.descriptionId,
      code: "VDM",
    });
    expect(elsewhere.status).toBe(201);
  });

  it("type-catalog lists the distinct type codes across the tree", async () => {
    const { projectId, taskCodeId } = await seedChain();

    const comp2 = await json(await post("/api/v1/descriptions", { taskCodeId, label: "Row B" }));
    await post("/api/v1/types", {
      descriptionId: comp2.data.descriptionId,
      code: "VDM",
    });

    const catalogRes = await app.request(`/api/v1/projects/${projectId}/type-catalog`);
    const catalog = (await json(catalogRes)).data as Array<Record<string, any>>;
    expect(catalog).toHaveLength(1);
    expect(catalog[0]!.code).toBe("VDM");
  });

  it("renames a type in place and the tree follows", async () => {
    const { projectId, typeId } = await seedChain();

    const renamed = await patch(`/api/v1/types/${typeId}`, {
      code: "VHM",
    });
    expect(renamed.status).toBe(200);
    expect((await json(renamed)).data.typeId).toBe(typeId);

    const tree = (await json(
      await app.request(`/api/v1/projects/${projectId}/task-structure`),
    )).data as Array<Record<string, any>>;
    expect(tree[0]!.taskCodes[0]!.descriptions[0]!.types[0]!.code).toBe("VHM");
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

  // codes are free text, so no alphabetical rule can order them: the row order
  // is the order the operator added them
  it("lists groups in creation order, not code order", async () => {
    const projectId = await seedProject();

    for (const code of ["103", "101", "102"]) {
      const created = await post("/api/v1/task-groups", { projectId, code });
      expect(created.status).toBe(201);
    }

    const tree = (await json(
      await app.request(`/api/v1/projects/${projectId}/task-structure`),
    )).data as Array<Record<string, any>>;

    expect(tree.map((row) => row.code)).toEqual(["103", "101", "102"]);
  });
});
