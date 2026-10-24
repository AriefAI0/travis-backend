// CVI and DVI detail getters carry each position's createdAt, ISO string.
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
  getCviDetailByResultId,
  getDviDetailByResultId,
} from "../../src/db/services/result.service";

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

const AT = new Date("2026-10-24T02:04:05.000Z");

// project > session > group > code > description > type > part code
const seedTree = async () => {
  await testDb.insert(schema.project).values({
    organizationId: testOrgId,
    projectId: 1,
    displayNumber: 1,
    title: "Alpha",
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

// one result row, detail row goes in per type
const addResult = async (resultId: number, inspectionTypeCode: (typeof schema.result.$inferInsert)["inspectionTypeCode"]) =>
  testDb.insert(schema.result).values({
    resultId,
    displayNumber: resultId % 1000,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode,
    partCodeId: 300,
    layer: 1,
    masterStartMs: 0,
  });

describe("position timestamps", () => {
  it("returns createdAt on every CVI position", async () => {
    await seedTree();
    await addResult(5003, "CVI");
    await testDb.insert(schema.resultCvi).values({ resultId: 5003 });
    await testDb.insert(schema.resultCviPosition).values([
      { resultId: 5003, memberType: "chord", clockPosition: "12:00", sortOrder: 0, createdAt: AT, updatedAt: AT },
      { resultId: 5003, memberType: "brace", clockPosition: "3:00", sortOrder: 1, createdAt: AT, updatedAt: AT },
    ]);

    const detail = await getCviDetailByResultId(5003, testDb);

    const positions = detail!.members.flatMap((member) => member.positions);
    expect(positions).toHaveLength(2);
    expect(positions.map((position) => position.createdAt)).toEqual([AT.toISOString(), AT.toISOString()]);
  });

  it("returns createdAt on every DVI position", async () => {
    await seedTree();
    await addResult(5004, "DVI");
    await testDb.insert(schema.resultDvi).values({ resultId: 5004, memberType: "chord" });
    await testDb.insert(schema.resultDviPosition).values([
      { resultId: 5004, clockPosition: "12:00", sortOrder: 0, createdAt: AT, updatedAt: AT },
      { resultId: 5004, clockPosition: "6:00", sortOrder: 1, createdAt: AT, updatedAt: AT },
    ]);

    const detail = await getDviDetailByResultId(5004, testDb);

    expect(detail!.positions).toHaveLength(2);
    expect(detail!.positions.map((position) => position.createdAt)).toEqual([AT.toISOString(), AT.toISOString()]);
  });
});
