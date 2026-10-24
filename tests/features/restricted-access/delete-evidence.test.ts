// Closing an owned RA mark cascades its image rows, so its objects must go too.
// Storage is mocked here, so this file needs no bucket.
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
const markCountAtRemoval: number[] = [];
let failRemoval = false;

mock.module("../../../src/lib/minio_storage/result-image-objects", () => ({
  MAX_ADMIN_IMAGE_BYTES: 20 * 1024 * 1024,
  removeExactMediaKeys: async (keys: string[]) => {
    removedKeys.push(...keys);
    markCountAtRemoval.push((await testDb.select().from(schema.result)).length);
    if (failRemoval) throw new Error("image object removal failed at probe.png: access denied");
  },
  readObjectHead: async () => {
    throw new Error("not used by delete");
  },
  matchesImageMagic: () => true,
}));

const { appFor } = await import("../../helpers/app");
const { createTestUser } = await import("../../helpers/auth");
const { restrictedAccessRoutes } = await import("../../../src/features/restricted-access/routes");

const app = appFor(testDb, restrictedAccessRoutes);
let adminToken = "";

const STEM = "1-alpha-2026-10-25/ra/row-a/evidence-img";

// One RA mark carrying two ready images.
const seedMark = async () => {
  await testDb.insert(schema.project).values({
    organizationId: testOrgId,
    displayNumber: 1,
    projectId: 1,
    title: "Alpha",
  });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 1, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 10, taskGroupId: 1, code: "101" });
  await testDb.insert(schema.description).values({
    descriptionId: 100,
    taskCodeId: 10,
    label: "Row A",
  });
  await testDb.insert(schema.result).values({
    displayNumber: 0,
    resultId: 6001,
    inspectionTypeCode: "RA",
    isRa: true,
    descriptionId: 100,
    projectId: 1,
    sessionId: null,
  });
  await testDb.insert(schema.resultImage).values([
    { imageId: 9401, resultId: 6001, storageStem: STEM, contentType: "image/png" },
    { imageId: 9402, resultId: 6001, storageStem: STEM, contentType: "image/png" },
  ]);
};

const remove = () =>
  app.request("/api/v1/restricted-access/6001", {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  });

describe("restricted-access delete evidence cleanup", () => {
  beforeAll(ensureTestDatabase);
  afterAll(async () => {
    mock.restore();
    await closeTestDatabase();
  });
  beforeEach(async () => {
    await truncateTestDatabase();
    removedKeys.length = 0;
    markCountAtRemoval.length = 0;
    failRemoval = false;
    adminToken = (await createTestUser({ preset: "Admin" })).token;
    await seedMark();
  });

  it("removes both leaves of every image after the mark is gone", async () => {
    const res = await remove();

    expect(res.status).toBe(200);
    expect(removedKeys.sort()).toEqual(
      [
        `${STEM}/9401.png`,
        `${STEM}/9401-annotated.png`,
        `${STEM}/9402.png`,
        `${STEM}/9402-annotated.png`,
      ].sort(),
    );
    expect(markCountAtRemoval).toEqual([0]);
  });

  it("surfaces a storage error after the commit", async () => {
    failRemoval = true;

    const res = await remove();

    expect(res.status).toBe(500);
    expect(await testDb.select().from(schema.result)).toHaveLength(0);
  });

  it("removes nothing when the mark is not there", async () => {
    const res = await app.request("/api/v1/restricted-access/6999", {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(404);
    expect(removedKeys).toEqual([]);
  });
});
