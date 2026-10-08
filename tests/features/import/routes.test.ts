import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { importRoutes } from "../../../src/features/import/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, importRoutes);

const post = (body: unknown) =>
  app.request("/api/v1/import/task-structure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// one sheet row, with every optional level named unless a test overrides it
const row = (over: Record<string, unknown> = {}) => ({
  taskGroup: "Bridge A",
  taskCode: "TC-01",
  description: "Deck",
  type: null,
  partCode: null,
  preAssigned: [],
  ...over,
});

const importRows = (rows: unknown[], over: Record<string, unknown> = {}) =>
  post({ projectId: 1, mode: "append", rows, ...over });

// every table an import can touch, so a test reads the tree in one call
const tree = async () => ({
  groups: await testDb.select().from(schema.taskGroup),
  codes: await testDb.select().from(schema.taskCode),
  descriptions: await testDb.select().from(schema.description),
  types: await testDb.select().from(schema.type),
  parts: await testDb.select().from(schema.partCode),
  planned: await testDb.select().from(schema.plannedInspection),
});

const seedProject = async () => {
  await testDb
    .insert(schema.project)
    .values({ displayNumber: 1, projectId: 1, title: "Alpha" });
};

// The whole sheet is the fixture for the repeat-import tests: two rows, the
// second carrying the pre-assigned codes.
const sheet = () => [
  row(),
  row({ description: "Rail", type: "GVI", partCode: "P1", preAssigned: ["GVI", "CVI"] }),
];

describe("task structure import", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("creates the whole tree for a fresh sheet and counts every node", async () => {
    await seedProject();

    const res = await json(await importRows(sheet()));

    expect(res.data.rows).toEqual({ total: 2, imported: 2, matched: 0 });
    // group + code + description, then description + type + part code
    expect(res.data.nodesCreated).toBe(6);

    const created = await tree();
    expect(created.groups.map((g) => g.code)).toEqual(["Bridge A"]);
    expect(created.codes.map((c) => c.code)).toEqual(["TC-01"]);
    expect(created.descriptions.map((d) => d.label).sort()).toEqual(["Deck", "Rail"]);
    expect(created.types).toHaveLength(1);
    expect(created.parts).toHaveLength(1);
  });

  // The operator's second import: nothing left to create, and the pre-assigned
  // codes are already planned. Neither is a failure.
  it("matches every row on a second import and reports the planned codes as such", async () => {
    await seedProject();
    await importRows(sheet());

    const res = await json(await importRows(sheet()));

    expect(res.data.rows).toEqual({ total: 2, imported: 0, matched: 2 });
    expect(res.data.nodesCreated).toBe(0);
    expect(res.data.inspections).toEqual({ planned: 0, alreadyPlanned: 2, skipped: 0 });

    const after = await tree();
    expect(after.groups).toHaveLength(1);
    expect(after.planned).toHaveLength(2);
  });

  // The preview promises the real run's numbers, so both are read from one walk.
  it("counts a dry run without writing anything", async () => {
    await seedProject();
    const rows = [row({ type: "GVI", partCode: "P1", preAssigned: ["GVI"] })];

    const preview = await json(await importRows(rows, { dryRun: true }));

    const afterPreview = await tree();
    expect(afterPreview.groups).toHaveLength(0);
    expect(afterPreview.planned).toHaveLength(0);

    const real = await json(await importRows(rows));
    expect(preview.data).toEqual(real.data);
  });

  it("creates a task code alone when the row names no description", async () => {
    await seedProject();

    const res = await json(await importRows([row({ description: null })]));

    expect(res.data.rows).toEqual({ total: 1, imported: 1, matched: 0 });
    // group + task code, and nothing under the code
    expect(res.data.nodesCreated).toBe(2);

    const created = await tree();
    expect(created.codes).toHaveLength(1);
    expect(created.descriptions).toHaveLength(0);
  });

  it("skips pre-assigned codes when the row stops at a type", async () => {
    await seedProject();

    const res = await json(
      await importRows([row({ type: "GVI", preAssigned: ["GVI", "CVI"] })]),
    );

    expect(res.data.inspections).toEqual({ planned: 0, alreadyPlanned: 0, skipped: 2 });
    expect((await tree()).planned).toHaveLength(0);
  });

  it("skips a code outside the accepted list and plans the rest, whatever the case", async () => {
    await seedProject();

    const res = await json(
      await importRows([row({ preAssigned: ["GVI", "NOPE", "cvi"] })]),
    );

    expect(res.data.inspections).toEqual({ planned: 2, alreadyPlanned: 0, skipped: 1 });
  });

  // CAISSON is the eighth accepted code: it plans like any other, and a repeat
  // import reports it as already planned.
  it("plans CAISSON and counts a repeat as already planned", async () => {
    await seedProject();

    const rows = [row({ type: "GVI", partCode: "P1", preAssigned: ["CAISSON"] })];
    const first = await json(await importRows(rows));

    expect(first.data.inspections).toEqual({ planned: 1, alreadyPlanned: 0, skipped: 0 });
    expect((await tree()).planned.map((p) => p.inspectionTypeCode)).toEqual(["CAISSON"]);

    const second = await json(await importRows(rows));
    expect(second.data.inspections).toEqual({ planned: 0, alreadyPlanned: 1, skipped: 0 });
  });

  it("replaces the project tree and writes the new sheet", async () => {
    await seedProject();
    await importRows([row()]);

    const res = await json(
      await importRows([row({ taskGroup: "Bridge B" })], { mode: "replace" }),
    );

    expect(res.data.rows).toEqual({ total: 1, imported: 1, matched: 0 });

    const after = await tree();
    expect(after.groups.map((g) => g.code)).toEqual(["Bridge B"]);
    expect(after.descriptions.map((d) => d.label)).toEqual(["Deck"]);
  });

  // A preview must never run the real delete: that path also removes objects from
  // storage after it commits, and a rollback cannot bring those back.
  it("leaves the tree standing after a dry-run replace", async () => {
    await seedProject();
    await importRows([row()]);

    const res = await json(
      await importRows([row({ taskGroup: "Bridge B" })], {
        mode: "replace",
        dryRun: true,
      }),
    );

    expect(res.data.rows).toEqual({ total: 1, imported: 1, matched: 0 });

    const after = await tree();
    expect(after.groups.map((g) => g.code)).toEqual(["Bridge A"]);
    expect(after.descriptions.map((d) => d.label)).toEqual(["Deck"]);
  });

  it("refuses a replace while an inspection under the project is still running", async () => {
    await seedProject();
    await importRows([row()]);
    const seeded = await tree();

    await testDb.insert(schema.session).values({
      displayNumber: 1,
      sessionId: 101,
      projectId: 1,
      name: "Run 1",
    });
    await testDb.insert(schema.result).values({
      displayNumber: 5001,
      resultId: 5001,
      inspectionTypeCode: "GVI",
      descriptionId: seeded.descriptions[0]!.descriptionId,
      layer: 1,
      masterStartMs: 0,
      // open, so media is still being written under the selection
      masterEndMs: null,
      projectId: 1,
      sessionId: 101,
    });

    const res = await importRows([row({ taskGroup: "Bridge B" })], { mode: "replace" });

    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("wrong_state");

    const after = await tree();
    expect(after.groups.map((g) => g.code)).toEqual(["Bridge A"]);
    expect(after.descriptions).toHaveLength(1);
  });

  // One transaction: the first insert breaks its foreign key, so the rest of the
  // sheet must not survive it.
  it("writes nothing when the project does not exist", async () => {
    const res = await importRows([row(), row({ description: "Rail" })], {
      projectId: 999,
    });

    expect(res.status).toBe(404);
    const after = await tree();
    expect(after.groups).toHaveLength(0);
    expect(after.codes).toHaveLength(0);
  });

  it("rejects an empty sheet, an unknown mode, and a blank task code", async () => {
    await seedProject();

    expect((await importRows([])).status).toBe(400);
    expect((await importRows([row()], { mode: "merge" })).status).toBe(400);
    expect((await importRows([row({ taskCode: "" })])).status).toBe(400);
  });
});
