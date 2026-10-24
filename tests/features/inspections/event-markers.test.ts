import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import {
  createClipEventMarkerRecords,
  listClipEventMarkerRecordsByClipIds,
} from "../../../src/db/repositories/clip-event-marker.repository";
import * as schema from "../../../src/db/schema";

// One result with two clips, enough to prove clip isolation and cascade removal.
const seedClips = async () => {
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
    taskGroupId: 10,
    projectId: 1,
    code: "100",
  });
  await testDb.insert(schema.taskCode).values({
    taskCodeId: 20,
    taskGroupId: 10,
    code: "101",
  });
  await testDb.insert(schema.description).values({
    descriptionId: 30,
    taskCodeId: 20,
    label: "Row A",
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
  await testDb.insert(schema.videoClip).values([
    { clipId: 9001, resultId: 5001, sessionId: 101, startOffsetMs: 0, endOffsetMs: 5000 },
    { clipId: 9002, resultId: 5001, sessionId: 101, startOffsetMs: 6000, endOffsetMs: 8000 },
  ]);
};

describe("clip event marker repository", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("keeps duplicate positions and orders by clip, position, then id", async () => {
    await seedClips();

    await createClipEventMarkerRecords(
      [
        { clipId: 9002, positionMs: 200 },
        { clipId: 9001, positionMs: 1000 },
        { clipId: 9001, positionMs: 500 },
        { clipId: 9001, positionMs: 500 },
      ],
      testDb,
    );

    const rows = await listClipEventMarkerRecordsByClipIds([9001, 9002], testDb);

    expect(rows.map((row) => [row.clipId, row.positionMs])).toEqual([
      [9001, 500],
      [9001, 500],
      [9001, 1000],
      [9002, 200],
    ]);
  });

  it("returns no rows for an empty clip list", async () => {
    await expect(listClipEventMarkerRecordsByClipIds([], testDb)).resolves.toEqual([]);
  });

  it("removes markers when their clip is removed", async () => {
    await seedClips();
    await createClipEventMarkerRecords([{ clipId: 9001, positionMs: 500 }], testDb);

    await testDb.delete(schema.videoClip).where(eq(schema.videoClip.clipId, 9001));

    const rows = await testDb.query.clipEventMarker.findMany();
    expect(rows).toEqual([]);
  });
});
