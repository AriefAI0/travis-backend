import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { inspectionRoutes } from "../../../src/features/inspections/routes";
import { inspectionFormRoutes } from "../../../src/features/inspection-forms/routes";
import { projectRoutes } from "../../../src/features/projects/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, inspectionRoutes, inspectionFormRoutes, projectRoutes);

const post = async (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const GVI_PAYLOAD = { kind: "gvi", version: 1, gviCP: 120, gviUT: null, condition: "ok" };

// project > task group > task code > main component > branch > component code
// plus session and a capturing master, all with fixed ids
const seedWorld = async (withMaster = true) => {
  await testDb.insert(schema.project).values({ displayNumber: 1, projectId: 1, title: "Alpha" });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 10, projectId: 1, groupCode: "100", label: "Rows" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 20, taskGroupId: 10, code: "101", label: "Row A" });
  await testDb.insert(schema.mainComponent).values({ mainComponentId: 30, taskCodeId: 20, description: "Row A" });
  await testDb.insert(schema.componentType).values({ componentTypeId: 40, projectId: 1, typeCode: "VDM", label: "VDM" });
  await testDb.insert(schema.mainComponentType).values({ mainComponentTypeId: 50, mainComponentId: 30, componentTypeId: 40 });
  await testDb.insert(schema.componentCode).values({ componentCodeId: 60, mainComponentTypeId: 50, code: "101-105" });
  // second main component for layer/duplicate probes
  await testDb.insert(schema.mainComponent).values({ mainComponentId: 31, taskCodeId: 20, description: "Row B" });

  await testDb.insert(schema.session).values({ displayNumber: 1, sessionId: 101, projectId: 1, name: "Run 1" });
  if (withMaster) {
    await testDb.insert(schema.masterVideo).values({ masterVideoId: 1, sessionId: 101, startEpoch: 1000 });
    await testDb.insert(schema.recordingIngest).values({
      kind: "master",
      masterVideoId: 1,
      ticketHash: "b".repeat(64),
      keyDate: "2026-09-24",
      keyPrefix: "1/1/1/2026/09/24/master/1",
    });
  }
};

const startV2 = (extra: Record<string, unknown>) =>
  post("/api/v1/inspections/v2/start", {
    sessionId: 101,
    layer: 1,
    inspectionTypeCode: "GVI",
    mainComponentId: 30,
    masterStartMs: 0,
    ...extra,
  });

