import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";

import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { inspectionRoutes } from "../../../src/features/inspections/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, inspectionRoutes);

// frozen key prefix every ingest fixture carries; not under test here
const KEY_PREFIX = "1/1/214/2026/09/20/master/1";

const startBody = (code: string, extra: Record<string, unknown> = {}) => ({
  sessionId: 101,
  itemId: 100,
  inspectionTypeCode: code,
  ...extra,
});

// project > asset > component > item > session, master on 'recording'
const seedHierarchy = async (withMaster = true) => {
  await testDb.insert(schema.project).values({ displayNumber: 1, projectId: 1, title: "Alpha" });
  await testDb.insert(schema.asset).values({ assetId: 11, projectId: 1, name: "Platform A" });
  await testDb.insert(schema.component).values({
    componentId: 21,
    assetId: 11,
    projectId: 1,
    name: "Jacket Leg",
  });
  await testDb.insert(schema.item).values({
    itemId: 100,
    componentId: 21,
    projectId: 1,
    assetId: 11,
    itemLabel: "JL-01",
    status: "pending",
  });
  await testDb.insert(schema.session).values({ sessionId: 101, projectId: 1, name: "Run 1" });
  if (withMaster) {
    await testDb.insert(schema.masterVideo).values({
      masterVideoId: 1,
      sessionId: 101,
      startEpoch: 1000,
    });
    // an open ingest is what makes the master count as capturing
    await testDb.insert(schema.recordingIngest).values({
      kind: "master",
      masterVideoId: 1,
      ticketHash: "b".repeat(64),
      keyDate: "2026-09-20",
      keyPrefix: KEY_PREFIX,
    });
  }
};

// start an inspection and return its resultId
const startInspection = async (code: string) => {
  const res = await app.request("/api/v1/inspections/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(startBody(code)),
  });
  expect(res.status).toBe(201);
  const { data } = await json(res);
  return data.resultId as number;
};

