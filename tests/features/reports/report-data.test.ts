import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { gatherReportData } from "../../../src/features/reports/report-data";
import * as schema from "../../../src/db/schema";

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

  // ids run opposite to tree order, so output order proves a tree walk
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

  await testDb.insert(schema.resultImage).values({
    imageId: 9001,
    resultId: 5002,
    storageStem: "1-alpha/session-1/evidence-img",
    contentType: "image/png",
    hasAnnotated: false,
  });
};

describe("gatherReportData", () => {
  it("fills project vars and walks rows in task-tree order", async () => {
    await seed();

    const data = await gatherReportData(1, testDb);

    expect(data.project_title).toBe("Alpha");
    expect(data.project_id).toBe(1);
    expect(data.document_id).toBe("DOC-1");
    expect(data.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.result_rows).toHaveLength(2);

    // description target first, even though its result id is the higher one
    const [first, second] = data.result_rows;
    expect(first.description).toBe("Leg A");
    expect(first.task_group).toBe("100");
    expect(first.task_code).toBe("101");
    expect(first.type_code).toBe("");
    expect(first.part_code).toBe("");
    expect(first.inspection_type).toBe("GVI");
    expect(first.remarks).toBe("looks fine");
    expect(first.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(second.part_code).toBe("P1");
    expect(second.type_code).toBe("T1");
    expect(second.description).toBe("");
    expect(second.remarks).toBe("");
  });

  it("resolves the image object key and blanks it when absent", async () => {
    await seed();

    const data = await gatherReportData(1, testDb);

    expect(data.result_rows[0].image).toBe("1-alpha/session-1/evidence-img/9001.png");
    expect(data.result_rows[1].image).toBe("");
  });

  it("prefers the annotated twin when the column says it exists", async () => {
    await seed();
    await testDb.update(schema.resultImage).set({ hasAnnotated: true });

    const data = await gatherReportData(1, testDb);

    expect(data.result_rows[0].image).toBe("1-alpha/session-1/evidence-img/9001-annotated.png");
  });

  it("throws for an unknown project", async () => {
    await expect(gatherReportData(999, testDb)).rejects.toThrow();
  });

  it("throws for a non-positive id", async () => {
    await expect(gatherReportData(0, testDb)).rejects.toThrow();
  });

  it("returns no rows for a project with an empty tree", async () => {
    await testDb
      .insert(schema.project)
      .values({ projectId: 2, displayNumber: 2, title: "Empty" });

    const data = await gatherReportData(2, testDb);

    expect(data.result_rows).toEqual([]);
    expect(data.document_id).toBe("");
  });
});
