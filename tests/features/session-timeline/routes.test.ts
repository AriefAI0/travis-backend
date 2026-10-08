import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { sessionTimelineRoutes } from "../../../src/features/session-timeline/routes";
import { resultRoutes } from "../../../src/features/results/routes";
import { projectRoutes } from "../../../src/features/projects/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, sessionTimelineRoutes, resultRoutes, projectRoutes);

// project > tree chain > session > capturing master, fixed ids
const seedWorld = async () => {
  await testDb.insert(schema.project).values({ displayNumber: 1, projectId: 1, title: "Alpha" });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 10, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 20, taskGroupId: 10, code: "101" });
  await testDb.insert(schema.description).values({ descriptionId: 30, taskCodeId: 20, label: "Row A" });
  await testDb.insert(schema.type).values({ typeId: 50, descriptionId: 30, code: "VDM" });
  await testDb.insert(schema.partCode).values({ partCodeId: 60, typeId: 50, code: "101-105" });
  await testDb.insert(schema.session).values({ displayNumber: 1, sessionId: 101, projectId: 1, name: "Run 1", startEpoch: 1000 });
  await testDb.insert(schema.recordingIngest).values({
    kind: "master",
    sessionId: 101,
    ticketHash: "b".repeat(64),
    keyDate: "2026-09-24",
    keyPrefix: "1/1/1/2026/09/24/master/1",
  });
};

// NOTE: inspection routes are not mounted here; rows are inserted directly so
// this suite stays read-only over its own fixtures
const insertResult = async (overrides: Partial<typeof schema.result.$inferInsert>) => {
  await testDb.insert(schema.result).values({
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "GVI",
    descriptionId: 30,
    layer: 1,
    masterStartMs: 0,
    inspectionFormId: null,
    displayNumber: 1,
    ...overrides,
  });
};

// flow: rows > markers > sidebars
describe("session timeline routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("returns session rows open and finished with breadcrumbs", async () => {
    await seedWorld();
    await insertResult({ displayNumber: 1, masterStartMs: 0, masterEndMs: 60000 });
    await insertResult({
      displayNumber: 2,
      layer: 2,
      descriptionId: null,
      partCodeId: 60,
      inspectionTypeCode: "CP",
      masterStartMs: 10000,
    });

    const rows = (await json(await app.request("/api/v1/sessions/101/results")))
      .data as Array<Record<string, any>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.target.kind).toBe("description");
    expect(rows[0]!.breadcrumb.taskGroup.code).toBe("100");
    expect(rows[0]!.breadcrumb.description.label).toBe("Row A");
    expect(rows[1]!.target.kind).toBe("part_code");
    expect(rows[1]!.breadcrumb.type.code).toBe("VDM");
    expect(rows[1]!.breadcrumb.partCode.code).toBe("101-105");
    expect(rows[1]!.masterEndMs).toBeNull();
  });

  it("returns only finished markers ordered by master start", async () => {
    await seedWorld();
    await insertResult({ displayNumber: 1, layer: 1, masterStartMs: 120000, masterEndMs: 240000 });
    await insertResult({ displayNumber: 2, layer: 2, descriptionId: null, partCodeId: 60, masterStartMs: 0, masterEndMs: 60000 });
    await insertResult({ displayNumber: 3, layer: 1, masterStartMs: 300000 });

    const markers = (await json(await app.request("/api/v1/sessions/101/inspection-markers")))
      .data as Array<Record<string, any>>;
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.masterStartMs)).toEqual([0, 120000]);
    expect(markers[0]!.layer).toBe(2);
    expect(markers[1]!.layer).toBe(1);
  });

  it("serves the sidebar for both target kinds", async () => {
    await seedWorld();
    await insertResult({ displayNumber: 1, masterStartMs: 0, masterEndMs: 60000 });
    await insertResult({
      displayNumber: 2,
      layer: 2,
      descriptionId: null,
      partCodeId: 60,
      masterStartMs: 10000,
      masterEndMs: 20000,
    });

    const comp = (await json(await app.request("/api/v1/descriptions/30/results")))
      .data as Record<string, any>;
    expect(comp.sessions).toHaveLength(1);
    expect(comp.sessions[0]!.results).toHaveLength(1);
    expect(comp.sessions[0]!.results[0]!.layer).toBe(1);

    const code = (await json(await app.request("/api/v1/part-codes/60/results")))
      .data as Record<string, any>;
    expect(code.sessions[0]!.results).toHaveLength(1);
    expect(code.target.partCodeId).toBe(60);
  });
});
