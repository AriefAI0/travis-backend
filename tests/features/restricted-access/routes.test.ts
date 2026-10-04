import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { restrictedAccessRoutes } from "../../../src/features/restricted-access/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, restrictedAccessRoutes);

const post = (body: unknown) =>
  app.request("/api/v1/restricted-access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const list = () => app.request("/api/v1/projects/1/restricted-access");

const remove = (id: number) =>
  app.request(`/api/v1/restricted-access/${id}`, { method: "DELETE" });

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

describe("restricted access", () => {
  it("marks a target RA as a sessionless result row", async () => {
    const res = await post({ projectId: 1, descriptionId: 100, remarks: "structure blocks robot" });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.data.inspectionTypeCode).toBe("RA");
    expect(body.data.isRa).toBe(true);
    expect(body.data.sessionId).toBeNull();
    expect(body.data.remarks).toBe("structure blocks robot");
  });

  it("refuses a second RA on the same target", async () => {
    await post({ projectId: 1, descriptionId: 100 });
    const res = await post({ projectId: 1, descriptionId: 100 });
    expect(res.status).toBe(409);
  });

  it("allows RA on a different target", async () => {
    await post({ projectId: 1, descriptionId: 100 });
    const res = await post({ projectId: 1, partCodeId: 300 });
    expect(res.status).toBe(201);
  });

  it("refuses both targets and neither target", async () => {
    const both = await post({ projectId: 1, descriptionId: 100, partCodeId: 300 });
    expect(both.status).toBe(400);
    const neither = await post({ projectId: 1 });
    expect(neither.status).toBe(400);
  });

  it("refuses an unknown target with 404", async () => {
    const res = await post({ projectId: 1, partCodeId: 999 });
    expect(res.status).toBe(404);
  });

  it("lists a project's marks and unmarks one", async () => {
    const first = await json(await post({ projectId: 1, descriptionId: 100 }));
    await post({ projectId: 1, partCodeId: 300 });

    const listed = await json(await list());
    expect(listed.data).toHaveLength(2);

    const removed = await remove(first.data.resultId as number);
    expect(removed.status).toBe(200);

    const after = await json(await list());
    expect(after.data).toHaveLength(1);
    expect(after.data[0].partCodeId).toBe(300);

    const again = await remove(first.data.resultId as number);
    expect(again.status).toBe(404);
  });

  it("refuses to delete a real result through the RA endpoint", async () => {
    const real = await testDb
      .insert(schema.result)
      .values({
        resultId: 500,
        inspectionTypeCode: "GVI",
        projectId: 1,
        sessionId: null,
        descriptionId: 100,
        displayNumber: 0,
      })
      .returning();
    expect(real[0]?.resultId).toBe(500);

    const res = await remove(500);
    expect(res.status).toBe(404);
  });
});
