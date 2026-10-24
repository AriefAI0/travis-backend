import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import { createTestUser } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { resultRoutes } from "../../../src/features/results/routes";
import {
  getCurrentInspectionForm,
  saveInspectionFormVersion,
} from "../../../src/db/services/inspection-form.service";
import { getGviDetailByResultId, writeTypedDetail } from "../../../src/db/services/result.service";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, resultRoutes);
let adminToken = "";
let adminUserId = "";
let displayNumber = 7000;

const pipelineFinding = (overrides: Record<string, unknown> = {}) => ({
  category: "damage",
  damageDimensions: "10 x 10 mm",
  damageType: "dent",
  debrisType: null,
  debrisDescription: "",
  riserBendCondition: null,
  stabilizationType: "",
  stabilizationCondition: null,
  burialStart: "",
  burialEnd: "",
  freespansStart: "",
  freespansEnd: "",
  freespansLength: "",
  freespansHeight: "",
  leakType: "",
  leakDescription: "",
  crossingType: null,
  crossingContact: null,
  crossingGapDistance: "",
  crossingDamageMovement: "",
  featuresType: "",
  featuresCondition: null,
  anodeCpValue: "",
  anodeDepletion: "",
  anodeKp: "",
  remarks: "field joint",
  ...overrides,
});

const SCENARIOS = [
  {
    type: "MGI",
    readPath: "mgi",
    payload: {
      kind: "mgi",
      version: 1,
      findings: [
        {
          id: "m1",
          growthType: "soft",
          species: "Hydroids",
          speciesOtherText: null,
          coveragePercent: 40,
          thicknessMm: 18,
          remarks: "upper chord",
        },
      ],
      criteria: { preset: "project_default" },
      noMgObserved: false,
    },
  },
  {
    type: "CP",
    readPath: "cp",
    payload: {
      kind: "cp",
      version: 1,
      anodeType: "Type C",
      voltageMv: -842,
      depletion: "50 - 75%",
      anodeWidth: 180,
      anodeHeight: 95,
      anodeLength: 420,
      widestPit: 12,
      deepestPit: 4,
    },
  },
  {
    type: "FMD",
    readPath: "fmd",
    payload: {
      kind: "fmd",
      version: 1,
      depthEl: -31.2,
      initialAttempt: "dry",
      additionalAttempt1: "flooded",
      additionalAttempt2: "na",
      additionalAttempt3: "na",
    },
  },
  {
    type: "SCOUR",
    readPath: "scour",
    payload: {
      kind: "scour",
      version: 2,
      locationLeg1: "NE-01",
      locationLeg2: "SW-02",
      dimA: 420,
      dimB: 380,
      dimC: 395,
      expLeg1: "yes",
      expLeg2: "no",
      heightExpLeg1: 160,
      heightExpLeg2: null,
    },
  },
  {
    type: "GVI",
    readPath: "gvi",
    payload: {
      kind: "gvi",
      version: 1,
      depthEl: -24.6,
      gviCP: [{ value: -851, remark: "cleaned", method: "contact" }],
      mgi: [
        {
          depth: 24.6,
          softCoveragePercent: 40,
          hardCoveragePercent: 0,
          remarks: "weld growth",
        },
      ],
      condition: "not_ok",
    },
  },
  {
    type: "CVI",
    readPath: "cvi",
    payload: {
      kind: "cvi",
      version: 1,
      datumReference: "B-04",
      members: [
        {
          memberType: "chord",
          positions: [{ clockPosition: "12", utMm: 11.8, findings: "no defect" }],
        },
      ],
      cpFindings: [{ value: -860, remark: "contact probe" }],
    },
  },
  {
    type: "DVI",
    readPath: "dvi",
    payload: {
      kind: "dvi",
      version: 1,
      datumReference: "D-02",
      memberType: "brace",
      positions: [{ clockPosition: "12", utMm: 8.6, findings: "coating intact" }],
      cpPotentialMv: -855,
    },
  },
  {
    type: "BSI",
    readPath: "bsi",
    payload: {
      kind: "bsi",
      version: 1,
      clampType: "Bolted clamp",
      depthEl: -18.3,
      clampBoltNutQuantity: 8,
      clampMissingBolts: [{ position: "3" }],
      clampMissingWasher: [{ position: "3" }],
      outboardClampCP: -825,
      CPAnomalyRecommendation: "clean and retake",
      hingePin: true,
      hingeBoltNutQuantity: 4,
      hingeMissingBolts: [],
      hingeMissingWasher: [{ position: "2" }],
      liners: true,
      inboardGapCondition: "gap",
      inboardEstimateGap: 6,
      inboardAlignmentCondition: "misaligned",
      inboardMisalignedPosition: "top",
      inboardAnomalyRecommendation: "measure the gap",
      outboardGapCondition: "no_gap",
      outboardEstimateGap: null,
      outboardAlignmentCondition: "aligned",
      outboardMisalignedPosition: null,
      outboardAnomalyRecommendation: "",
    },
  },
  {
    type: "CGB",
    readPath: "cgb",
    payload: {
      kind: "cgb",
      version: 1,
      movement: "yes",
      remark: "40 mm lateral",
      debris: "yes",
      debrisType: "scrap steel",
    },
  },
  {
    type: "RISER",
    readPath: "riser",
    payload: {
      kind: "riser",
      version: 1,
      touchdownDistanceFromRiserBend: 4.8,
      riserBendDistanceToMudbraceMember: 2.1,
      riserBendHeightToSeabed: 1.6,
      coatingStatus: "present",
      coatingCondition: "peel-off",
      kneeBrace: "yes",
      debris: "yes",
      debrisType: "fine sediment",
      anomaly: "yes",
      recommendation: "clean and inspect",
      restrictedAccess: "no",
    },
  },
  {
    type: "CAISSON",
    readPath: "ci",
    payload: {
      kind: "ci",
      version: 1,
      cpFindings: [{ cpMv: -865, remarks: "upper body" }],
      visualDamage: true,
      visualDamageRecommendation: "inspect the weld",
      debrisPresent: true,
      debrisRecommendation: "remove debris",
      gratingPresent: true,
      gratingBlockage: "50_75",
      gratingAnomalyRecommendation: "clear grating",
      gviAssociatedPipes: [{ position: "North face" }],
      associatedPipesRecommendation: "inspect both",
    },
  },
  {
    type: "SEABED",
    readPath: "seabed",
    payload: {
      kind: "seabed",
      version: 1,
      findings: [
        { rangeMeters: 12.5, fixes: "F-102", debris: "yes", debrisType: "wire rope" },
        { rangeMeters: 18, fixes: "F-103", debris: "no", debrisType: "" },
      ],
    },
  },
  {
    type: "PIPELINE",
    readPath: "pipeline",
    payload: {
      kind: "pipeline",
      version: 1,
      location: "KP 12.4",
      depthEl: 28.5,
      orientation: "3_oclock",
      findings: [pipelineFinding()],
    },
  },
] as const;