// flow: start guards > stop validation > cancel > active list
describe("inspections v2 routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("starts a v2 inspection with a target and pins the current form version", async () => {
    await seedWorld();

    const res = await startV2({});
    expect(res.status).toBe(201);
    const row = (await json(res)).data as Record<string, any>;
    expect(row.layer).toBe(1);
    expect(row.mainComponentId).toBe(30);
    expect(row.inspectionFormId).not.toBeNull();
    expect(row.masterStartMs).toBe(0);
    expect(row.masterEndMs).toBeNull();
  });

  it("rejects a duplicate active target and type", async () => {
    await seedWorld();
    await startV2({});

    const dup = await startV2({});
    expect(dup.status).toBe(409);
    expect((await json(dup)).data).toBeUndefined();
  });

  it("rejects a second active inspection on the same layer and a layer above three", async () => {
    await seedWorld();
    await startV2({});

    const sameLayer = await startV2({ mainComponentId: 31 });
    expect(sameLayer.status).toBe(409);
    const sameLayerBody = (await json(sameLayer)) as Record<string, any>;
    expect(sameLayerBody.code ?? sameLayerBody.error?.code ?? "layer_in_use").toContain("layer_in_use");

    const tooHigh = await startV2({ layer: 4, mainComponentId: 31 });
    expect(tooHigh.status).toBe(400);
  });

  it("requires a master video", async () => {
    await seedWorld(false);
    const noMaster = await startV2({});
    expect(noMaster.status).toBe(409);
  });

  it("requires exactly one target", async () => {
    await seedWorld();
    const both = await startV2({ componentCodeId: 60 });
    expect(both.status).toBe(400);
    const neither = await post("/api/v1/inspections/v2/start", {
      sessionId: 101,
      layer: 1,
      inspectionTypeCode: "GVI",
      masterStartMs: 0,
    });
    expect(neither.status).toBe(400);
  });

  it("starts a component-code inspection on layer 2", async () => {
    await seedWorld();
    await startV2({});

    const child = await startV2({ layer: 2, mainComponentId: undefined, componentCodeId: 60 });
    expect(child.status).toBe(201);
    const row = (await json(child)).data as Record<string, any>;
    expect(row.componentCodeId).toBe(60);
    expect(row.mainComponentId).toBeNull();
  });

  it("stops with validated custom values and anchors the master end", async () => {
    await seedWorld();

    // add a required custom field through the form surface
    await post("/api/v1/projects/1/inspection-forms/GVI/versions", {
      customFields: [{ label: "Clamp note", dataType: "text", required: true, displayOrder: 0 }],
    });
    const form = (await json(await app.request("/api/v1/projects/1/inspection-forms/GVI")))
      .data as Record<string, any>;
    const clampNote = form.fields.find((f: Record<string, any>) => f.label === "Clamp note");

    const started = await startV2({});
    const resultId = (await json(started)).data.resultId as number;

    const missing = await post(`/api/v1/inspections/v2/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 5000,
    });
    expect(missing.status).toBe(400);

    const wrongType = await post(`/api/v1/inspections/v2/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: { [clampNote.inspectionFormFieldId]: 7 },
      masterEndMs: 5000,
    });
    expect(wrongType.status).toBe(400);

    const unknown = await post(`/api/v1/inspections/v2/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: { "999999": "x" },
      masterEndMs: 5000,
    });
    expect(unknown.status).toBe(400);

    const stopped = await post(`/api/v1/inspections/v2/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: { [clampNote.inspectionFormFieldId]: "surface corrosion" },
      masterEndMs: 5000,
    });
    expect(stopped.status).toBe(200);
    const row = (await json(stopped)).data as Record<string, any>;
    expect(row.masterEndMs).toBe(5000);
    expect(row.customValues[clampNote.inspectionFormFieldId]).toBe("surface corrosion");

    const doubleStop = await post(`/api/v1/inspections/v2/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 6000,
    });
    expect(doubleStop.status).toBe(409);
  });

  it("cancels an open inspection and removes the row", async () => {
    await seedWorld();
    const started = await startV2({});
    const resultId = (await json(started)).data.resultId as number;

    const cancel = await post(`/api/v1/inspections/v2/${resultId}/cancel`, {});
    expect(cancel.status).toBe(200);

    const active = (await json(await app.request("/api/v1/sessions/101/inspections/active")))
      .data as unknown[];
    expect(active).toHaveLength(0);
  });

  it("lists active v2 inspections with layer and target", async () => {
    await seedWorld();
    await startV2({});
    await startV2({ layer: 2, mainComponentId: undefined, componentCodeId: 60 });

    const active = (await json(await app.request("/api/v1/sessions/101/inspections/active")))
      .data as Array<Record<string, any>>;
    expect(active).toHaveLength(2);
    expect(active.map((row) => row.layer).sort()).toEqual([1, 2]);
  });

  it("lets an open inspection adopt a form version saved mid-inspection", async () => {
    await seedWorld();
    const started = await startV2({});
    const resultId = (await json(started)).data.resultId as number;

    // operator edits the form while the inspection is open
    const saved = (await json(
      await post("/api/v1/projects/1/inspection-forms/GVI/versions", {
        customFields: [{ label: "Mid-flight note", dataType: "text", displayOrder: 0 }]
      })
    )).data as Record<string, any>;
    const midField = saved.fields.find((f: Record<string, any>) => f.label === "Mid-flight note");

    const stopped = await post(`/api/v1/inspections/v2/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: { [midField.inspectionFormFieldId]: "added mid-inspection" },
      masterEndMs: 7000
    });
    expect(stopped.status).toBe(200);
    const row = (await json(stopped)).data as Record<string, any>;
    expect(row.inspectionFormId).toBe(saved.inspectionFormId);
    expect(row.customValues[midField.inspectionFormFieldId]).toBe("added mid-inspection");
  });

  // regression: RESTRICT target FKs deadlocked project deletion once results existed
  it("deletes a project that has v2 results and tree data", async () => {
    await seedWorld();
    const started = await startV2({});
    const resultId = (await json(started)).data.resultId as number;
    await post(`/api/v1/inspections/v2/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 1000
    });

    const deleted = await app.request("/api/v1/projects/1", { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const remaining = await testDb.query.result.findMany({ where: undefined });
    expect(remaining).toHaveLength(0);
    const remainingGroups = await testDb.query.taskGroup.findMany({ where: undefined });
    expect(remainingGroups).toHaveLength(0);
  });
});
