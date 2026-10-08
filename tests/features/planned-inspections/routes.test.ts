import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { plannedInspectionRoutes } from "../../../src/features/planned-inspections/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, plannedInspectionRoutes);

const post = (body: unknown) =>
  app.request("/api/v1/planned-inspections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const list = () => app.request("/api/v1/projects/1/planned-inspections");

const remove = (id: number) =>
  app.request(`/api/v1/planned-inspections/${id}`, { method: "DELETE" });

// one chain: project > group > task code > description > type > part code
const seedTree = async () => {
  await testDb.insert(schema.project).values({ displayNumber: 1, projectId: 1, title: "Alpha" });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 1, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 10, taskGroupId: 1, code: "101" });
  await testDb.insert(schema.description).values({ descriptionId: 100, taskCodeId: 10, label: "I" });
  await testDb.insert(schema.type).values({ typeId: 200, descriptionId: 100, code: "T1" });
  await testDb.insert(schema.partCode).values({ partCodeId: 300, typeId: 200, code: "P1" });
};

beforeAll(ensureTestDatabase);
beforeEach(async () => {
  await truncateTestDatabase();
  await seedTree();
});
afterAll(closeTestDatabase);

describe("planned inspections", () => {
  it("adds a planned type on a description target", async () => {
    const res = await post({ projectId: 1, inspectionTypeCode: "GVI", descriptionId: 100 });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.data.inspectionTypeCode).toBe("GVI");
    expect(body.data.descriptionId).toBe(100);
  });

  it("refuses a duplicate type on the same target", async () => {
    await post({ projectId: 1, inspectionTypeCode: "GVI", descriptionId: 100 });
    const res = await post({ projectId: 1, inspectionTypeCode: "GVI", descriptionId: 100 });
    expect(res.status).toBe(409);
  });

  it("allows the same type on a different target", async () => {
    await post({ projectId: 1, inspectionTypeCode: "GVI", descriptionId: 100 });
    const res = await post({ projectId: 1, inspectionTypeCode: "GVI", partCodeId: 300 });
    expect(res.status).toBe(201);
  });

  it("allows several types on one target", async () => {
    await post({ projectId: 1, inspectionTypeCode: "GVI", descriptionId: 100 });
    const res = await post({ projectId: 1, inspectionTypeCode: "CVI", descriptionId: 100 });
    expect(res.status).toBe(201);
  });

  it("refuses both targets and neither target", async () => {
    const both = await post({
      projectId: 1,
      inspectionTypeCode: "GVI",
      descriptionId: 100,
      partCodeId: 300,
    });
    expect(both.status).toBe(400);
    const neither = await post({ projectId: 1, inspectionTypeCode: "GVI" });
    expect(neither.status).toBe(400);
  });

  it("refuses an unknown target with 404", async () => {
    const res = await post({ projectId: 1, inspectionTypeCode: "GVI", descriptionId: 999 });
    expect(res.status).toBe(404);
  });

  it("lists a project's planned rows and deletes one", async () => {
    const first = await json(await post({ projectId: 1, inspectionTypeCode: "GVI", descriptionId: 100 }));
    await post({ projectId: 1, inspectionTypeCode: "CVI", partCodeId: 300 });

    const listed = await json(await list());
    expect(listed.data).toHaveLength(2);

    const removed = await remove(first.data.plannedInspectionId as number);
    expect(removed.status).toBe(200);

    const after = await json(await list());
    expect(after.data).toHaveLength(1);
    expect(after.data[0].inspectionTypeCode).toBe("CVI");

    const again = await remove(first.data.plannedInspectionId as number);
    expect(again.status).toBe(404);
  });
});
