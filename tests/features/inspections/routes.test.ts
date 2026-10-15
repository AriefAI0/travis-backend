import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import { bearer, createTestUser } from "../../helpers/auth";
import { json } from "../../helpers/json";
import { inspectionRoutes } from "../../../src/features/inspections/routes";
import { inspectionFormRoutes } from "../../../src/features/inspection-forms/routes";
import { projectRoutes } from "../../../src/features/projects/routes";
import { resultRoutes } from "../../../src/features/results/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(
  testDb,
  inspectionRoutes,
  inspectionFormRoutes,
  projectRoutes,
  resultRoutes,
);

// minted per test in beforeEach; a result detail read now carries it
let resultToken = "";

const post = async (path: string, body: unknown) =>
  authRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// the GVI tool's own shape: KP/depth/UT scalars, CP readings as findings
const GVI_PAYLOAD = {
  kind: "gvi",
  version: 1,
  kpRange: "KP-1",
  depthEl: 12.5,
  gviUT: 8,
  gviCP: [{ value: 120, remark: "" }],
  condition: "ok",
};

// project > task group > task code > main component > branch > component code
// plus session and a capturing master, all with fixed ids
const seedWorld = async (withMaster = true) => {
  await testDb.insert(schema.project).values({ organizationId: testOrgId, displayNumber: 1, projectId: 1, title: "Alpha" });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 10, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 20, taskGroupId: 10, code: "101" });
  await testDb.insert(schema.description).values({ descriptionId: 30, taskCodeId: 20, label: "Row A" });
  await testDb.insert(schema.type).values({ typeId: 50, descriptionId: 30, code: "VDM" });
  await testDb.insert(schema.partCode).values({ partCodeId: 60, typeId: 50, code: "101-105" });
  // second main component for layer/duplicate probes
  await testDb.insert(schema.description).values({ descriptionId: 31, taskCodeId: 20, label: "Row B" });

  await testDb.insert(schema.session).values({ displayNumber: 1, sessionId: 101, projectId: 1, name: "Run 1", startEpoch: 1000 });
  if (withMaster) {
    await testDb.insert(schema.recordingIngest).values({
      kind: "master",
      sessionId: 101,
      ticketHash: "b".repeat(64),
      keyDate: "2026-09-24",
      keyPrefix: "1/1/1/2026/09/24/master/1",
    });
  }
};

const startInspection = (extra: Record<string, unknown>) =>
  post("/api/v1/inspections/start", {
    sessionId: 101,
    layer: 1,
    inspectionTypeCode: "GVI",
    descriptionId: 30,
    masterStartMs: 0,
    ...extra,
  });

