import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { resultRoutes } from "../../../src/features/results/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, resultRoutes);

const post = (body: unknown) =>
  app.request("/api/v1/targets/results", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// full chain: project > session > group > code > description > type > part code
const seedTargets = async () => {
  await testDb.insert(schema.project).values({ displayNumber: 1, projectId: 1, title: "Alpha" });
  await testDb.insert(schema.session).values({
    displayNumber: 1,
    sessionId: 101,
    projectId: 1,
    name: "Run 1",
  });
  await testDb.insert(schema.taskGroup).values({
    taskGroupId: 1,
    projectId: 1,
    code: "100",
  });
  await testDb.insert(schema.taskCode).values({
    taskCodeId: 10,
    taskGroupId: 1,
    code: "101",
  });
  await testDb.insert(schema.description).values({ descriptionId: 100, taskCodeId: 10, label: "I" });
  await testDb.insert(schema.type).values({
    typeId: 200,
    descriptionId: 100,
    code: "T1",
  });
  await testDb.insert(schema.partCode).values({
    partCodeId: 300,
    typeId: 200,
    code: "P1",
  });

  await testDb.insert(schema.result).values({
    displayNumber: 5001,
    resultId: 5001,
    inspectionTypeCode: "GVI",
    descriptionId: 100,
    layer: 1,
    masterStartMs: 0,
    projectId: 1,
    sessionId: 101,
  });
  await testDb.insert(schema.result).values({
    displayNumber: 5002,
    resultId: 5002,
    inspectionTypeCode: "CVI",
    partCodeId: 300,
    layer: 2,
    masterStartMs: 0,
    projectId: 1,
    sessionId: 101,
  });
};

// batch read stands in for the per-row calls the grids used to make
describe("target results batch route", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("matches the per-target routes for every requested target", async () => {
    await seedTargets();

    const byDescription = await json(
      await app.request("/api/v1/descriptions/100/results"),
    );
    const byPartCode = await json(await app.request("/api/v1/part-codes/300/results"));

    const batch = await json(await post({ descriptionIds: [100], partCodeIds: [300] }));

    expect(batch.data["description:100"]).toEqual(byDescription.data);
    expect(batch.data["partCode:300"]).toEqual(byPartCode.data);
  });

  it("answers an unknown target with an empty sidebar, never a gap", async () => {
    await seedTargets();

    const batch = await json(await post({ descriptionIds: [999], partCodeIds: [998] }));

    expect(batch.data["description:999"]).toEqual({
      target: { descriptionId: 999, partCodeId: null },
      sessions: [],
    });
    expect(batch.data["partCode:998"]).toEqual({
      target: { descriptionId: null, partCodeId: 998 },
      sessions: [],
    });
  });

  it("keeps one entry per requested target across both id lists", async () => {
    await seedTargets();

    const batch = await json(await post({ descriptionIds: [100, 101], partCodeIds: [] }));

    expect(Object.keys(batch.data)).toEqual(["description:100", "description:101"]);
  });

  it("rejects more than 100 ids as validation_error", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => index + 1);

    const res = await post({ descriptionIds: ids, partCodeIds: [] });

    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("validation_error");
  });

  it("rejects non-positive ids as validation_error", async () => {
    const res = await post({ descriptionIds: [-1], partCodeIds: [] });

    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("validation_error");
  });

  it("answers an empty request with an empty map", async () => {
    const batch = await json(await post({ descriptionIds: [], partCodeIds: [] }));

    expect(batch.data).toEqual({});
  });
});