const seedBase = async () => {
  await testDb.insert(schema.project).values({
    organizationId: testOrgId,
    displayNumber: 1,
    projectId: 1,
    title: "Alpha",
  });
  await testDb.insert(schema.session).values({
    displayNumber: 1,
    sessionId: 101,
    projectId: 1,
    name: "Run 1",
  });
  await testDb.insert(schema.taskGroup).values({
    taskGroupId: 10,
    projectId: 1,
    code: "100",
  });
  await testDb.insert(schema.taskCode).values({
    taskCodeId: 20,
    taskGroupId: 10,
    code: "101",
  });
  await testDb.insert(schema.description).values({
    descriptionId: 100,
    taskCodeId: 20,
    label: "Row A",
  });
};

// completed row plus its first typed detail; returns the stale-check timestamp
const seedCompleted = async (
  inspectionTypeCode: string,
  payload: unknown,
): Promise<{ resultId: number; updatedAt: string }> => {
  const form = await getCurrentInspectionForm(1, inspectionTypeCode, testDb);
  const rows = await testDb
    .insert(schema.result)
    .values({
      inspectionTypeCode: inspectionTypeCode as "GVI",
      displayNumber: displayNumber++,
      projectId: 1,
      sessionId: 101,
      descriptionId: 100,
      layer: 1,
      masterStartMs: 0,
      masterEndMs: 4000,
      inspectionFormId: form.inspectionFormId,
      submittedPayload: payload,
    })
    .returning();
  const row = rows[0]!;
  await writeTypedDetail(row.inspectionTypeCode, payload, row.resultId, testDb);
  return { resultId: row.resultId, updatedAt: row.updatedAt.toISOString() };
};

