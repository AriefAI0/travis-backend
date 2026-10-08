import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../helpers/db";
import { gatherReportData, NO_IMAGE } from "../../src/db/services/report.service";
import * as schema from "../../src/db/schema";

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

// full chain: project > session > group > code > description > type > part code
const seed = async () => {
  await testDb.insert(schema.project).values({
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
  await testDb.insert(schema.description).values({
    descriptionId: 100,
    taskCodeId: 10,
    label: "Leg A",
  });
  await testDb.insert(schema.type).values({ typeId: 200, descriptionId: 100, code: "T1" });
  await testDb.insert(schema.partCode).values({ partCodeId: 300, typeId: 200, code: "P1" });

  // three types on one description target, plus a GVI on the part-code target
  await testDb.insert(schema.result).values({
    resultId: 5001,
    displayNumber: 1,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "GVI",
    partCodeId: 300,
    layer: 1,
    masterStartMs: 0,
  });
  await testDb.insert(schema.result).values({
    resultId: 5002,
    displayNumber: 2,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "GVI",
    descriptionId: 100,
    layer: 1,
    masterStartMs: 1000,
    remarks: "looks fine",
  });
  await testDb.insert(schema.result).values({
    resultId: 5003,
    displayNumber: 3,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "CVI",
    descriptionId: 100,
    layer: 1,
    masterStartMs: 2000,
  });
  // a type with no detail table: renders an empty section, never throws
  await testDb.insert(schema.result).values({
    resultId: 5004,
    displayNumber: 4,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "RA",
    descriptionId: 100,
    layer: 1,
    masterStartMs: 3000,
  });

  await testDb.insert(schema.resultGvi).values([
    { resultId: 5001, kpRange: "KP-1", condition: "not_ok" },
    { resultId: 5002, kpRange: "KP-2", depthEl: 1.25, gviCP: -900, gviUT: 12, condition: "ok" },
  ]);
  await testDb.insert(schema.resultCvi).values({
    resultId: 5003,
    datumReference: "D-1",
    memberType: "chord",
    cpPotentialMv: -850,
  });
  await testDb.insert(schema.resultCviPosition).values([
    { resultId: 5003, clockPosition: "12:00", utMm: 9.5, findings: "pitting", sortOrder: 0 },
    { resultId: 5003, clockPosition: "6:00", utMm: 8.1, findings: null, sortOrder: 1 },
  ]);

  await testDb.insert(schema.resultImage).values({
    imageId: 9001,
    resultId: 5002,
    storageStem: "1-alpha/session-1/evidence-img",
    contentType: "image/png",
    hasAnnotated: false,
  });
};

describe("gatherReportData", () => {
  it("fills project vars and groups items in task-tree order", async () => {
    await seed();

    const data = await gatherReportData(1, testDb);

    expect(data.project_title).toBe("Alpha");
    expect(data.project_id).toBe(1);
    expect(data.document_id).toBe("DOC-1");
    expect(data.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.items).toHaveLength(2);

    // description target first, even though its result ids are the higher ones
    const [description, partCode] = data.items;
    expect(description.description).toBe("Leg A");
    expect(description.task_group).toBe("100");
    expect(description.task_code).toBe("101");
    expect(description.type_code).toBe("");
    expect(description.part_code).toBe("");
    expect(description.sections.map((section) => section.inspection_type)).toEqual([
      "GVI",
      "CVI",
      "RA",
    ]);

    expect(partCode.part_code).toBe("P1");
    expect(partCode.type_code).toBe("T1");
    expect(partCode.description).toBe("");
    expect(partCode.sections.map((section) => section.inspection_type)).toEqual(["GVI"]);
  });

  it("carries the typed GVI columns and sets only the matching flag", async () => {
    await seed();

    const [description] = (await gatherReportData(1, testDb)).items;
    const gvi = description.sections[0];

    expect(gvi.isGVI).toBe(true);
    expect(gvi.isCVI).toBe(false);
    expect(gvi.isBSI).toBe(false);
    expect(gvi.rows).toHaveLength(1);
    expect(gvi.rows[0].kp_range).toBe("KP-2");
    expect(gvi.rows[0].depth_el).toBe("1.25");
    expect(gvi.rows[0].gvi_cp).toBe("-900");
    expect(gvi.rows[0].gvi_ut).toBe("12");
    expect(gvi.rows[0].condition).toBe("Good Condition");
    expect(gvi.rows[0].remarks).toBe("looks fine");
    expect(gvi.rows[0].recorded).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("repeats the CVI header down one row per clock position", async () => {
    await seed();

    const [description] = (await gatherReportData(1, testDb)).items;
    const cvi = description.sections[1];

    expect(cvi.isCVI).toBe(true);
    expect(cvi.rows).toHaveLength(2);
    expect(cvi.rows[0].datum_reference).toBe("D-1");
    expect(cvi.rows[0].member_type).toBe("CHORD");
    expect(cvi.rows[0].cp_potential_mv).toBe("-850");
    expect(cvi.rows[0].clock_position).toBe("12:00");
    expect(cvi.rows[0].ut_mm).toBe("9.5");
    expect(cvi.rows[0].findings).toBe("pitting");
    expect(cvi.rows[1].clock_position).toBe("6:00");
    expect(cvi.rows[1].findings).toBe("");
  });

  it("emits an empty section for a type with no detail table", async () => {
    await seed();

    const [description] = (await gatherReportData(1, testDb)).items;
    const unmapped = description.sections[2];

    expect(unmapped.inspection_type).toBe("RA");
    expect(unmapped.rows).toEqual([]);
    for (const [key, value] of Object.entries(unmapped)) {
      if (key.startsWith("is")) expect(value).toBe(false);
    }
  });

  it("resolves the section image and blanks it when absent", async () => {
    await seed();

    const [description] = (await gatherReportData(1, testDb)).items;

    expect(description.sections[0].image).toBe("1-alpha/session-1/evidence-img/9001.png");
    expect(description.sections[1].image).toBe(NO_IMAGE);
  });

  it("prefers the annotated twin when the column says it exists", async () => {
    await seed();
    await testDb.update(schema.resultImage).set({ hasAnnotated: true });

    const [description] = (await gatherReportData(1, testDb)).items;

    expect(description.sections[0].image).toBe(
      "1-alpha/session-1/evidence-img/9001-annotated.png",
    );
  });

  it("keeps a result whose target left the tree", async () => {
    await seed();
    // a description under another project is reachable from this result but
    // absent from this project's tree walk
    await testDb.insert(schema.project).values({
      projectId: 2,
      displayNumber: 2,
      title: "Other",
    });
    await testDb.insert(schema.taskGroup).values({ taskGroupId: 2, projectId: 2, code: "900" });
    await testDb.insert(schema.taskCode).values({ taskCodeId: 20, taskGroupId: 2, code: "901" });
    await testDb
      .insert(schema.description)
      .values({ descriptionId: 200, taskCodeId: 20, label: "Other Leg" });
    await testDb.insert(schema.result).values({
      resultId: 5005,
      displayNumber: 5,
      projectId: 1,
      sessionId: 101,
      inspectionTypeCode: "GVI",
      descriptionId: 200,
      layer: 1,
      masterStartMs: 4000,
    });
    await testDb.insert(schema.resultGvi).values({ resultId: 5005, condition: "ok" });

    const data = await gatherReportData(1, testDb);

    // tree order first, then the orphan
    expect(data.items).toHaveLength(3);
    expect(data.items[2].description).toBe("");
    expect(data.items[2].task_group).toBe("");
    expect(data.items[2].sections[0].isGVI).toBe(true);
    expect(data.items[2].sections[0].rows[0].condition).toBe("Good Condition");
  });

  it("throws for an unknown project", async () => {
    await expect(gatherReportData(999, testDb)).rejects.toThrow();
  });

  it("throws for a non-positive id", async () => {
    await expect(gatherReportData(0, testDb)).rejects.toThrow();
  });

  it("returns no items for a project with an empty tree", async () => {
    await testDb
      .insert(schema.project)
      .values({ projectId: 2, displayNumber: 2, title: "Empty" });

    const data = await gatherReportData(2, testDb);

    expect(data.items).toEqual([]);
    expect(data.document_id).toBe("");
  });
});