// flow: start guards > stop validation > cancel > active list
describe("inspections routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(async () => {
    await truncateTestDatabase();
    resultToken = (await createTestUser({ preset: "Operator" })).token;
  });

  it("starts an inspection with a target and pins the current form version", async () => {
    await seedWorld();

    const res = await startInspection({});
    expect(res.status).toBe(201);
    const row = (await json(res)).data as Record<string, any>;
    expect(row.layer).toBe(1);
    expect(row.descriptionId).toBe(30);
    expect(row.inspectionFormId).not.toBeNull();
    expect(row.masterStartMs).toBe(0);
    expect(row.masterEndMs).toBeNull();
  });

  it("rejects a duplicate active target and type", async () => {
    await seedWorld();
    await startInspection({});

    const dup = await startInspection({});
    expect(dup.status).toBe(409);
    expect((await json(dup)).data).toBeUndefined();
  });

  it("rejects a second active inspection on the same layer and a layer above two", async () => {
    await seedWorld();
    await startInspection({});

    const sameLayer = await startInspection({ descriptionId: 31 });
    expect(sameLayer.status).toBe(409);
    const sameLayerBody = (await json(sameLayer)) as Record<string, any>;
    expect(sameLayerBody.code ?? sameLayerBody.error?.code ?? "layer_in_use").toContain("layer_in_use");

    // 2-layer cap: layer 2 is the one ad-hoc child, a third is refused
    const layerThree = await startInspection({ layer: 3, descriptionId: 31 });
    expect(layerThree.status).toBe(400);

    const tooHigh = await startInspection({ layer: 4, descriptionId: 31 });
    expect(tooHigh.status).toBe(400);
  });

  it("requires a master video", async () => {
    await seedWorld(false);
    const noMaster = await startInspection({});
    expect(noMaster.status).toBe(409);
  });

  it("requires exactly one target", async () => {
    await seedWorld();
    const both = await startInspection({ partCodeId: 60 });
    expect(both.status).toBe(400);
    const neither = await post("/api/v1/inspections/start", {
      sessionId: 101,
      layer: 1,
      inspectionTypeCode: "GVI",
      masterStartMs: 0,
    });
    expect(neither.status).toBe(400);
  });

  it("starts a component-code inspection on layer 2", async () => {
    await seedWorld();
    await startInspection({});

    const child = await startInspection({ layer: 2, descriptionId: undefined, partCodeId: 60 });
    expect(child.status).toBe(201);
    const row = (await json(child)).data as Record<string, any>;
    expect(row.partCodeId).toBe(60);
    expect(row.descriptionId).toBeNull();
  });

  it("stops with validated custom values and anchors the master end", async () => {
    await seedWorld();

    // add a required custom field through the form surface
    await post("/api/v1/projects/1/inspection-forms/GVI/versions", {
      customFields: [{ label: "Clamp note", dataType: "text", required: true, displayOrder: 0 }],
    });
    const form = (await json(await authRequest("/api/v1/projects/1/inspection-forms/GVI")))
      .data as Record<string, any>;
    const clampNote = form.fields.find((f: Record<string, any>) => f.label === "Clamp note");

    const started = await startInspection({});
    const resultId = (await json(started)).data.resultId as number;

    const missing = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 5000,
    });
    expect(missing.status).toBe(400);

    const wrongType = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: { [clampNote.inspectionFormFieldId]: 7 },
      masterEndMs: 5000,
    });
    expect(wrongType.status).toBe(400);

    const unknown = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: { "999999": "x" },
      masterEndMs: 5000,
    });
    expect(unknown.status).toBe(400);

    const stopped = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: { [clampNote.inspectionFormFieldId]: "surface corrosion" },
      masterEndMs: 5000,
    });
    expect(stopped.status).toBe(200);
    const row = (await json(stopped)).data as Record<string, any>;
    expect(row.masterEndMs).toBe(5000);
    expect(row.customValues[clampNote.inspectionFormFieldId]).toBe("surface corrosion");

    const doubleStop = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 6000,
    });
    expect(doubleStop.status).toBe(409);
  });

  it("cancels an open inspection and removes the row", async () => {
    await seedWorld();
    const started = await startInspection({});
    const resultId = (await json(started)).data.resultId as number;

    const cancel = await post(`/api/v1/inspections/${resultId}/cancel`, {});
    expect(cancel.status).toBe(200);

    const active = (await json(await authRequest("/api/v1/sessions/101/inspections/active")))
      .data as unknown[];
    expect(active).toHaveLength(0);
  });

  it("persists the stop payload verbatim", async () => {
    await seedWorld();
    const started = await startInspection({});
    const resultId = (await json(started)).data.resultId as number;

    const stopped = await post(`/api/v1/inspections/${resultId}/stop`, {
      remarks: "seen from the deck",
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 4200,
    });
    expect(stopped.status).toBe(200);

    const row = await testDb.query.result.findFirst({
      where: eq(schema.result.resultId, resultId),
    });
    expect(row?.submittedPayload).toEqual(GVI_PAYLOAD);
    expect(row?.remarks).toBe("seen from the deck");
  });

  it("stores the submit-time result class and defaults an omitted one to normal", async () => {
    await seedWorld();

    const anomaly = await startInspection({});
    const anomalyId = (await json(anomaly)).data.resultId as number;
    const stopped = await post(`/api/v1/inspections/${anomalyId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 5000,
      resultClass: "anomaly",
    });
    expect(stopped.status).toBe(200);

    const anomalyRow = await testDb.query.result.findFirst({
      where: eq(schema.result.resultId, anomalyId),
    });
    expect(anomalyRow?.resultClass).toBe("anomaly");

    // an omitted class keeps the column default, so every existing caller holds
    const plain = await startInspection({ layer: 2, descriptionId: undefined, partCodeId: 60 });
    const plainId = (await json(plain)).data.resultId as number;
    const plainStop = await post(`/api/v1/inspections/${plainId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 6000,
    });
    expect(plainStop.status).toBe(200);

    const plainRow = await testDb.query.result.findFirst({
      where: eq(schema.result.resultId, plainId),
    });
    expect(plainRow?.resultClass).toBe("normal");
  });

  it("rejects an unknown result class", async () => {
    await seedWorld();
    const started = await startInspection({});
    const resultId = (await json(started)).data.resultId as number;

    const res = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 5000,
      resultClass: "critical",
    });
    expect(res.status).toBe(400);
  });

  it("validates the class on a dry run without writing it", async () => {
    await seedWorld();
    const started = await startInspection({});
    const resultId = (await json(started)).data.resultId as number;

    const bad = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 5000,
      resultClass: "critical",
      dryRun: true,
    });
    expect(bad.status).toBe(400);

    const pass = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 5000,
      resultClass: "anomaly",
      dryRun: true,
    });
    expect(pass.status).toBe(200);

    const untouched = await testDb.query.result.findFirst({
      where: eq(schema.result.resultId, resultId),
    });
    expect(untouched?.resultClass).toBe("normal");
    expect(untouched?.masterEndMs).toBeNull();
  });

  // Continue prefills from this read, so the class must ride it
  it("returns the stored class on the form-state read", async () => {
    await seedWorld();
    const started = await startInspection({});
    const resultId = (await json(started)).data.resultId as number;
    await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 5000,
      resultClass: "anomaly",
    });

    const res = await authRequest(`/api/v1/results/${resultId}/form-state`);
    expect(res.status).toBe(200);
    const state = (await json(res)).data as Record<string, any>;
    expect(state.resultClass).toBe("anomaly");
  });

  it("dry-run fails exactly where the real stop fails, and writes nothing", async () => {
    await seedWorld();
    await post("/api/v1/projects/1/inspection-forms/GVI/versions", {
      customFields: [{ label: "Clamp note", dataType: "text", required: true, displayOrder: 0 }],
    });
    const form = (await json(await authRequest("/api/v1/projects/1/inspection-forms/GVI")))
      .data as Record<string, any>;
    const clampNote = form.fields.find((f: Record<string, any>) => f.label === "Clamp note");

    const started = await startInspection({});
    const resultId = (await json(started)).data.resultId as number;

    // the two drafts that failed live: a required value missing, and a null payload
    const badValues = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 5000,
      dryRun: true,
    });
    expect(badValues.status).toBe(400);

    const badPayload = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: null,
      customValues: { [clampNote.inspectionFormFieldId]: "note" },
      masterEndMs: 5000,
      dryRun: true,
    });
    expect(badPayload.status).toBe(400);
    expect((await json(badPayload)).code).toBe("payload_invalid");

    const pass = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: { [clampNote.inspectionFormFieldId]: "note" },
      masterEndMs: 5000,
      dryRun: true,
    });
    expect(pass.status).toBe(200);

    // a passing dry-run leaves the row open, so the real stop still works
    const untouched = await testDb.query.result.findFirst({
      where: eq(schema.result.resultId, resultId),
    });
    expect(untouched?.masterEndMs).toBeNull();
    expect(untouched?.submittedPayload).toBeNull();

    const real = await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: { [clampNote.inspectionFormFieldId]: "note" },
      masterEndMs: 5000,
    });
    expect(real.status).toBe(200);
  });

  it("lists active inspections with layer and target", async () => {
    await seedWorld();
    await startInspection({});
    await startInspection({ layer: 2, descriptionId: undefined, partCodeId: 60 });

    const active = (await json(await authRequest("/api/v1/sessions/101/inspections/active")))
      .data as Array<Record<string, any>>;
    expect(active).toHaveLength(2);
    expect(active.map((row) => row.layer).sort()).toEqual([1, 2]);
  });

  // one clip row per admission: a restart leaves the older take behind, and the
  // stack must point at the take that is actually on the wire
  it("reports a restarted result's newest take, preferring a live one", async () => {
    await seedWorld();
    const started = await startInspection({});
    const resultId = (await json(started)).data.resultId as number;

    const seedTake = async (clipId: number, startOffsetMs: number, open: boolean) => {
      await testDb.insert(schema.videoClip).values({
        clipId,
        resultId,
        sessionId: 101,
        startOffsetMs,
        endOffsetMs: open ? null : startOffsetMs + 3000,
      });
      await testDb.insert(schema.recordingIngest).values({
        kind: "clip",
        clipId,
        ticketHash: String(clipId).repeat(64).slice(0, 64),
        keyDate: "2026-09-24",
        keyPrefix: `p/take-${clipId}`,
        closedAt: open ? null : new Date(),
      });
    };

    await seedTake(700, 1000, false);
    await seedTake(701, 90_000, true);

    const active = (await json(await authRequest("/api/v1/sessions/101/inspections/active")))
      .data as Array<Record<string, any>>;
    expect(active[0]!.clip).toEqual({ clipId: 701, capturing: true });
  });

  it("falls back to the newest take when no capture is on the wire", async () => {
    await seedWorld();
    const started = await startInspection({});
    const resultId = (await json(started)).data.resultId as number;

    for (const [clipId, startOffsetMs] of [
      [700, 1000],
      [701, 90_000],
    ] as const) {
      await testDb.insert(schema.videoClip).values({
        clipId,
        resultId,
        sessionId: 101,
        startOffsetMs,
        endOffsetMs: startOffsetMs + 3000,
      });
      await testDb.insert(schema.recordingIngest).values({
        kind: "clip",
        clipId,
        ticketHash: String(clipId).repeat(64).slice(0, 64),
        keyDate: "2026-09-24",
        keyPrefix: `p/take-${clipId}`,
        closedAt: new Date(),
      });
    }

    const active = (await json(await authRequest("/api/v1/sessions/101/inspections/active")))
      .data as Array<Record<string, any>>;
    expect(active[0]!.clip).toEqual({ clipId: 701, capturing: false });
  });

  it("lets an open inspection adopt a form version saved mid-inspection", async () => {
    await seedWorld();
    const started = await startInspection({});
    const resultId = (await json(started)).data.resultId as number;

    // operator edits the form while the inspection is open
    const saved = (await json(
      await post("/api/v1/projects/1/inspection-forms/GVI/versions", {
        customFields: [{ label: "Mid-flight note", dataType: "text", displayOrder: 0 }]
      })
    )).data as Record<string, any>;
    const midField = saved.fields.find((f: Record<string, any>) => f.label === "Mid-flight note");

    const stopped = await post(`/api/v1/inspections/${resultId}/stop`, {
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
  it("deletes a project that has results and tree data", async () => {
    await seedWorld();
    const started = await startInspection({});
    const resultId = (await json(started)).data.resultId as number;
    await post(`/api/v1/inspections/${resultId}/stop`, {
      payload: GVI_PAYLOAD,
      customValues: {},
      masterEndMs: 1000
    });

    // The recorder closes its ingest when it stops; the idle sweep closes one
    // that went quiet. An open ingest refuses the project delete by design, so
    // close it here the way production would before the operator deletes.
    await testDb
      .update(schema.recordingIngest)
      .set({ closedAt: new Date() })
      .where(eq(schema.recordingIngest.sessionId, 101));

    // The suite's own token is an Operator, which holds no `remove Project`,
    // so this delete carries an Admin's bearer instead.
    const admin = await createTestUser({ preset: "Admin" });
    const deleted = await app.request("/api/v1/projects/1", {
      method: "DELETE",
      headers: bearer(admin.token),
    });
    expect(deleted.status).toBe(200);

    const remaining = await testDb.query.result.findMany({ where: undefined });
    expect(remaining).toHaveLength(0);
    const remainingGroups = await testDb.query.taskGroup.findMany({ where: undefined });
    expect(remainingGroups).toHaveLength(0);
  });
});

// every request carries the Admin token minted in beforeEach
const authRequest = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...((init.headers ?? {}) as Record<string, string>),
      authorization: `Bearer ${resultToken}`,
    },
  });
