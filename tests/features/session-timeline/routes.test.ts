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
import { reportRoutes } from "../../../src/features/reports/routes";
import { projectRoutes } from "../../../src/features/projects/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, sessionTimelineRoutes, resultRoutes, reportRoutes, projectRoutes);

// project > tree chain > session > capturing master, fixed ids
const seedWorld = async () => {
  await testDb.insert(schema.project).values({ displayNumber: 1, projectId: 1, title: "Alpha" });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 10, projectId: 1, groupCode: "100", label: "Rows" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 20, taskGroupId: 10, code: "101", label: "Row A" });
  await testDb.insert(schema.mainComponent).values({ mainComponentId: 30, taskCodeId: 20, description: "Row A" });
  await testDb.insert(schema.componentType).values({ componentTypeId: 40, projectId: 1, typeCode: "VDM", label: "VDM" });
  await testDb.insert(schema.mainComponentType).values({ mainComponentTypeId: 50, mainComponentId: 30, componentTypeId: 40 });
  await testDb.insert(schema.componentCode).values({ componentCodeId: 60, mainComponentTypeId: 50, code: "101-105" });
  await testDb.insert(schema.session).values({ displayNumber: 1, sessionId: 101, projectId: 1, name: "Run 1" });
  await testDb.insert(schema.masterVideo).values({ masterVideoId: 1, sessionId: 101, startEpoch: 1000 });
  await testDb.insert(schema.recordingIngest).values({
    kind: "master",
    masterVideoId: 1,
    ticketHash: "b".repeat(64),
    keyDate: "2026-09-24",
    keyPrefix: "1/1/1/2026/09/24/master/1",
  });
};

// NOTE: inspection routes are not mounted here; rows are inserted directly so
// this suite stays read-only over its own fixtures
const insertV2Result = async (overrides: Partial<typeof schema.result.$inferInsert>) => {
  await testDb.insert(schema.result).values({
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "GVI",
    mainComponentId: 30,
    layer: 1,
    masterStartMs: 0,
    inspectionFormId: null,
    displayNumber: 1,
    ...overrides,
  });
};

// flow: rows > markers > sidebars > report stub
describe("session timeline routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("returns session rows open and finished with breadcrumbs", async () => {
    await seedWorld();
    await insertV2Result({ displayNumber: 1, masterStartMs: 0, masterEndMs: 60000 });
    await insertV2Result({
      displayNumber: 2,
      layer: 2,
      mainComponentId: null,
      componentCodeId: 60,
      inspectionTypeCode: "CP",
      masterStartMs: 10000,
    });

    const rows = (await json(await app.request("/api/v1/sessions/101/results")))
      .data as Array<Record<string, any>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.target.kind).toBe("main_component");
    expect(rows[0]!.breadcrumb.taskGroup.code).toBe("100");
    expect(rows[0]!.breadcrumb.mainComponent.description).toBe("Row A");
    expect(rows[1]!.target.kind).toBe("component_code");
    expect(rows[1]!.breadcrumb.componentType.code).toBe("VDM");
    expect(rows[1]!.breadcrumb.componentCode.code).toBe("101-105");
    expect(rows[1]!.masterEndMs).toBeNull();
  });

  it("returns only finished markers ordered by master start", async () => {
    await seedWorld();
    await insertV2Result({ displayNumber: 1, layer: 1, masterStartMs: 120000, masterEndMs: 240000 });
    await insertV2Result({ displayNumber: 2, layer: 2, mainComponentId: null, componentCodeId: 60, masterStartMs: 0, masterEndMs: 60000 });
    await insertV2Result({ displayNumber: 3, layer: 1, masterStartMs: 300000 });

    const markers = (await json(await app.request("/api/v1/sessions/101/inspection-markers")))
      .data as Array<Record<string, any>>;
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.masterStartMs)).toEqual([0, 120000]);
    expect(markers[0]!.layer).toBe(2);
    expect(markers[1]!.layer).toBe(1);
  });

  it("serves the sidebar for both target kinds", async () => {
    await seedWorld();
    await insertV2Result({ displayNumber: 1, masterStartMs: 0, masterEndMs: 60000 });
    await insertV2Result({
      displayNumber: 2,
      layer: 2,
      mainComponentId: null,
      componentCodeId: 60,
      masterStartMs: 10000,
      masterEndMs: 20000,
    });

    const comp = (await json(await app.request("/api/v1/main-components/30/results")))
      .data as Record<string, any>;
    expect(comp.sessions).toHaveLength(1);
    expect(comp.sessions[0]!.results).toHaveLength(1);
    expect(comp.sessions[0]!.results[0]!.layer).toBe(1);

    const code = (await json(await app.request("/api/v1/component-codes/60/results")))
      .data as Record<string, any>;
    expect(code.sessions[0]!.results).toHaveLength(1);
    expect(code.target.componentCodeId).toBe(60);
  });

  it("answers the report stub with 501", async () => {
    await seedWorld();
    const res = await app.request("/api/v1/projects/1/report/preview");
    expect(res.status).toBe(501);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe("not_implemented");
  });
});
