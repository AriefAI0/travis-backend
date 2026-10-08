import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { generateReport } from "../../../src/features/reports/report-generator";
import * as schema from "../../../src/db/schema";

const require = createRequire(import.meta.url);
const PizZip = require("pizzip");

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

const mediaEntriesIn = (buf: Buffer) =>
  Object.keys(new PizZip(buf).files).filter((name) => name.startsWith("word/media/"));

const documentXmlIn = (buf: Buffer) =>
  new PizZip(buf).file("word/document.xml").asText() as string;

// project > session > group > code > description > type > part code > result
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
  await testDb.insert(schema.result).values({
    resultId: 5001,
    displayNumber: 1,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "GVI",
    descriptionId: 100,
    layer: 1,
    masterStartMs: 0,
    remarks: "looks fine",
  });
  await testDb.insert(schema.resultImage).values({
    imageId: 9001,
    resultId: 5001,
    storageStem: "1-alpha/session-1/evidence-img",
    contentType: "image/png",
    hasAnnotated: false,
  });

  // second result with NO image row: exercises the empty image-tag path
  await testDb.insert(schema.result).values({
    resultId: 5002,
    displayNumber: 2,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "GVI",
    partCodeId: 300,
    layer: 1,
    masterStartMs: 1000,
  });

  // the type table reads these columns, not a formatted summary string
  await testDb.insert(schema.resultGvi).values([
    { resultId: 5001, kpRange: "KP-1", condition: "not_ok" },
    { resultId: 5002, kpRange: "KP-2", gviCP: -900, condition: "ok" },
  ]);
};

// one target carrying three inspection types at once
const seedMixedTypes = async () => {
  await seed();
  await testDb.insert(schema.result).values([
    {
      resultId: 5003,
      displayNumber: 3,
      projectId: 1,
      sessionId: 101,
      inspectionTypeCode: "CVI",
      descriptionId: 100,
      layer: 1,
      masterStartMs: 2000,
    },
    {
      resultId: 5004,
      displayNumber: 4,
      projectId: 1,
      sessionId: 101,
      inspectionTypeCode: "MGI",
      descriptionId: 100,
      layer: 1,
      masterStartMs: 3000,
    },
  ]);
  await testDb.insert(schema.resultCvi).values({
    resultId: 5003,
    datumReference: "D-1",
    memberType: "chord",
    cpPotentialMv: -850,
  });
  await testDb.insert(schema.resultCviPosition).values({
    resultId: 5003,
    clockPosition: "12:00",
    utMm: 9.5,
    findings: "pitting",
    sortOrder: 0,
  });
  await testDb.insert(schema.resultMgi).values({
    resultId: 5004,
    noMgObserved: 0,
    criteriaPreset: "client_cnc",
  });
  await testDb.insert(schema.resultMgiFinding).values({
    resultMgiId: 5004,
    growthType: "hard",
    species: "Barnacle",
    coveragePercent: 40,
    thicknessMm: 12,
    remarks: "heavy",
    sortOrder: 0,
  });
};

describe("generateReport", () => {
  it("renders the bundled template with data and one embedded image", async () => {
    await seed();

    const buf = await generateReport(1, testDb);

    // a docx is a zip, so the first two bytes are the zip magic
    expect(buf.subarray(0, 2).toString()).toBe("PK");

    const xml = documentXmlIn(buf);
    expect(xml).toContain("Alpha");
    expect(xml).toContain("DOC-1");
    expect(xml).toContain("100");
    expect(xml).toContain("Leg A");
    expect(xml).toContain("GVI Results");
    expect(xml).toContain("KP-2");
    expect(xml).toContain("Good Condition");
    expect(xml).toContain("looks fine");

    // no placeholder text may survive the render
    expect(xml).not.toContain("{task_group}");
    expect(xml).not.toContain("{#items}");
    expect(xml).not.toContain("{#sections}");
    expect(xml).not.toContain("{%image}");

    // every section embeds one picture: the real image when the row has one,
    // the transparent placeholder when it does not
    expect(mediaEntriesIn(buf)).toHaveLength(2);
  });

  it("renders a project that has no results and embeds no image", async () => {
    await testDb
      .insert(schema.project)
      .values({ projectId: 2, displayNumber: 2, title: "Empty" });

    const buf = await generateReport(2, testDb);

    expect(buf.subarray(0, 2).toString()).toBe("PK");
    expect(documentXmlIn(buf)).toContain("Empty");
    expect(mediaEntriesIn(buf)).toHaveLength(0);
  });

  it("renders one table per inspection type with that type's columns", async () => {
    await seedMixedTypes();

    const buf = await generateReport(1, testDb);
    const xml = documentXmlIn(buf);

    // one block per type on the target, each with its own heading
    expect(xml).toContain("GVI Results");
    expect(xml).toContain("CVI Results");
    expect(xml).toContain("MGI Results");
    // a type the project has no result for contributes no block at all
    expect(xml).not.toContain("BSI Results");
    expect(xml).not.toContain("SCOUR Results");

    // the columns each type actually reads
    expect(xml).toContain("KP-2");
    expect(xml).toContain("Good Condition");
    expect(xml).toContain("CHORD");
    expect(xml).toContain("-850");
    expect(xml).toContain("12:00");
    expect(xml).toContain("pitting");
    expect(xml).toContain("Barnacle");
    expect(xml).toContain("client_cnc");

    expect(xml).not.toContain("{#items}");
    expect(xml).not.toContain("{#sections}");
    expect(xml).not.toContain("{#isCVI}");
    expect(xml).not.toContain("{recorded}");
    expect(xml).not.toContain("{%image}");
  });

  it("rejects an unknown project", async () => {
    await expect(generateReport(999, testDb)).rejects.toThrow();
  });
});
