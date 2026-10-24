import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";
import {
  MAX_EXCEL_RESULTS,
  gatherExcelExport,
  previewExcelExport,
} from "../../src/db/services/excel-export-data.service";
import { parseDatasheetTargets } from "../../src/db/services/datasheet-data.service";

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

// project > session > group > code > description > type > part code
const seedTree = async () => {
  await testDb.insert(schema.project).values({
    organizationId: testOrgId,
    projectId: 1,
    displayNumber: 1,
    title: "Alpha",
    documentId: "DOC-1",
  });
  await testDb.insert(schema.session).values({
    sessionId: 101,
    projectId: 1,
    displayNumber: 1,
    name: "Run 1",
  });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 1, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 10, taskGroupId: 1, code: "101" });
  await testDb.insert(schema.description).values({ descriptionId: 100, taskCodeId: 10, label: "Leg A" });
  await testDb.insert(schema.type).values({ typeId: 200, descriptionId: 100, code: "T1" });
  await testDb.insert(schema.partCode).values({ partCodeId: 300, typeId: 200, code: "P1" });
};

// One result row; the detail table goes in per type.
const addResult = async (values: {
  resultId: number;
  type: (typeof schema.result.$inferInsert)["inspectionTypeCode"];
  partCodeId?: number | null;
  inspectionFormId?: number | null;
  customValues?: Record<string, unknown>;
  resultClass?: "normal" | "anomaly";
}) =>
  testDb.insert(schema.result).values({
    resultId: values.resultId,
    displayNumber: values.resultId % 1000,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: values.type,
    partCodeId: values.partCodeId ?? 300,
    layer: 1,
    masterStartMs: 0,
    inspectionFormId: values.inspectionFormId ?? null,
    customValues: values.customValues ?? null,
    resultClass: values.resultClass ?? "normal",
  });

const targets = (...keys: string[]) => parseDatasheetTargets(keys);

