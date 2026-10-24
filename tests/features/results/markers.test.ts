import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import { createTestUser } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { resultRoutes } from "../../../src/features/results/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, resultRoutes);
let adminToken = "";

const post = (body: unknown) =>
  authRequest("/api/v1/targets/results", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// Two results with separate clips; one clip owns duplicated and ordered points.
const seedMarkers = async () => {
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
  await testDb.insert(schema.description).values({
    descriptionId: 100,
    taskCodeId: 10,
    label: "I",
  });
  await testDb.insert(schema.result).values([
    {
      displayNumber: 5001,
      resultId: 5001,
      inspectionTypeCode: "GVI",
      descriptionId: 100,
      layer: 1,
      masterStartMs: 0,
      projectId: 1,
      sessionId: 101,
    },
    {
      displayNumber: 5002,
      resultId: 5002,
      inspectionTypeCode: "CVI",
      descriptionId: 100,
      layer: 2,
      masterStartMs: 0,
      projectId: 1,
      sessionId: 101,
    },
  ]);
  await testDb.insert(schema.videoClip).values([
    {
      clipId: 9001,
      resultId: 5001,
      sessionId: 101,
      startOffsetMs: 0,
      endOffsetMs: 5000,
    },
    {
      clipId: 9002,
      resultId: 5002,
      sessionId: 101,
      startOffsetMs: 6000,
      endOffsetMs: 9000,
    },
  ]);
  await testDb.insert(schema.clipEventMarker).values([
    { clipId: 9001, positionMs: 1500 },
    { clipId: 9001, positionMs: 500 },
    { clipId: 9001, positionMs: 500 },
  ]);
};

const clipsOf = (data: any, resultId: number) =>
  data.sessions.flatMap((session: any) => session.results).find(
    (entry: any) => entry.resultId === resultId,
  ).clips;

describe("marker result reads", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(async () => {
    await truncateTestDatabase();
    adminToken = (await createTestUser({ preset: "Admin" })).token;
  });

  it("returns ordered markers on their own clips in target and batch reads", async () => {
    await seedMarkers();

    const single = await json(await authRequest("/api/v1/descriptions/100/results"));
    const batch = await json(
      await post({ descriptionIds: [100], partCodeIds: [] }),
    );

    const resultClips = clipsOf(single.data, 5001);
    expect(resultClips[0].eventMarkers.map((marker: any) => marker.positionMs)).toEqual([
      500,
      500,
      1500,
    ]);
    expect(clipsOf(single.data, 5002)[0].eventMarkers).toEqual([]);
    expect(batch.data["description:100"]).toEqual(single.data);
  });

  it("returns the same markers through result evidence", async () => {
    await seedMarkers();

    const evidence = await json(await authRequest("/api/v1/results/5001/evidence"));

    expect(evidence.data.clips[0].eventMarkers.map((marker: any) => marker.positionMs)).toEqual([
      500,
      500,
      1500,
    ]);
  });
});

// Every request carries the Admin token minted in beforeEach.
const authRequest = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...((init.headers ?? {}) as Record<string, string>),
      authorization: `Bearer ${adminToken}`,
    },
  });
