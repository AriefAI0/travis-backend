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
  EXCEL_CONTRACT,
  IDENTITY_COLUMNS,
  MAX_EXCEL_RESULTS,
  gatherExcelExport,
  previewExcelExport,
  sheetColumnsFor,
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
  remarks?: string | null;
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
    remarks: values.remarks ?? null,
  });

// A pipeline finding: the schema makes every category field not-null.
const pipelineFinding = (resultId: number, overrides: Partial<typeof schema.resultPipelineFinding.$inferInsert> = {}) =>
  ({
    resultId,
    damageDimensions: "",
    debrisDescription: "",
    stabilizationType: "",
    burialStart: "",
    burialEnd: "",
    freespansStart: "",
    freespansEnd: "",
    freespansLength: "",
    freespansHeight: "",
    leakType: "",
    leakDescription: "",
    crossingGapDistance: "",
    crossingDamageMovement: "",
    featuresType: "",
    anodeCpValue: "",
    anodeDepletion: "",
    anodeKp: "",
    remarks: "",
    ...overrides,
  }) as typeof schema.resultPipelineFinding.$inferInsert;

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
      member_type: "Chord",
      clock_position: "12:00",
      ut_mm: 19.8,
      cp_potential_mv: -950,
      cp_remark: "reading",
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
    expect(sheet!.rows[2]!.cells.cp_remark ?? "").toBe("");
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
    expect(EXCEL_CONTRACT.map((entry) => entry.type)).toHaveLength(13);
    for (const entry of EXCEL_CONTRACT) {
      expect(entry.sheet.length).toBeLessThanOrEqual(31);
    }

    // every type answers as one flat sheet, whether or not it has rows
    await seedTree();
    const allTypes = EXCEL_CONTRACT.map((entry) => entry.type);
    const data = await gatherExcelExport(1, allTypes, targets("partCode:300"), testOrgId, testDb);
    expect(data.sheets.map((sheet) => sheet.type)).toEqual(allTypes);
    for (const sheet of data.sheets) {
      expect("children" in sheet).toBe(false);
    }
  });
});

// The panel's own wording, read from the app tools.
const PANEL_LABELS: Record<string, string[]> = {
  GVI: [
    "Depth EL (-)",
    "Contact - CP Reading (mV)",
    "Proximity - CP Reading (mV)",
    "CP Remarks",
    "MGI Depth",
    "MGI Soft Coverage",
    "MGI Hard Coverage",
    "MGI Remarks",
    "Condition",
    "Remark",
  ],
  CVI: [
    "Datum Reference",
    "Member",
    "Clock position",
    "UT Value (mm)",
    "Remarks",
    "CP Value (mV)",
    "CP Remarks",
    "Remark",
  ],
  DVI: [
    "Datum Reference",
    "Member Type",
    "Clock position",
    "UT Value (mm)",
    "Findings",
    "CP Potential (mV)",
    "Remark",
  ],
  MGI: [
    "No MG observed",
    "Criteria preset",
    "Growth",
    "Species",
    "Other species detail",
    "Coverage %",
    "Thickness mm",
    "Finding remarks",
  ],
  CP: [
    "Anode Type",
    "CP potential (mV)",
    "Depletion (%)",
    "Width",
    "Height",
    "Length",
    "Widest",
    "Deepest",
    "Remark",
  ],
  FMD: [
    "Depth EL (-)",
    "Initial Attempt",
    "Additional Attempt 1",
    "Additional Attempt 2",
    "Additional Attempt 3",
    "Remark",
  ],
  SCOUR: [
    "Leg 1",
    "Leg 2",
    "DIM A",
    "DIM B",
    "DIM C",
    "Leg 1 pile exposed",
    "Leg 2 pile exposed",
    "Leg 1 exposed height",
    "Leg 2 exposed height",
    "Remark",
  ],
  BSI: [
    "Clamp Type",
    "Depth EL (-)",
    "Clamp Bolts & Nuts Quantity",
    "Clamp Missing Bolts",
    "Clamp Missing Washer",
    "Outboard Clamp CP",
    "CP Anomaly Recommendation",
    "Hinge Pin",
    "Hinge Bolts & Nuts Quantity",
    "Hinge Missing Bolts",
    "Hinge Missing Washer",
    "Liners",
    "In-board Gap Condition",
    "In-board Estimate Gap",
    "In-board Alignment Condition",
    "In-board Misaligned Position",
    "In-board Anomaly Recommendation",
    "Out-board Gap Condition",
    "Out-board Estimate Gap",
    "Out-board Alignment Condition",
    "Out-board Misaligned Position",
    "Out-board Anomaly Recommendation",
  ],
  CGB: ["Movement", "Movement Remark", "Debris", "Debris Type", "Remark"],
  RISER: [
    "Touchdown - Distance from Riser Bend",
    "Riser Bend - Distance to Mudbrace Member",
    "Riser Bend - Height to Seabed",
    "Coating",
    "Coating Condition",
    "Knee Brace",
    "Debris",
    "Debris Type",
    "Anomaly",
    "Recommendation",
    "Restricted Access",
    "Remark",
  ],
  CAISSON: [
    "Caisson Body GVI",
    "Damage Recommendation",
    "Debris Present",
    "Debris Recommendation",
    "Grating Present",
    "Grating Blockage",
    "Grating Recommendation",
    "CP Value (mV)",
    "CP Remarks",
    "Associated pipes",
    "Associated pipes note",
    "Remark",
  ],
  SEABED: ["Range (m)", "Fixes", "Debris", "Debris Type", "Remark"],
  // PIPELINE ships every finding column.
  PIPELINE: [
    "Location",
    "Depth EL (-)",
    "Orientation",
    "Category",
    "Damage Type",
    "Estimated Dimension",
    "Debris Type",
    "Debris Description",
    "Riser Bend Condition",
    "Stabilization Type",
    "Stabilization Condition",
    "Burial Start",
    "Burial End",
    "Freespans Start",
    "Freespans End",
    "Approximate Length",
    "Maximum Height",
    "Leak Type",
    "Leak Description",
    "Crossing Type",
    "Contact",
    "Gap Distance",
    "Damage / Movement",
    "Feature Type",
    "Condition",
    "CP Value (mV)",
    "Depletion (%)",
    "KP",
    "Remarks",
  ],
};

