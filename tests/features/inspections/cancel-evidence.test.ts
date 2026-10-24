// Cancelling an open inspection removes the evidence objects its cascade would
// otherwise orphan. Storage is mocked here, so this file needs no bucket.
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";

import * as schema from "../../../src/db/schema";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";

const removedKeys: string[] = [];
const sweptPrefixes: string[] = [];
let failRemoval = false;
// set by the mock itself, so every call proves the row was already gone
const rowCountAtRemoval: number[] = [];

mock.module("../../../src/lib/minio_storage/result-image-objects", () => ({
  MAX_ADMIN_IMAGE_BYTES: 20 * 1024 * 1024,
  removeExactMediaKeys: async (keys: string[]) => {
    removedKeys.push(...keys);
    rowCountAtRemoval.push((await testDb.select().from(schema.result)).length);
    if (failRemoval) throw new Error("image object removal failed at probe.png: access denied");
  },
  readObjectHead: async () => {
    throw new Error("not used by cancel");
  },
  matchesImageMagic: () => true,
}));

mock.module("../../../src/lib/minio_storage/cleanup", () => ({
  removeMediaPrefix: async (keyPrefix: string) => {
    sweptPrefixes.push(keyPrefix);
  },
  removeMediaKeys: async () => {},
}));

const { appFor } = await import("../../helpers/app");
const { createTestUser } = await import("../../helpers/auth");
const { inspectionRoutes } = await import("../../../src/features/inspections/routes");

const app = appFor(testDb, inspectionRoutes);
let operatorToken = "";

const STEM = "1-alpha-2026-10-25/session-1-2026-10-25-0016/results/5001-jl-01/evidence-img";

// One open inspection with a clip ingest and two evidence images on it.
const seedInspection = async () => {
  await testDb.insert(schema.project).values({
    organizationId: testOrgId,
    displayNumber: 1,
    projectId: 1,
    title: "Alpha",
  });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 10, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 20, taskGroupId: 10, code: "101" });
  await testDb.insert(schema.description).values({
    descriptionId: 30,
    taskCodeId: 20,
    label: "Row A",
  });
  await testDb.insert(schema.session).values({
    displayNumber: 1,
    sessionId: 101,
    projectId: 1,
    name: "Run 1",
    startEpoch: 1000,
  });
  await testDb.insert(schema.result).values({
    displayNumber: 5001,
    resultId: 5001,
    inspectionTypeCode: "GVI",
    descriptionId: 30,
    layer: 1,
    masterStartMs: 0,
    projectId: 1,
    sessionId: 101,
  });
  await testDb.insert(schema.videoClip).values({
    clipId: 7,
    resultId: 5001,
    sessionId: 101,
    startOffsetMs: 0,
  });
  await testDb.insert(schema.clipEventMarker).values({ clipId: 7, positionMs: 700 });
  await testDb.insert(schema.recordingIngest).values({
    kind: "clip",
    clipId: 7,
    ticketHash: "c".repeat(64),
    keyDate: "2026-10-25",
    keyPrefix: "1/1/101/2026/10/25/clips/7",
  });
  await testDb.insert(schema.resultImage).values([
    { imageId: 9301, resultId: 5001, storageStem: STEM, contentType: "image/png" },
    {
      imageId: 9302,
      resultId: 5001,
      storageStem: STEM,
      contentType: "image/jpeg",
      hasAnnotated: true,
    },
  ]);
};

const cancel = () =>
  app.request("/api/v1/inspections/5001/cancel", {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}` },
  });

describe("inspection cancel evidence cleanup", () => {
  beforeAll(ensureTestDatabase);
  afterAll(async () => {
    mock.restore();
    await closeTestDatabase();
  });
  beforeEach(async () => {
    await truncateTestDatabase();
    removedKeys.length = 0;
    sweptPrefixes.length = 0;
    rowCountAtRemoval.length = 0;
    failRemoval = false;
    operatorToken = (await createTestUser({ preset: "Operator" })).token;
    await seedInspection();
  });

  it("removes the raw and annotated leaves of every image after the commit", async () => {
    const res = await cancel();

    expect(res.status).toBe(200);
    expect(removedKeys.sort()).toEqual(
      [
        `${STEM}/9301.png`,
        `${STEM}/9301-annotated.png`,
        `${STEM}/9302.jpg`,
        `${STEM}/9302-annotated.jpg`,
      ].sort(),
    );
    // the row delete committed before any object removal ran
    expect(rowCountAtRemoval).toEqual([0]);
    // the clip sweep still runs
    expect(sweptPrefixes).toEqual(["1/1/101/2026/10/25/clips/7"]);
    expect(await testDb.query.clipEventMarker.findMany()).toEqual([]);
  });

  it("surfaces a storage error after the commit and never claims the row survived", async () => {
    failRemoval = true;

    const res = await cancel();

    expect(res.status).toBe(500);
    expect(await testDb.select().from(schema.result)).toHaveLength(0);
  });

  it("keeps the row and touches no object when the open guard refuses", async () => {
    await testDb
      .update(schema.result)
      .set({ masterEndMs: 4000 })
      .where(eq(schema.result.resultId, 5001));

    const res = await cancel();

    expect(res.status).toBe(409);
    expect(removedKeys).toEqual([]);
    expect(await testDb.select().from(schema.resultImage)).toHaveLength(2);
  });
});
