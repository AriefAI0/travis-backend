// Discard is objects-first: a storage error must leave the image row in place.
// The MinIO boundary is mocked here, so this file needs no bucket.
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import * as schema from "../../../src/db/schema";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";

const removedKeys: string[] = [];
let failRemoval = true;

mock.module("../../../src/lib/minio_storage/result-image-objects", () => ({
  MAX_ADMIN_IMAGE_BYTES: 20 * 1024 * 1024,
  removeExactMediaKeys: async (keys: string[]) => {
    removedKeys.push(...keys);
    if (failRemoval) throw new Error("image object removal failed at probe.png: access denied");
  },
  readObjectHead: async () => {
    throw new Error("not used by the discard route");
  },
  matchesImageMagic: () => true,
}));

const { appFor } = await import("../../helpers/app");
const { createTestUser } = await import("../../helpers/auth");
const { resultRoutes } = await import("../../../src/features/results/routes");

const app = appFor(testDb, resultRoutes);
let operatorToken = "";

const STEM = "1-alpha-2026-10-24/session-1-2026-10-24-0016/results/5001-jl-01/evidence-img";

// A live inspection with one ready image on it.
const seedOpenInspection = async () => {
  await testDb.insert(schema.project).values({
    organizationId: testOrgId,
    displayNumber: 1,
    projectId: 1,
    title: "Alpha",
  });
  await testDb.insert(schema.session).values({
    displayNumber: 1,
    sessionId: 101,
    projectId: 1,
    name: "Run 1",
  });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 1, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 10, taskGroupId: 1, code: "101" });
  await testDb.insert(schema.description).values({
    descriptionId: 100,
    taskCodeId: 10,
    label: "JL-01",
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
  await testDb.insert(schema.resultImage).values({
    imageId: 9201,
    resultId: 5001,
    storageStem: STEM,
    contentType: "image/png",
  });
};

const discard = (imageId: number) =>
  app.request(`/api/v1/images/${imageId}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${operatorToken}`,
    },
    body: JSON.stringify({ confirmPermanentRemove: true }),
  });

describe("image discard storage boundary", () => {
  beforeAll(ensureTestDatabase);
  afterAll(async () => {
    mock.restore();
    await closeTestDatabase();
  });
  beforeEach(async () => {
    await truncateTestDatabase();
    removedKeys.length = 0;
    failRemoval = true;
    const operator = await createTestUser({ preset: "Operator" });
    operatorToken = operator.token;
    await seedOpenInspection();
  });

  it("removes both exact leaves and keeps the row when storage fails", async () => {
    const res = await discard(9201);

    expect(res.status).toBe(500);
    expect(removedKeys).toEqual([`${STEM}/9201.png`, `${STEM}/9201-annotated.png`]);
    expect(await testDb.select().from(schema.resultImage)).toHaveLength(1);
  });

  it("removes the row on a retry that storage lets through", async () => {
    failRemoval = false;

    const res = await discard(9201);

    expect(res.status).toBe(200);
    expect(await testDb.select().from(schema.resultImage)).toHaveLength(0);
  });
});