describe("panel labels and text", () => {
  it("names every column as the panel does", () => {
    expect(IDENTITY_COLUMNS.map((column) => column.label)).toEqual([
      "Result ID",
      "Session",
      "Task code",
      "Description",
      "Part code",
      "Class",
      "Timestamp (UTC)",
    ]);

    for (const contract of EXCEL_CONTRACT) {
      const labels = sheetColumnsFor(contract)
        .map((column) => column.label)
        .slice(IDENTITY_COLUMNS.length);
      expect({ type: contract.type, labels }).toEqual({
        type: contract.type,
        labels: PANEL_LABELS[contract.type] ?? [],
      });
    }
  });

  it("splits the GVI probes into two columns", async () => {
    await seedTree();
    await addResult({ resultId: 5001, type: "GVI" });
    await testDb.insert(schema.resultGvi).values({ resultId: 5001, depthEl: 84.2, condition: "ok" });
    await testDb.insert(schema.resultGviFinding).values([
      { resultGviId: 5001, value: -942, remark: "shared note", cpMethod: "contact", sortOrder: 0 },
      { resultGviId: 5001, value: -8, cpMethod: "proximity", sortOrder: 1 },
    ]);

    const [row] = (await gatherExcelExport(1, ["GVI"], targets("partCode:300"), testOrgId, testDb)).sheets[0]!
      .rows;

    expect(row!.cells).toMatchObject({
      gvi_contact: -942,
      gvi_proximity: -8,
      gvi_cp_remark: "shared note",
      condition: "Good Condition",
      depth_el: 84.2,
    });
  });

  it("maps a legacy GVI pair by order", async () => {
    await seedTree();
    await addResult({ resultId: 5002, type: "GVI" });
    await testDb.insert(schema.resultGvi).values({ resultId: 5002, condition: "not_ok" });
    await testDb.insert(schema.resultGviFinding).values([
      { resultGviId: 5002, value: -900, sortOrder: 0 },
      { resultGviId: 5002, value: -12, sortOrder: 1 },
    ]);

    const [row] = (await gatherExcelExport(1, ["GVI"], targets("partCode:300"), testOrgId, testDb)).sheets[0]!
      .rows;

    expect(row!.cells).toMatchObject({ gvi_contact: -900, gvi_proximity: -12, condition: "Visual Damage" });
  });

  it("renders BSI flags and positions as the panel words them", async () => {
    await seedTree();
    await addResult({ resultId: 5007, type: "BSI" });
    await testDb.insert(schema.resultBsi).values({
      resultId: 5007,
      hingePin: true,
      liners: false,
      inboardGapCondition: "gap",
      inboardAlignmentCondition: "misaligned",
      inboardMisalignedPosition: "mid",
      outboardGapCondition: "no_gap",
      outboardAlignmentCondition: "aligned",
    });

    const [row] = (await gatherExcelExport(1, ["BSI"], targets("partCode:300"), testOrgId, testDb)).sheets[0]!
      .rows;

    expect(row!.cells).toMatchObject({
      hinge_pin: "Present",
      liners: "Missing",
      inboard_gap_condition: "Gap",
      inboard_alignment_condition: "Misaligned",
      inboard_misaligned_position: "Mid-Section",
      outboard_gap_condition: "No Gap",
      outboard_alignment_condition: "Aligned",
    });
  });

  it("renders RISER coating as the panel words it", async () => {
    await seedTree();
    await addResult({ resultId: 5008, type: "RISER" });
    await testDb.insert(schema.resultRiser).values({
      resultId: 5008,
      coatingStatus: "not-present",
      coatingCondition: "peel-off",
      debrisType: "",
      recommendation: "",
    });

    const [row] = (await gatherExcelExport(1, ["RISER"], targets("partCode:300"), testOrgId, testDb)).sheets[0]!
      .rows;

    expect(row!.cells).toMatchObject({ coating_status: "Not Present", coating_condition: "Coating Peel Off" });
  });

  it("ships one CAISSON row per CP reading", async () => {
    await seedTree();
    await addResult({ resultId: 5010, type: "CAISSON" });
    await testDb.insert(schema.resultCi).values({
      resultId: 5010,
      visualDamage: false,
      visualDamageRecommendation: "",
      debrisPresent: true,
      debrisRecommendation: "recover",
      gratingPresent: true,
      gratingBlockage: "25_50",
      gratingAnomalyRecommendation: "clean",
    });
    await testDb.insert(schema.resultCiCpFinding).values([
      { resultId: 5010, cpMv: "-980", remarks: "" },
      { resultId: 5010, cpMv: "-1020", remarks: "near anode" },
    ]);

    const [sheet] = (await gatherExcelExport(1, ["CAISSON"], targets("partCode:300"), testOrgId, testDb)).sheets;

    expect(sheet!.rows).toHaveLength(2);
    expect(sheet!.rows.map((row) => row.cells.cp_mv)).toEqual([-980, -1020]);
    expect(sheet!.rows[1]!.cells.cp_remark).toBe("near anode");
    // the body cells repeat on every reading row
    expect(sheet!.rows[1]!.cells).toMatchObject({ visual_damage: "Good Condition", grating_blockage: "25-50%" });
  });

  it("ships the panel Remark last on the tools that carry it", async () => {
    await seedTree();
    await addResult({ resultId: 5011, type: "CVI", remarks: "check next dive" });
    await testDb.insert(schema.resultCvi).values({ resultId: 5011 });

    const [sheet] = (await gatherExcelExport(1, ["CVI"], targets("partCode:300"), testOrgId, testDb)).sheets;

    expect(sheet!.columns.at(-1)).toMatchObject({ key: "remark", label: "Remark" });
    expect(sheet!.rows[0]!.cells.remark).toBe("check next dive");
  });

  it("keeps no Remark column on MGI", async () => {
    await seedTree();
    await addResult({ resultId: 5012, type: "MGI" });
    await testDb.insert(schema.resultMgi).values({ resultId: 5012 });
    await testDb.insert(schema.resultMgiFinding).values({
      resultMgiId: 5012,
      growthType: "soft",
      species: "Other",
      speciesOtherText: "plumose anemone",
      coveragePercent: 35,
      sortOrder: 0,
    });

    const [sheet] = (await gatherExcelExport(1, ["MGI"], targets("partCode:300"), testOrgId, testDb)).sheets;

    expect(sheet!.columns.some((column) => column.key === "remark")).toBe(false);
    expect(sheet!.rows[0]!.cells).toMatchObject({
      growth_type: "Soft",
      species_other_text: "plumose anemone",
      coverage_percent: 35,
    });
  });

  it("ships every pipeline finding column under panel text", async () => {
    await seedTree();
    await addResult({ resultId: 5020, type: "PIPELINE" });
    await testDb.insert(schema.resultPipeline).values({
      resultId: 5020,
      location: "KP 0.150",
      depthEl: "-62",
      orientation: "12_oclock",
    });
    await testDb.insert(schema.resultPipelineFinding).values([
      pipelineFinding(5020, { category: "damage", damageType: "bare_metal", damageDimensions: "200x80 mm" }),
      pipelineFinding(5020, {
        category: "freespans",
        freespansStart: "KP 0.181",
        freespansEnd: "KP 0.184",
        freespansLength: "3.0 m",
        freespansHeight: "0.4 m",
      }),
      pipelineFinding(5020, {
        category: "anode",
        anodeCpValue: "-1010",
        anodeDepletion: "20",
        anodeKp: "KP 0.152",
      }),
      pipelineFinding(5020, { category: "Crossings", crossingType: "over", crossingContact: "not_touching" }),
    ]);

    const [sheet] = (await gatherExcelExport(1, ["PIPELINE"], targets("partCode:300"), testOrgId, testDb)).sheets;

    expect(sheet!.rows).toHaveLength(4);
    expect(sheet!.rows[0]!.cells).toMatchObject({
      location: "KP 0.150",
      depth_el: -62,
      orientation: "12 O'Clock",
      pipeline_category: "Damage",
      pipeline_damage: "Bare Metal Exposed",
      damage_dimensions: "200x80 mm",
    });
    expect(sheet!.rows[0]!.cells.crossing_type ?? "").toBe("");
    expect(sheet!.rows[1]!.cells).toMatchObject({
      pipeline_category: "Freespans",
      freespans_start: "KP 0.181",
      freespans_length: "3.0 m",
    });
    // a numeric anode reading stays a number
    expect(sheet!.rows[2]!.cells).toMatchObject({ pipeline_category: "Anode", anode_cp_value: -1010 });
    expect(typeof sheet!.rows[2]!.cells.anode_cp_value).toBe("number");
    expect(sheet!.rows[3]!.cells).toMatchObject({
      pipeline_category: "Crossing",
      crossing_type: "Over",
      crossing_contact: "Not Touching",
    });
  });
});