describe("excel export data", () => {
  it("drops results a target from another org points at", async () => {
    await seedTree();
    // the org table outlives a truncate, so the seed is idempotent
    await testDb.insert(schema.organization).values({ name: "other" }).onConflictDoNothing();
    const [other] = await testDb
      .select({ organizationId: schema.organization.organizationId })
      .from(schema.organization)
      .where(eq(schema.organization.name, "other"));
    await testDb.insert(schema.project).values({
      organizationId: other!.organizationId,
      projectId: 2,
      displayNumber: 1,
      title: "Beta",
    });
    await testDb.insert(schema.session).values({ sessionId: 201, projectId: 2, displayNumber: 1, name: "Run B" });
    await testDb.insert(schema.taskGroup).values({ taskGroupId: 2, projectId: 2, code: "900" });
    await testDb.insert(schema.taskCode).values({ taskCodeId: 20, taskGroupId: 2, code: "901" });
    await testDb.insert(schema.description).values({ descriptionId: 110, taskCodeId: 20, label: "Leg Z" });
    await testDb.insert(schema.type).values({ typeId: 210, descriptionId: 110, code: "TZ" });
    await testDb.insert(schema.partCode).values({ partCodeId: 310, typeId: 210, code: "PZ" });

    await addResult({ resultId: 5001, type: "GVI" });
    await testDb.insert(schema.result).values({
      resultId: 6001,
      displayNumber: 1,
      projectId: 2,
      sessionId: 201,
      inspectionTypeCode: "GVI",
      partCodeId: 310,
      layer: 1,
      masterStartMs: 0,
    });
    await testDb.insert(schema.resultGvi).values([
      { resultId: 5001, condition: "ok" },
      { resultId: 6001, condition: "not_ok" },
    ]);

    const data = await gatherExcelExport(
      1,
      ["GVI"],
      targets("partCode:300", "partCode:310"),
      testOrgId,
      testDb,
    );

    expect(data.sheets[0]!.rows.map((row) => row.cells.result_id)).toEqual([5001]);
  });

  it("writes numbers as numbers and recorded as a date", async () => {
    await seedTree();
    await addResult({ resultId: 5001, type: "GVI" });
    await testDb.insert(schema.resultGvi).values({ resultId: 5001, depthEl: 2.5, condition: "ok" });

    const [row] = (await gatherExcelExport(1, ["GVI"], targets("partCode:300"), testOrgId, testDb)).sheets[0]!
      .rows;

    expect(row!.cells).toMatchObject({
      result_id: 5001,
      session: "Run 1",
      task_code: "101",
      part_code: "P1",
      condition: "Good Condition",
      depth_el: 2.5,
    });
    expect(typeof row!.cells.depth_el).toBe("number");
    expect(row!.cells.recorded).toBeInstanceOf(Date);
  });

  it("flattens a child list to one row per reading", async () => {
    await seedTree();
    await addResult({ resultId: 5003, type: "CVI" });
    await testDb.insert(schema.resultCvi).values({ resultId: 5003, datumReference: "D-1" });
    await testDb.insert(schema.resultCviPosition).values([
      { resultId: 5003, memberType: "chord", clockPosition: "12:00", utMm: 19.8, findings: "thin", sortOrder: 0 },
      { resultId: 5003, memberType: "chord", clockPosition: "3:00", utMm: 20.1, findings: "", sortOrder: 1 },
    ]);
    await testDb.insert(schema.resultCviFinding).values({ resultId: 5003, value: -950, remark: "reading", sortOrder: 0 });

    const [sheet] = (await gatherExcelExport(1, ["CVI"], targets("partCode:300"), testOrgId, testDb)).sheets;

    expect("children" in sheet!).toBe(false);
    expect(sheet!.rows).toHaveLength(2);
    expect(sheet!.rows[0]!.cells).toMatchObject({
      result_id: 5003,
      datum_reference: "D-1",
      member_type: "CHORD",
      clock_position: "12:00",
      ut_mm: 19.8,
      cp_potential_mv: -950,
      remark: "reading",
    });
    expect(typeof sheet!.rows[0]!.cells.ut_mm).toBe("number");
    // the second position pairs with no CP reading, so its CP cell is blank
    expect(sheet!.rows[1]!.cells.clock_position).toBe("3:00");
    expect(sheet!.rows[1]!.cells.cp_potential_mv ?? null).toBeNull();
  });

  it("ships three positions against two CP readings as three rows", async () => {
    await seedTree();
    await addResult({ resultId: 5003, type: "CVI" });
    await testDb.insert(schema.resultCvi).values({ resultId: 5003 });
    await testDb.insert(schema.resultCviPosition).values(
      ["12:00", "3:00", "6:00"].map((clockPosition, sortOrder) => ({
        resultId: 5003,
        memberType: "brace" as const,
        clockPosition,
        sortOrder,
      })),
    );
    await testDb.insert(schema.resultCviFinding).values([
      { resultId: 5003, value: -900, remark: "one", sortOrder: 0 },
      { resultId: 5003, value: -910, remark: "two", sortOrder: 1 },
    ]);

    const [sheet] = (await gatherExcelExport(1, ["CVI"], targets("partCode:300"), testOrgId, testDb)).sheets;

    expect(sheet!.rows).toHaveLength(3);
    expect(sheet!.rows.map((row) => row.cells.cp_potential_mv ?? null)).toEqual([-900, -910, null]);
    expect(sheet!.rows[2]!.cells.remark ?? "").toBe("");
  });

  it("ships one row for a result with no readings", async () => {
    await seedTree();
    await addResult({ resultId: 5005, type: "MGI" });
    await testDb.insert(schema.resultMgi).values({ resultId: 5005 });

    const [sheet] = (await gatherExcelExport(1, ["MGI"], targets("partCode:300"), testOrgId, testDb)).sheets;

    expect(sheet!.rows).toHaveLength(1);
    expect(sheet!.rows[0]!.cells).toMatchObject({ result_id: 5005, no_mg_observed: "No" });
    // no readings, so every reading cell stays blank
    expect(sheet!.rows[0]!.cells.growth_type ?? "").toBe("");
  });

  it("puts the reading's own time in the Timestamp cell", async () => {
    await seedTree();
    const parentAt = new Date("2026-10-19T09:41:00.000Z");
    const readingAt = new Date("2026-10-19T10:04:00.000Z");
    await testDb.insert(schema.result).values({
      resultId: 5006,
      displayNumber: 6,
      projectId: 1,
      sessionId: 101,
      inspectionTypeCode: "DVI",
      partCodeId: 300,
      layer: 1,
      masterStartMs: 0,
      createdAt: parentAt,
    });
    await testDb.insert(schema.resultDvi).values({ resultId: 5006, memberType: "chord" });
    await testDb.insert(schema.resultDviPosition).values({
      resultId: 5006,
      clockPosition: "12:00",
      sortOrder: 0,
      createdAt: readingAt,
    });

    const [sheet] = (await gatherExcelExport(1, ["DVI"], targets("partCode:300"), testOrgId, testDb)).sheets;

    expect(sheet!.rows[0]!.cells.recorded).toEqual(readingAt);
  });

  it("leads with seven identity columns", async () => {
    await seedTree();
    await addResult({ resultId: 5001, type: "GVI" });

    const [sheet] = (await gatherExcelExport(1, ["GVI"], targets("partCode:300"), testOrgId, testDb)).sheets;

    expect(sheet!.columns.slice(0, 7).map((column) => column.label)).toEqual([
      "Result ID",
      "Session",
      "Task code",
      "Description",
      "Part code",
      "Class",
      "Timestamp (UTC)",
    ]);
  });

  it("merges custom values by their form label", async () => {
    await seedTree();
    const [form] = await testDb
      .insert(schema.inspectionForm)
      .values({ projectId: 1, inspectionTypeCode: "GVI", version: 1 })
      .returning();
    const [field] = await testDb
      .insert(schema.inspectionFormField)
      .values({ inspectionFormId: form!.inspectionFormId, label: "Weld number", dataType: "text" })
      .returning();
    await addResult({
      resultId: 5001,
      type: "GVI",
      inspectionFormId: form!.inspectionFormId,
      customValues: { [String(field!.inspectionFormFieldId)]: "W-7" },
    });
    await testDb.insert(schema.resultGvi).values({ resultId: 5001, condition: "ok" });

    const [sheet] = (await gatherExcelExport(1, ["GVI"], targets("partCode:300"), testOrgId, testDb)).sheets;

    expect(sheet!.columns.at(-1)).toMatchObject({ label: "Weld number", type: "text" });
    expect(sheet!.rows[0]!.cells[sheet!.columns.at(-1)!.key]).toBe("W-7");
  });

  it("counts the cap on ticked types only and names exports", async () => {
    await seedTree();
    // 501 rows of an unticked type: the export of GVI does not see them
    await testDb.insert(schema.result).values(
      Array.from({ length: MAX_EXCEL_RESULTS + 1 }, (_, i) => ({
        resultId: 7000 + i,
        displayNumber: i + 1,
        projectId: 1,
        sessionId: 101,
        inspectionTypeCode: "CVI" as const,
        partCodeId: 300,
        layer: 1,
        masterStartMs: 0,
      })),
    );

    const data = await gatherExcelExport(1, ["GVI"], targets("partCode:300"), testOrgId, testDb);
    expect(data.sheets).toHaveLength(1);
    expect(data.sheets[0]!.rows).toHaveLength(0);

    // ticked, so the cap answers
    await expect(
      gatherExcelExport(1, ["CVI"], targets("partCode:300"), testOrgId, testDb),
    ).rejects.toMatchObject({ code: "too_many_results" });
  });

  it("never exports an RA row", async () => {
    await seedTree();
    await testDb.insert(schema.result).values({
      resultId: 5009,
      displayNumber: 9,
      projectId: 1,
      sessionId: null,
      isRa: true,
      inspectionTypeCode: "RA",
      descriptionId: 100,
      layer: 1,
      masterStartMs: 0,
    });

    const data = await gatherExcelExport(1, ["GVI"], targets("description:100"), testOrgId, testDb);
    expect(data.sheets[0]!.rows).toHaveLength(0);
  });

  it("stops a preview at ten rows per type", async () => {
    await seedTree();
    await testDb.insert(schema.result).values(
      Array.from({ length: 12 }, (_, i) => ({
        resultId: 8000 + i,
        displayNumber: i + 1,
        projectId: 1,
        sessionId: 101,
        inspectionTypeCode: "FMD" as const,
        partCodeId: 300,
        layer: 1,
        masterStartMs: 0,
      })),
    );

    const data = await previewExcelExport(1, ["FMD"], targets("partCode:300"), testOrgId, testDb);
    expect(data.sheets[0]!.rows).toHaveLength(10);
  });

  it("covers all thirteen types", async () => {
    const { EXCEL_CONTRACT } = await import("../../src/db/services/excel-export-data.service");
    expect(EXCEL_CONTRACT.map((entry) => entry.type)).toHaveLength(13);
    for (const entry of EXCEL_CONTRACT) {
      expect(entry.sheet.length).toBeLessThanOrEqual(31);
    }
  });
});
