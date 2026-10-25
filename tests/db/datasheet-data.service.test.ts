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

  it("renders CP-MEMBER from GVI, splitting the two reading methods", async () => {
    await seedTree();
    await addResult({ resultId: 5003, type: "GVI", partCodeId: 300 });
    await addResult({ resultId: 5004, type: "GVI", partCodeId: 300 });
    await testDb.insert(schema.resultGvi).values([
      { resultId: 5003, depthEl: 12.4, condition: "ok" },
      { resultId: 5004, depthEl: 13.1, condition: "ok" },
    ]);
    // 5003 carries the method; 5004 is a pre-split row, so order decides
    await testDb.insert(schema.resultGviFinding).values([
      { resultGviId: 5003, value: -950, remark: "contact ok", cpMethod: "contact", sortOrder: 0 },
      { resultGviId: 5003, value: -921, remark: "proximity ok", cpMethod: "proximity", sortOrder: 1 },
      { resultGviId: 5004, value: -880, remark: "first", sortOrder: 0 },
      { resultGviId: 5004, value: -870, remark: "second", sortOrder: 1 },
    ]);

    const table = await gatherDatasheet(1, "CP_MEMBER", targets("partCode:300"), testOrgId, testDb);

    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toMatchObject({
      component_id: "P1",
      cp_contact: "-950",
      cp_proximity: "-921",
      depth_el: "12.4",
      remarks: "contact ok; proximity ok",
    });
    expect(table.rows[1]).toMatchObject({ cp_contact: "-880", cp_proximity: "-870" });
  });

  it("renders UT as one row per CVI clock reading", async () => {
    await seedTree();
    await addResult({ resultId: 5005, type: "CVI", partCodeId: 300 });
    await testDb.insert(schema.resultCvi).values({ resultId: 5005, nominalWallMm: 22.5 });
    await testDb.insert(schema.resultCviPosition).values([
      { resultId: 5005, memberType: "chord", clockPosition: "12", utMm: 20.1, findings: "coating intact", sortOrder: 0 },
      { resultId: 5005, memberType: "chord", clockPosition: "3", utMm: 19.8, findings: "", sortOrder: 1 },
      { resultId: 5005, memberType: "chord", clockPosition: "6", utMm: null, findings: "", sortOrder: 2 },
    ]);

    const table = await gatherDatasheet(1, "UT", targets("partCode:300"), testOrgId, testDb);

    // a point with no reading and no remark makes no row
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toMatchObject({
      component_id: "P1",
      wall_mm: "22.5",
      clock_12: "20.1",
      clock_3: "",
      remarks: "coating intact",
    });
    expect(table.rows[1]).toMatchObject({ clock_3: "19.8", clock_12: "" });
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

    expect(counts).toMatchObject({
      GVI: 2,
      CP_ANODE: 1,
      // CP_MEMBER reads the same GVI results; UT reads CVI
      CP_MEMBER: 2,
      FMD: 0,
      SCOUR: 0,
      DVI: 0,
      UT: 0,
    });
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

    await addResult({ resultId: 5001, type: "GVI", partCodeId: 300 });
    await testDb.insert(schema.result).values({
      resultId: 6001,
      displayNumber: 1,
      projectId: 2,
      sessionId: 201,
      inspectionTypeCode: "GVI",
      partCodeId: 310,
      layer: 1,
      masterStartMs: 0,
      remarks: "other org",
    });
    await testDb.insert(schema.resultGvi).values([
      { resultId: 5001, condition: "ok" },
      { resultId: 6001, condition: "not_ok" },
    ]);

    // project 1, asked for its own target plus the other org's
    const picked = targets("partCode:300", "partCode:310");
    const table = await gatherDatasheet(1, "GVI", picked, testOrgId, testDb);
    const counts = await countDatasheetResults(1, picked, testOrgId, testDb);

    expect(table.rows.map((row) => row.component_id)).toEqual(["P1"]);
    expect(counts.GVI).toBe(1);
  });

  it("rejects a target key that names no kind", () => {
    expect(() => parseDatasheetTargets(["part_code:300"])).toThrow(/description:<id>/);
  });
});