const patchResult = (resultId: number, body: unknown) =>
  app.request(`/api/v1/results/${resultId}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const correction = (payload: unknown, expectedUpdatedAt: string) => ({
  payload,
  remarks: "admin correction",
  customValues: {},
  expectedUpdatedAt,
});

describe("admin result correction", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(async () => {
    await truncateTestDatabase();
    const admin = await createTestUser({ preset: "Admin" });
    adminToken = admin.token;
    adminUserId = admin.userId;
    await seedBase();
  });

  for (const scenario of SCENARIOS) {
    it(`round trips a ${scenario.type} correction`, async () => {
      const { resultId, updatedAt } = await seedCompleted(scenario.type, scenario.payload);

      const res = await patchResult(resultId, correction(scenario.payload, updatedAt));
      expect(res.status).toBe(200);
      const saved = (await json(res)).data as Record<string, any>;
      expect(saved.submittedPayload).toEqual(scenario.payload);
      expect(saved.remarks).toBe("admin correction");
      expect(saved.inspectionForm).toMatchObject({
        inspectionFormId: saved.inspectionFormId,
        inspectionTypeCode: scenario.type,
      });

      const read = await app.request(`/api/v1/results/${resultId}/${scenario.readPath}`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(read.status).toBe(200);
      expect((await json(read)).data).not.toBeNull();
    });
  }

  it("keeps clip markers when a completed result is corrected", async () => {
    const scenario = SCENARIOS.find((item) => item.type === "GVI")!;
    const { resultId, updatedAt } = await seedCompleted(scenario.type, scenario.payload);
    await testDb.insert(schema.videoClip).values({
      clipId: 9901,
      resultId,
      sessionId: 101,
      startOffsetMs: 0,
      endOffsetMs: 4000,
    });
    await testDb.insert(schema.clipEventMarker).values({ clipId: 9901, positionMs: 2100 });

    const res = await patchResult(resultId, correction(scenario.payload, updatedAt));
    expect(res.status).toBe(200);

    const markers = await testDb.query.clipEventMarker.findMany();
    expect(markers.map((marker) => marker.positionMs)).toEqual([2100]);
  });

  it("rejects a stale write without changing the saved payload", async () => {
    const scenario = SCENARIOS.find((item) => item.type === "GVI")!;
    const { resultId, updatedAt } = await seedCompleted(scenario.type, scenario.payload);

    const first = await patchResult(resultId, correction(scenario.payload, updatedAt));
    expect(first.status).toBe(200);

    const stale = await patchResult(resultId, correction(scenario.payload, updatedAt));
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe("result_conflict");

    const row = await testDb.query.result.findFirst({
      where: eq(schema.result.resultId, resultId),
    });
    expect(row?.submittedPayload).toEqual(scenario.payload);
  });

  it("leaves typed rows unchanged when the payload fails validation", async () => {
    const scenario = SCENARIOS.find((item) => item.type === "GVI")!;
    const { resultId, updatedAt } = await seedCompleted(scenario.type, scenario.payload);

    const res = await patchResult(resultId, {
      ...correction({ kind: "cp", version: 1 }, updatedAt),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("payload_invalid");

    const detail = await getGviDetailByResultId(resultId, testDb);
    expect(detail?.cpFindings).toHaveLength(1);
    expect(detail?.mgi?.findings).toHaveLength(1);
  });

  it("keeps custom values on the pinned form and rejects an unknown field", async () => {
    await saveInspectionFormVersion(
      1,
      "GVI",
      [{ label: "Clamp note", dataType: "text", required: true, displayOrder: 0 }],
      { userId: adminUserId, organizationId: testOrgId },
      testDb,
    );
    const scenario = SCENARIOS.find((item) => item.type === "GVI")!;
    const { resultId, updatedAt } = await seedCompleted(scenario.type, scenario.payload);
    const form = await getCurrentInspectionForm(1, "GVI", testDb);
    const field = form.fields.find((entry) => entry.label === "Clamp note")!;

    const unknown = await patchResult(resultId, {
      ...correction(scenario.payload, updatedAt),
      customValues: { "999999": "x" },
    });
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).code).toBe("custom_value_invalid");

    const saved = await patchResult(resultId, {
      ...correction(scenario.payload, updatedAt),
      customValues: { [String(field.inspectionFormFieldId)]: "surface corrosion" },
    });
    expect(saved.status).toBe(200);
    expect(((await json(saved)).data as Record<string, any>).customValues).toEqual({
      [String(field.inspectionFormFieldId)]: "surface corrosion",
    });
  });

  it("does not touch another result", async () => {
    const scenario = SCENARIOS.find((item) => item.type === "GVI")!;
    const first = await seedCompleted(scenario.type, scenario.payload);
    const second = await seedCompleted(scenario.type, scenario.payload);

    const res = await patchResult(first.resultId, correction(scenario.payload, first.updatedAt));
    expect(res.status).toBe(200);

    const untouched = await testDb.query.result.findFirst({
      where: eq(schema.result.resultId, second.resultId),
    });
    expect(untouched?.updatedAt.toISOString()).toBe(second.updatedAt);
  });
});
