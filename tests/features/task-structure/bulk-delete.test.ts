import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { taskStructureRoutes } from "../../../src/features/task-structure/routes";
import { deleteTaskStructureSelection } from "../../../src/db/services/task-structure.service";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, taskStructureRoutes);

const post = (body: unknown) =>
  app.request("/api/v1/task-structure/bulk-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const preview = (nodes: unknown[]) => post({ mode: "preview", nodes });
const remove = (nodes: unknown[]) => post({ mode: "delete", nodes });

// Two results so a mid-level delete can be told apart from a leaf delete:
// 5001 hangs off the description, 5002 off the part code under it.
const seedTree = async () => {
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
    label: "Rows",
  });
  await testDb.insert(schema.taskCode).values({
    taskCodeId: 10,
    taskGroupId: 1,
    code: "101",
    label: "Row A",
  });
  await testDb.insert(schema.description).values({ descriptionId: 100, taskCodeId: 10, label: "I" });
  await testDb.insert(schema.type).values({
    typeId: 200,
    descriptionId: 100,
    code: "T1",
    label: "Type 1",
  });
  await testDb.insert(schema.partCode).values({
    partCodeId: 300,
    typeId: 200,
    code: "P1",
    label: "Part 1",
  });

  await testDb.insert(schema.result).values({
    displayNumber: 5001,
    resultId: 5001,
    inspectionTypeCode: "GVI",
    descriptionId: 100,
    layer: 1,
    masterStartMs: 0,
    // stopped, so the row reads as finished; the block test clears this
    masterEndMs: 1000,
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
    // stopped, so the row reads as finished; the block test clears this
    masterEndMs: 1000,
    projectId: 1,
    sessionId: 101,
  });

  await testDb.insert(schema.videoClip).values([
    { clipId: 1, resultId: 5001, sessionId: 101, startOffsetMs: 0 },
    { clipId: 2, resultId: 5002, sessionId: 101, startOffsetMs: 0 },
  ]);
  await testDb.insert(schema.resultImage).values([
    { imageId: 1, resultId: 5001, storageStem: "stem/evidence-img", contentType: "image/png" },
    {
      imageId: 2,
      resultId: 5002,
      storageStem: "stem/evidence-img",
      contentType: "image/png",
      hasAnnotated: true,
    },
  ]);
  await testDb.insert(schema.recordingIngest).values([
    {
      ingestId: 1,
      kind: "clip",
      clipId: 1,
      ticketHash: "a",
      keyDate: "2026-01-01",
      keyPrefix: "p/clip-1",
      closedAt: new Date(),
    },
    {
      ingestId: 2,
      kind: "clip",
      clipId: 2,
      ticketHash: "b",
      keyDate: "2026-01-01",
      keyPrefix: "p/clip-2",
      closedAt: new Date(),
    },
  ]);
};

const remaining = async () => ({
  results: (await testDb.select().from(schema.result)).length,
  clips: (await testDb.select().from(schema.videoClip)).length,
  images: (await testDb.select().from(schema.resultImage)).length,
  ingests: (await testDb.select().from(schema.recordingIngest)).length,
});