const stopInspection = async (resultId: number, payload: unknown) => {
  return app.request(`/api/v1/inspections/${resultId}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload }),
  });
};

// valid payload per type, sourced from the app's tool types
const validPayloads: Record<string, unknown> = {
  GVI: { kind: "gvi", version: 1, gviCP: 120, gviUT: null, condition: "ok" },
  CVI: {
    kind: "cvi",
    version: 1,
    datumReference: "Datum A",
    memberType: "chord",
    positions: [{ clockPosition: "12", utMm: 12.5, findings: "clean" }],
    cpPotentialMv: null,
  },
  MGI: {
    kind: "mgi",
    version: 1,
    findings: [
      { id: "f1", growthType: "soft", species: "barnacle", coveragePercent: 40, thicknessMm: 25 },
    ],
    criteria: { preset: "project_default" },
    noMgObserved: false,
  },
  CP: {
    kind: "cp",
    version: 1,
    anodeType: "alu",
    voltageMv: -850,
    depletion: "none",
    anodeWidth: 10,
  },
  FMD: {
    kind: "fmd",
    version: 1,
    depthEl: 2.5,
    initialAttempt: "dry",
    additionalAttempt1: "flooded",
    additionalAttempt2: "na",
    additionalAttempt3: "na",
  },
  SCOUR: {
    kind: "scour",
    version: 1,
    exposedPile: "exposed",
    exposedPileHeight: 1.2,
    heightLeg1: null,
    heightMidpoint: null,
    heightLeg2: null,
  },
};

// one field broken per type: wrong enum, wrong type, or missing field
const invalidPayloads: Record<string, unknown> = {
  GVI: { kind: "gvi", version: 1, condition: "broken" },
  CVI: {
    kind: "cvi",
    version: 1,
    datumReference: "Datum A",
    memberType: "chord",
    positions: [{ clockPosition: "5", utMm: 1, findings: "x" }],
    cpPotentialMv: null,
  },
  MGI: {
    kind: "mgi",
    version: 1,
    findings: [],
    criteria: { preset: "bogus" },
    noMgObserved: false,
  },
  CP: { kind: "cp", version: 1, anodeType: "alu", voltageMv: "850", depletion: "none" },
  FMD: {
    kind: "fmd",
    version: 1,
    depthEl: 1,
    initialAttempt: "wet",
    additionalAttempt1: "dry",
    additionalAttempt2: "dry",
    additionalAttempt3: "dry",
  },
  SCOUR: {
    kind: "scour",
    version: 1,
    exposedPile: "maybe",
    exposedPileHeight: null,
    heightLeg1: null,
    heightMidpoint: null,
    heightLeg2: null,
  },
};

// CTI table per code, for direct row checks
const detailTables = {
  GVI: schema.resultGvi,
  CVI: schema.resultCvi,
  MGI: schema.resultMgi,
  CP: schema.resultCp,
  FMD: schema.resultFmd,
  SCOUR: schema.resultScour,
} as const;

describe("inspections routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("start answers 201 with the result row and resolved denorm ids", async () => {
    await seedHierarchy();

    const res = await app.request("/api/v1/inspections/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startBody("CVI", { remarks: "first pass" })),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      projectId: 1,
      assetId: 11,
      componentId: 21,
      itemId: 100,
      sessionId: 101,
      inspectionTypeCode: "CVI",
      remarks: "first pass",
    });
    // no clip row — MinIO create owns it
    const clips = await testDb.select().from(schema.videoClip);
    expect(clips).toHaveLength(0);
  });

  it("start without a master recording is 409 no_master_video", async () => {
    await seedHierarchy(false);

    const res = await app.request("/api/v1/inspections/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startBody("CVI")),
    });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.code).toBe("no_master_video");
    // nothing written behind the refusal
    expect(await testDb.select().from(schema.result)).toHaveLength(0);
    expect(await testDb.select().from(schema.sessionItem)).toHaveLength(0);
  });

  it("a duplicate start on the same pair is 409 inspection_in_progress", async () => {
    await seedHierarchy();
    await startInspection("CVI");

    const res = await app.request("/api/v1/inspections/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startBody("CVI")),
    });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.code).toBe("inspection_in_progress");
  });

  it("start with an unknown type code is 400 validation_error", async () => {
    await seedHierarchy();

    const res = await app.request("/api/v1/inspections/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startBody("XYZ")),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe("validation_error");
  });

  it("active returns the open result, then null after stop", async () => {
    await seedHierarchy();
    const resultId = await startInspection("GVI");
    const query = "sessionId=101&itemId=100&inspectionTypeCode=GVI";

    const open = await app.request(`/api/v1/inspections/active?${query}`);
    expect(open.status).toBe(200);
    const openBody = await json(open);
    expect(openBody.data.resultId).toBe(resultId);

    await stopInspection(resultId, validPayloads.GVI);

    const closed = await app.request(`/api/v1/inspections/active?${query}`);
    expect(closed.status).toBe(200);
    expect((await json(closed)).data).toBeNull();
  });

  it("active never creates the session_item — an unknown pair is null", async () => {
    await seedHierarchy();

    const res = await app.request(
      "/api/v1/inspections/active?sessionId=101&itemId=100&inspectionTypeCode=GVI",
    );
    expect(res.status).toBe(200);
    expect((await json(res)).data).toBeNull();
    expect(await testDb.select().from(schema.sessionItem)).toHaveLength(0);
  });

  it("stop writes the detail, updates remarks, and answers 200", async () => {
    await seedHierarchy();
    const resultId = await startInspection("GVI");

    const res = await app.request(`/api/v1/inspections/${resultId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remarks: "done", payload: validPayloads.GVI }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.remarks).toBe("done");

    const detail = await testDb
      .select()
      .from(schema.resultGvi)
      .where(eq(schema.resultGvi.resultId, resultId));
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatchObject({ gviCP: 120, gviUT: null, condition: "ok" });
  });

  it("a payload kind that disagrees with the result is 400 payload_type_mismatch", async () => {
    await seedHierarchy();
    const resultId = await startInspection("GVI");

    const res = await stopInspection(resultId, validPayloads.CVI);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe("payload_type_mismatch");
    // the inspection stays open
    const stillOpen = await app.request(
      "/api/v1/inspections/active?sessionId=101&itemId=100&inspectionTypeCode=GVI",
    );
    expect((await json(stillOpen)).data).not.toBeNull();
  });

  it("stop on a missing result is 404 not_found", async () => {
    await seedHierarchy();

    const res = await stopInspection(999, validPayloads.GVI);
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.code).toBe("not_found");
  });

  for (const code of Object.keys(validPayloads)) {
    it(`stop accepts a valid ${code} payload`, async () => {
      await seedHierarchy();
      const resultId = await startInspection(code);

      const res = await stopInspection(resultId, validPayloads[code]);
      expect(res.status).toBe(200);

      const detail = await testDb
        .select()
        .from(detailTables[code as keyof typeof detailTables])
        .where(eq(detailTables[code as keyof typeof detailTables].resultId, resultId));
      expect(detail).toHaveLength(1);
    });

    it(`stop rejects an invalid ${code} payload`, async () => {
      await seedHierarchy();
      const resultId = await startInspection(code);

      const res = await stopInspection(resultId, invalidPayloads[code]);
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.code).toBe("validation_error");

      // nothing written — the inspection stays open with no detail row
      const detail = await testDb
        .select()
        .from(detailTables[code as keyof typeof detailTables])
        .where(eq(detailTables[code as keyof typeof detailTables].resultId, resultId));
      expect(detail).toHaveLength(0);
    });
  }

  it("cancel removes the result and answers 200", async () => {
    await seedHierarchy();
    const resultId = await startInspection("CVI");

    const res = await app.request(`/api/v1/inspections/${resultId}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.resultId).toBe(resultId);
    expect(await testDb.select().from(schema.result)).toHaveLength(0);
  });

  it("cancel on a missing result is 404 not_found", async () => {
    await seedHierarchy();

    const res = await app.request("/api/v1/inspections/999/cancel", { method: "POST" });
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.code).toBe("not_found");
  });

  it("open-inspections lists open results with clip state for the dialog", async () => {
    await seedHierarchy();
    const cviId = await startInspection("CVI");
    const gviId = await startInspection("GVI");

    // CVI gets a clip row with an open ingest (as the recorder would), GVI stays bare
    const [cviClip] = await testDb
      .insert(schema.videoClip)
      .values({
        resultId: cviId,
        masterVideoId: 1,
        startOffsetMs: 0,
      })
      .returning({ clipId: schema.videoClip.clipId });
    await testDb.insert(schema.recordingIngest).values({
      kind: "clip",
      clipId: cviClip!.clipId,
      ticketHash: "c".repeat(64),
      keyDate: "2026-09-20",
      keyPrefix: KEY_PREFIX,
    });

    const res = await app.request("/api/v1/sessions/101/open-inspections");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({
      resultId: cviId,
      itemId: 100,
      inspectionTypeCode: "CVI",
      clip: { clipId: cviClip!.clipId, capturing: true },
    });
    expect(body.data[1]).toMatchObject({ resultId: gviId, clip: null });

    // stopping one inspection removes it from the open list
    const stop = await stopInspection(cviId, validPayloads.CVI);
    expect(stop.status).toBe(200);
    const after = await json(
      await app.request("/api/v1/sessions/101/open-inspections"),
    );
    expect(after.data).toHaveLength(1);
    expect(after.data[0].resultId).toBe(gviId);
  });

  it("open-inspections on a missing session is 404", async () => {
    const res = await app.request("/api/v1/sessions/999/open-inspections");
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe("not_found");
  });

  it("open-inspections is empty for a stopped-everything session", async () => {
    await seedHierarchy();
    const resultId = await startInspection("GVI");
    expect((await stopInspection(resultId, validPayloads.GVI)).status).toBe(200);

    const res = await app.request("/api/v1/sessions/101/open-inspections");
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual([]);
  });
});
