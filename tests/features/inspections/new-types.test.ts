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
import { inspectionRoutes } from "../../../src/features/inspections/routes";
import { resultRoutes } from "../../../src/features/results/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, inspectionRoutes, resultRoutes);

// minted per test in beforeEach; a result detail read now carries it
let resultToken = "";

const post = async (path: string, body: unknown) =>
  authRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// project > task group > task code > description target > type > part code,
// plus a session with a capturing master so start passes its guards
const seedWorld = async () => {
  await testDb.insert(schema.project).values({ organizationId: testOrgId, displayNumber: 1, projectId: 1, title: "Alpha" });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 10, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 20, taskGroupId: 10, code: "101" });
  await testDb.insert(schema.description).values({ descriptionId: 30, taskCodeId: 20, label: "Row A" });
  await testDb.insert(schema.type).values({ typeId: 50, descriptionId: 30, code: "VDM" });
  await testDb.insert(schema.partCode).values({ partCodeId: 60, typeId: 50, code: "101-105" });
  await testDb.insert(schema.session).values({
    displayNumber: 1,
    sessionId: 101,
    projectId: 1,
    name: "Run 1",
    startEpoch: 1000,
  });
  await testDb.insert(schema.recordingIngest).values({
    kind: "master",
    sessionId: 101,
    ticketHash: "b".repeat(64),
    keyDate: "2026-09-24",
    keyPrefix: "1/1/1/2026/09/24/master/1",
  });
};

const startInspection = (inspectionTypeCode: string) =>
  post("/api/v1/inspections/start", {
    sessionId: 101,
    layer: 1,
    inspectionTypeCode,
    descriptionId: 30,
    masterStartMs: 0,
  });

const stopInspection = (resultId: number, payload: unknown) =>
  post(`/api/v1/inspections/${resultId}/stop`, {
    payload,
    customValues: {},
    masterEndMs: 5000,
  });

/* one scenario per type: a payload the schema accepts, a payload it must
   refuse, and the read-only path that serves the detail back */
const SCENARIOS = [
  {
    // the shape buildGviPayload emits: CP is a findings list, KP and UT scalars
    type: "GVI",
    readPath: "gvi",
    valid: {
      kind: "gvi",
      version: 1,
      kpRange: "KP-1",
      depthEl: 12.5,
      gviUT: 8,
      gviCP: [{ value: 120, remark: "" }],
      condition: "ok",
    },
    // the current form omits KP range and UT, and adds an MGI findings list
    omitted: {
      kind: "gvi",
      version: 1,
      depthEl: 12.5,
      gviCP: [{ value: 120, remark: "low" }],
      mgi: [
        {
          depth: 3,
          softCoveragePercent: 20,
          hardCoveragePercent: 10,
          remarks: "barnacles",
        },
      ],
      condition: "ok",
    },
    // condition is ok|not_ok
    invalid: {
      kind: "gvi",
      version: 1,
      kpRange: null,
      depthEl: null,
      gviUT: null,
      gviCP: [],
      condition: "maybe",
    },
  },
  {
    // the shape buildCviPayload emits: positions group under their member
    type: "CVI",
    readPath: "cvi",
    valid: {
      kind: "cvi",
      version: 1,
      datumReference: "D-1",
      members: [
        {
          memberType: "chord",
          positions: [{ clockPosition: "12", utMm: 9.5, findings: "pitting" }],
        },
      ],
      cpFindings: [{ value: -850, remark: "" }],
    },
    // datumReference is min(1)
    invalid: {
      kind: "cvi",
      version: 1,
      datumReference: "",
      members: [],
      cpFindings: [],
    },
  },
  {
    type: "DVI",
    readPath: "dvi",
    valid: {
      kind: "dvi",
      version: 1,
      datumReference: "D-1",
      memberType: "chord",
      positions: [{ clockPosition: "12", utMm: 9.5, findings: "pitting" }],
      cpPotentialMv: -850,
    },
    // datumReference is min(1)
    invalid: {
      kind: "dvi",
      version: 1,
      datumReference: "",
      memberType: "chord",
      positions: [],
      cpPotentialMv: null,
    },
  },
  {
    type: "CGB",
    readPath: "cgb",
    valid: { kind: "cgb", version: 1, movement: "yes", remark: "moved", debris: "no", debrisType: null },
    // movement is yes|no
    invalid: { kind: "cgb", version: 1, movement: "maybe", remark: null, debris: null, debrisType: null },
  },
  {
    type: "RISER",
    readPath: "riser",
    valid: {
      kind: "riser",
      version: 1,
      touchdownDistanceFromRiserBend: 1.5,
      riserBendDistanceToMudbraceMember: 2.5,
      riserBendHeightToSeabed: 3.5,
      coatingStatus: "present",
      coatingCondition: "good",
      kneeBrace: "yes",
      debris: "no",
      debrisType: "",
      anomaly: "no",
      recommendation: "",
      restrictedAccess: "no",
    },
    // coatingStatus is present|not-present
    invalid: {
      kind: "riser",
      version: 1,
      touchdownDistanceFromRiserBend: null,
      riserBendDistanceToMudbraceMember: null,
      riserBendHeightToSeabed: null,
      coatingStatus: "broken",
      coatingCondition: null,
      kneeBrace: null,
      debris: null,
      debrisType: "",
      anomaly: null,
      recommendation: "",
      restrictedAccess: null,
    },
  },
  {
    // CAISSON is the tricky one: kind "ci" maps to the CAISSON code
    type: "CAISSON",
    readPath: "ci",
    valid: {
      kind: "ci",
      version: 1,
      cpFindings: [{ cpMv: -900, remarks: "low" }],
      visualDamage: false,
      visualDamageRecommendation: "",
      debrisPresent: true,
      debrisRecommendation: "clear it",
      gratingPresent: true,
      gratingBlockage: "25_50",
      gratingAnomalyRecommendation: "",
      gviAssociatedPipes: [{ position: "P-1" }],
      associatedPipesRecommendation: "inspect both",
    },
    // gratingBlockage is a band enum
    invalid: {
      kind: "ci",
      version: 1,
      cpFindings: [],
      visualDamage: null,
      visualDamageRecommendation: "",
      debrisPresent: null,
      debrisRecommendation: "",
      gratingPresent: null,
      gratingBlockage: "half",
      gratingAnomalyRecommendation: "",
      gviAssociatedPipes: [],
      associatedPipesRecommendation: "",
    },
  },
  {
    type: "SEABED",
    readPath: "seabed",
    valid: {
      kind: "seabed",
      version: 1,
      findings: [{ rangeMeters: 12.5, fixes: "F-1", debris: "yes", debrisType: "hard" }],
    },
    // debris is yes|no
    invalid: {
      kind: "seabed",
      version: 1,
      findings: [{ rangeMeters: 1, fixes: "", debris: "maybe", debrisType: "" }],
    },
  },
  {
    type: "PIPELINE",
    readPath: "pipeline",
    valid: {
      kind: "pipeline",
      version: 1,
      location: "KP-1",
      depthEl: 2.5,
      orientation: "12_oclock",
      findings: [
        {
          category: "damage",
          damageDimensions: "10x10",
          damageType: "crack",
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
          remarks: "",
        },
      ],
    },
    // category is a fixed list
    invalid: {
      kind: "pipeline",
      version: 1,
      location: "KP-1",
      depthEl: null,
      orientation: null,
      findings: [
        {
          category: "not_a_category",
          damageDimensions: "",
          damageType: null,
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
          remarks: "",
        },
      ],
    },
  },
] as const;