describe("bulk delete", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("counts a whole subtree before anything is removed", async () => {
    await seedTree();

    const res = await json(await preview([{ kind: "task_group", id: 1 }]));

    expect(res.data).toEqual({
      // task code + description + type + part code sit below the group
      children: 4,
      results: 2,
      clips: 2,
      images: 2,
      blocked: false,
      reason: null,
    });
    // a preview never writes
    expect((await remaining()).results).toBe(2);
  });

  it("counts only the branch a deeper selection owns", async () => {
    await seedTree();

    const res = await json(await preview([{ kind: "part_code", id: 300 }]));

    expect(res.data.children).toBe(0);
    expect(res.data.results).toBe(1);
    expect(res.data.images).toBe(1);
  });

  // One test per level: the DB cascade is what does the work, so each level must
  // reach the same rows the preview promised.
  // A type and a part code leave the description standing, so the result that
  // hangs off the description itself survives those two.
  const levels = [
    { kind: "task_group", id: 1, results: 0 },
    { kind: "task_code", id: 10, results: 0 },
    { kind: "description", id: 100, results: 0 },
    { kind: "type", id: 200, results: 1 },
    { kind: "part_code", id: 300, results: 1 },
  ];

  for (const level of levels) {
    it(`cascades results, clips and images from a ${level.kind}`, async () => {
      await seedTree();

      const res = await json(await remove([{ kind: level.kind, id: level.id }]));

      expect(res.data.results).toBe(level.results === 0 ? 2 : 1);
      const left = await remaining();
      expect(left.results).toBe(level.results);
      // every clip, image and ingest follows its result out
      expect(left.clips).toBe(level.results);
      expect(left.images).toBe(level.results);
      expect(left.ingests).toBe(level.results);
    });
  }

  it("removes the selected rows and leaves the rest of the project", async () => {
    await seedTree();

    await remove([{ kind: "part_code", id: 300 }]);

    const parts = await testDb.select().from(schema.partCode);
    const descriptions = await testDb.select().from(schema.description);
    expect(parts).toHaveLength(0);
    expect(descriptions).toHaveLength(1);
    expect((await remaining()).results).toBe(1);
  });

  // A running inspection means media is still being written under the selection.
  it("refuses with 409 while an inspection under the node is open", async () => {
    await seedTree();
    await testDb
      .update(schema.result)
      .set({ masterEndMs: null })
      .where(eq(schema.result.resultId, 5001));

    const res = await remove([{ kind: "description", id: 100 }]);

    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("wrong_state");
    // nothing was touched
    expect((await remaining()).results).toBe(2);
  });

  it("refuses with 409 while a recording under the node is unclosed", async () => {
    await seedTree();
    await testDb.update(schema.recordingIngest).set({ closedAt: null }).where(eq(schema.recordingIngest.ingestId, 2));

    const res = await remove([{ kind: "part_code", id: 300 }]);

    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("wrong_state");
    expect((await remaining()).results).toBe(2);
  });

  it("reports the block on preview without refusing it", async () => {
    await seedTree();
    await testDb.update(schema.recordingIngest).set({ closedAt: null }).where(eq(schema.recordingIngest.ingestId, 1));

    const res = await json(await preview([{ kind: "task_group", id: 1 }]));

    expect(res.data.blocked).toBe(true);
    expect(res.data.reason).toContain("still open");
  });

  // The whole selection rides one transaction, so a caller that rolls back keeps
  // every row. This is what makes a half-applied selection impossible.
  it("rolls the whole selection back when the transaction fails", async () => {
    await seedTree();

    await expect(
      testDb.transaction(async (tx) => {
        await deleteTaskStructureSelection(
          [
            { kind: "part_code", id: 300 },
            { kind: "description", id: 100 },
          ],
          tx,
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect((await remaining()).results).toBe(2);
  });

  // The rows are committed before storage runs, so a bucket that cannot be
  // reached must not turn a finished delete into an error.
  it("still deletes when object storage cleanup cannot run", async () => {
    await seedTree();

    const res = await remove([{ kind: "task_group", id: 1 }]);

    expect(res.status).toBe(200);
    expect((await remaining()).results).toBe(0);
  });

  it("rejects an empty or malformed selection", async () => {
    await seedTree();

    const empty = await post({ mode: "delete", nodes: [] });
    expect(empty.status).toBe(400);

    const badId = await post({ mode: "delete", nodes: [{ kind: "type", id: -1 }] });
    expect(badId.status).toBe(400);

    const badKind = await post({ mode: "delete", nodes: [{ kind: "nope", id: 1 }] });
    expect(badKind.status).toBe(400);
  });
});
