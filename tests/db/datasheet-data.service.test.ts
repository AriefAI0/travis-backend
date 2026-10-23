import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";
import {
  MAX_DATASHEET_RESULTS,
  countDatasheetResults,
  gatherDatasheet,
  parseDatasheetTargets,
  previewDatasheet,
} from "../../src/db/services/datasheet-data.service";

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

// project > session > group > code > description > type > part code
const seedTree = async (sessionName = "Run 1") => {
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
    name: sessionName,
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
  descriptionId?: number | null;
  partCodeId?: number | null;
  sessionId?: number | null;
  remarks?: string | null;
}) =>
  testDb.insert(schema.result).values({
    resultId: values.resultId,
    displayNumber: values.resultId % 1000,
    projectId: 1,
    sessionId: values.sessionId === undefined ? 101 : values.sessionId,
    inspectionTypeCode: values.type,
    descriptionId: values.descriptionId ?? null,
    partCodeId: values.partCodeId ?? null,
    layer: 1,
    masterStartMs: 0,
    remarks: values.remarks ?? null,
  });

const targets = (...keys: string[]) =>
  parseDatasheetTargets(keys);

describe("datasheet data", () => {
  it("renders one GVI row per result, in tree order", async () => {
    await seedTree();
    await addResult({ resultId: 5001, type: "GVI", descriptionId: 100, remarks: "looks fine" });
    await addResult({ resultId: 5002, type: "GVI", partCodeId: 300 });
    await testDb.insert(schema.resultGvi).values([
      { resultId: 5001, condition: "not_ok" },
      { resultId: 5002, depthEl: 1.25, condition: "ok" },
    ]);

    const table = await gatherDatasheet(
      1,
      "GVI",
      targets("description:100", "partCode:300"),
      testOrgId,
      testDb,
    );

    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toMatchObject({
      component_id: "Leg A",
      component_type: "",
      condition: "Visual Damage",
      remarks: "looks fine",
    });
    expect(table.rows[1]).toMatchObject({
      component_id: "P1",
      component_type: "T1",
      depth_el: "1.25",
      condition: "Good Condition",
    });
    expect(table.header).toMatchObject({ Client: "Alpha", ReportNo: "DOC-1", Session: "Run 1" });
  });

  it("gives a target with two results two rows", async () => {
    await seedTree();
    await addResult({ resultId: 5001, type: "GVI", partCodeId: 300 });
    await addResult({ resultId: 5002, type: "GVI", partCodeId: 300 });
    await testDb.insert(schema.resultGvi).values([
      { resultId: 5001, condition: "ok" },
      { resultId: 5002, condition: "ok" },
    ]);

    const table = await gatherDatasheet(1, "GVI", targets("partCode:300"), testOrgId, testDb);
    expect(table.rows.map((row) => row.component_id)).toEqual(["P1", "P1"]);
  });

  it("renders CP-MEMBER as position rows then CP finding rows, with ticks", async () => {
    await seedTree();
    await addResult({ resultId: 5003, type: "CVI", partCodeId: 300 });
    await testDb.insert(schema.resultCvi).values({ resultId: 5003, datumReference: "D-1" });
    await testDb.insert(schema.resultCviPosition).values([
      { resultId: 5003, memberType: "chord", clockPosition: "12:00", utMm: 19.8, findings: "thin", sortOrder: 0 },
      { resultId: 5003, memberType: "chord", clockPosition: "3:00", utMm: 20.1, findings: "", sortOrder: 1 },
    ]);
    await testDb.insert(schema.resultCviFinding).values({ resultId: 5003, value: -950, remark: "reading", sortOrder: 0 });

    const table = await gatherDatasheet(1, "CP_MEMBER", targets("partCode:300"), testOrgId, testDb);

    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]).toMatchObject({ component_id: "P1", wall_mm: "19.8", clock_12: "√", clock_3: "" });
    expect(table.rows[1]).toMatchObject({ wall_mm: "20.1", clock_12: "", clock_3: "√" });
    expect(table.rows[2]).toMatchObject({ cp_mv: "-950", wall_mm: "", remarks: "reading" });
  });

  it("repeats the FMD attempt word the form chose", async () => {
    await seedTree();
    await addResult({ resultId: 5004, type: "FMD", partCodeId: 300 });
    await testDb.insert(schema.resultFmd).values({
      resultId: 5004,
      depthEl: 2.5,
      initialAttempt: "dry",
      additionalAttempt1: "flooded",
      additionalAttempt2: "na",
      additionalAttempt3: "na",
    });

    const [row] = (await gatherDatasheet(1, "FMD", targets("partCode:300"), testOrgId, testDb)).rows;

    expect(row).toMatchObject({
      component_id: "P1",
      component_type: "T1",
      depth_el: "2.5",
      initial_attempt: "Dry",
      additional_attempt_1: "Flooded",
      additional_attempt_2: "N/A",
      additional_attempt_3: "N/A",
    });
  });

  it("carries the scour dims and both legs", async () => {
    await seedTree();
    await addResult({ resultId: 5005, type: "SCOUR", partCodeId: 300 });
    await testDb.insert(schema.resultScour).values({
      resultId: 5005,
      locationLeg1: "North",
      locationLeg2: "South",
      dimA: 300,
      dimB: 150,
      dimC: 250,
      expLeg1: "yes",
      expLeg2: "no",
      heightExpLeg1: 120,
    });

    const [row] = (await gatherDatasheet(1, "SCOUR", targets("partCode:300"), testOrgId, testDb)).rows;

    expect(row).toMatchObject({
      location_leg1: "North",
      location_leg2: "South",
      dim_a: "300",
      dim_b: "150",
      dim_c: "250",
      exp_leg1: "Yes",
      exp_leg2: "No",
      height_exp_leg1: "120",
    });
  });

  it("counts every card from one read", async () => {
    await seedTree();
    await addResult({ resultId: 5001, type: "GVI", partCodeId: 300 });
    await addResult({ resultId: 5002, type: "GVI", partCodeId: 300 });
    await addResult({ resultId: 5003, type: "CP", partCodeId: 300 });

    const counts = await countDatasheetResults(1, targets("partCode:300"), testOrgId, testDb);

    expect(counts).toMatchObject({ GVI: 2, CP_ANODE: 1, CP_MEMBER: 0, FMD: 0, SCOUR: 0, DVI: 0 });
  });

  it("leaves the session blank when the results span two sessions", async () => {
    await seedTree();
    await testDb.insert(schema.session).values({
      sessionId: 102,
      projectId: 1,
      displayNumber: 2,
      name: "Run 2",
    });
    await addResult({ resultId: 5001, type: "GVI", partCodeId: 300 });
    await addResult({ resultId: 5002, type: "GVI", partCodeId: 300, sessionId: 102 });
    await testDb.insert(schema.resultGvi).values([
      { resultId: 5001, condition: "ok" },
      { resultId: 5002, condition: "ok" },
    ]);

    const table = await gatherDatasheet(1, "GVI", targets("partCode:300"), testOrgId, testDb);
    expect(table.header.Session).toBe("");
  });

  it("cuts a preview to ten rows", async () => {
    await seedTree();
    await addResult({ resultId: 5001, type: "SCOUR", partCodeId: 300 });
    await testDb.insert(schema.resultScour).values({
      resultId: 5001,
      locationLeg1: "North",
      locationLeg2: "South",
      dimA: 1,
    });

    const table = await previewDatasheet(1, "SCOUR", targets("partCode:300"), testOrgId, testDb, 10);
    expect(table.rows).toHaveLength(1);
    expect(table.columns).toContain("dim_a");
  });

  it("refuses a selection above the result cap", async () => {
    await seedTree();
    await testDb.insert(schema.result).values(
      Array.from({ length: MAX_DATASHEET_RESULTS + 1 }, (_, i) => ({
        resultId: 7000 + i,
        displayNumber: i + 1,
        projectId: 1,
        sessionId: 101,
        inspectionTypeCode: "GVI" as const,
        partCodeId: 300,
        layer: 1,
        masterStartMs: 0,
      })),
    );

    await expect(gatherDatasheet(1, "GVI", targets("partCode:300"), testOrgId, testDb)).rejects.toMatchObject({
      code: "too_many_results",
    });
  });

  it("rejects a target key that names no kind", () => {
    expect(() => parseDatasheetTargets(["part_code:300"])).toThrow(/description:<id>/);
  });
});