// flow: start > stop with a valid payload > readback; then stop with a bad payload
describe("new inspection types", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(async () => {
    await truncateTestDatabase();
    resultToken = (await createTestUser({ preset: "Operator" })).token;
  });

  for (const scenario of SCENARIOS) {
    it(`saves and reads back a ${scenario.type} result`, async () => {
      await seedWorld();

      const started = await startInspection(scenario.type);
      expect(started.status).toBe(201);
      const resultId = (await json(started)).data.resultId as number;

      const stopped = await stopInspection(resultId, scenario.valid);
      expect(stopped.status).toBe(200);

      const read = await authRequest(`/api/v1/results/${resultId}/${scenario.readPath}`);
      expect(read.status).toBe(200);
      expect((await json(read)).data).not.toBeNull();
    });

    it(`refuses an invalid ${scenario.type} payload`, async () => {
      await seedWorld();

      const started = await startInspection(scenario.type);
      expect(started.status).toBe(201);
      const resultId = (await json(started)).data.resultId as number;

      const stopped = await stopInspection(resultId, scenario.invalid);
      expect(stopped.status).toBe(400);
    });
  }

  // both shapes land: fields the current form omits, and fields it still sends
  for (const scenario of SCENARIOS) {
    if (!("omitted" in scenario)) continue;

    it(`accepts a ${scenario.type} payload with the optional keys omitted`, async () => {
      await seedWorld();

      const started = await startInspection(scenario.type);
      expect(started.status).toBe(201);
      const resultId = (await json(started)).data.resultId as number;

      const stopped = await stopInspection(resultId, scenario.omitted);
      expect(stopped.status).toBe(200);
    });
  }

  it("refuses a payload whose kind does not match the result type", async () => {
    await seedWorld();

    const started = await startInspection("CGB");
    const resultId = (await json(started)).data.resultId as number;

    // a well-formed GVI payload on a CGB result
    const stopped = await stopInspection(resultId, {
      kind: "gvi",
      version: 1,
      depthEl: 1,
      gviCP: [{ value: 1, remark: "" }],
      condition: "ok",
    });
    expect(stopped.status).toBe(400);
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
