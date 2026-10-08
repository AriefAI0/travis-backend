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
    expect(xml).toContain("looks fine");

    // no placeholder text may survive the render
    expect(xml).not.toContain("{task_group}");
    expect(xml).not.toContain("{#result_rows}");
    expect(xml).not.toContain("{%image}");

    // every result block embeds one picture: the real image when the row has
    // one, the transparent placeholder when it does not
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

  it("rejects an unknown project", async () => {
    await expect(generateReport(999, testDb)).rejects.toThrow();
  });
});
