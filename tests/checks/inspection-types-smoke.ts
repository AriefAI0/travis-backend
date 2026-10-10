// Manual drill: every inspection type saves and reads back over HTTP.
//
// Build and start the stack first:  docker compose up -d --build
// Then:  bun run tests/checks/inspection-types-smoke.ts
//
// flow: seed a task chain + master > per type: start > stop with a valid
// payload > read the detail back. One PASS/FAIL line per type.

const BASE = process.env.DRILL_BASE_URL ?? "http://localhost:8788";

let failures = 0;

// one line per type: a smoke run is read at a glance
const check = (label: string, passed: boolean, detail = ""): void => {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

type Reply = { status: number; data: any };

const request = async (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Reply> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json()) as { data?: unknown } | null;
  return { status: res.status, data: (parsed?.data as any) ?? null };
};

/* one valid payload per type, in the shape the app builders emit, plus the
   read-only path that serves the saved detail back */
const TYPES: { code: string; readPath: string; payload: unknown }[] = [
  {
    code: "GVI",
    readPath: "gvi",
    payload: {
      kind: "gvi",
      version: 1,
      kpRange: "KP-1",
      depthEl: 12.5,
      gviUT: 8,
      gviCP: [{ value: 120, remark: "" }],
      condition: "ok",
    },
  },
  {
    code: "CVI",
    readPath: "cvi",
    payload: {
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
  },
  {
    code: "DVI",
    readPath: "dvi",
    payload: {
      kind: "dvi",
      version: 1,
      datumReference: "D-1",
      memberType: "chord",
      positions: [{ clockPosition: "12", utMm: 9.5, findings: "pitting" }],
      cpPotentialMv: -850,
    },
  },
  {
    code: "MGI",
    readPath: "mgi",
    payload: {
      kind: "mgi",
      version: 1,
      findings: [
        {
          id: "f1",
          growthType: "hard",
          species: "Barnacle",
          coveragePercent: 40,
          thicknessMm: 12,
          remarks: "heavy",
        },
      ],
      criteria: { preset: "client_cnc" },
      noMgObserved: false,
    },
  },
  {
    code: "CP",
    readPath: "cp",
    payload: {
      kind: "cp",
      version: 1,
      anodeType: "Aluminium",
      voltageMv: -850,
      depletion: "20%",
      anodeWidth: 900,
      anodeHeight: 100,
      anodeLength: 50,
      widestPit: 12,
      deepestPit: 18,
    },
  },
  {
    code: "FMD",
    readPath: "fmd",
    payload: {
      kind: "fmd",
      version: 1,
      depthEl: 1.5,
      initialAttempt: "dry",
      additionalAttempt1: "flooded",
      additionalAttempt2: "na",
      additionalAttempt3: "na",
    },
  },
  {
    code: "SCOUR",
    readPath: "scour",
    payload: {
      kind: "scour",
      version: 1,
      exposedPile: "exposed",
      exposedPileHeight: 0.4,
      heightLeg1: 0.4,
      heightMidpoint: 0.5,
      heightLeg2: 0.3,
    },
  },
  {
    code: "BSI",
    readPath: "bsi",
    payload: {
      kind: "bsi",
      version: 1,
      clampType: "Bolted",
      depthEl: 2.5,
      clampBoltNutQuantity: 8,
      clampMissingBolts: [],
      clampMissingWasher: [],
      outboardClampCP: -800,
      CPAnomalyRecommendation: "",
      hingePin: true,
      hingeBoltNutQuantity: 4,
      hingeMissingBolts: [{ position: "3" }],
      hingeMissingWasher: [],
      liners: true,
      inboardGapCondition: "gap",
      inboardEstimateGap: 5,
      inboardAlignmentCondition: "aligned",
      inboardMisalignedPosition: null,
      inboardAnomalyRecommendation: "",
      outboardGapCondition: "no_gap",
      outboardEstimateGap: 0,
      outboardAlignmentCondition: "misaligned",
      outboardMisalignedPosition: "top",
      outboardAnomalyRecommendation: "",
    },
  },
  {
    code: "CGB",
    readPath: "cgb",
    payload: {
      kind: "cgb",
      version: 1,
      movement: "yes",
      remark: "moved",
      debris: "no",
      debrisType: null,
    },
  },
  {
    code: "RISER",
    readPath: "riser",
    payload: {
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
  },
  {
    code: "CAISSON",
    readPath: "ci",
    payload: {
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
  },
  {
    code: "SEABED",
    readPath: "seabed",
    payload: {
      kind: "seabed",
      version: 1,
      findings: [{ rangeMeters: 12.5, fixes: "F-1", debris: "yes", debrisType: "hard" }],
    },
  },
  {
    code: "PIPELINE",
    readPath: "pipeline",
    payload: {
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
  },
];

const run = async (): Promise<void> => {
  // seed: project > group > task code > description > type > part code
  const project = await request("POST", "/api/v1/projects", { title: "zz-type-smoke" });
  check("create project", project.status === 201, `status ${project.status}`);
  const projectId = project.data.projectId as number;

  const group = await request("POST", "/api/v1/task-groups", { projectId, code: "9S1" });
  const taskCode = await request("POST", "/api/v1/task-codes", {
    taskGroupId: group.data.taskGroupId,
    code: "9S2",
  });
  const description = await request("POST", "/api/v1/descriptions", {
    taskCodeId: taskCode.data.taskCodeId,
    label: "smoke leg",
  });
  check("create task chain", description.status === 201, `status ${description.status}`);
  const descriptionId = description.data.descriptionId as number;

  // a master admits the session an inspection hangs off
  const master = await request("POST", "/api/v2/ingests", {
    kind: "master",
    projectId,
    startEpoch: 1700000000,
  });
  check("admit master recording", master.status === 201, `status ${master.status}`);
  const sessionId = master.data.domain?.sessionId as number | undefined;
  if (sessionId == null) {
    console.log("no sessionId on the master admission — cannot continue");
    process.exit(1);
  }

  for (const { code, readPath, payload } of TYPES) {
    const started = await request("POST", "/api/v1/inspections/start", {
      sessionId,
      layer: 1,
      inspectionTypeCode: code,
      descriptionId,
      masterStartMs: 0,
    });
    if (started.status !== 201) {
      check(`${code} start`, false, `status ${started.status} ${JSON.stringify(started.data)}`);
      continue;
    }

    const resultId = started.data.resultId as number;
    const stopped = await request("POST", `/api/v1/inspections/${resultId}/stop`, {
      payload,
      customValues: {},
      masterEndMs: 5000,
    });
    if (stopped.status !== 200) {
      check(`${code} stop`, false, `status ${stopped.status} ${JSON.stringify(stopped.data)}`);
      continue;
    }

    const read = await request("GET", `/api/v1/results/${resultId}/${readPath}`);
    const stored = read.status === 200 && read.data !== null;
    check(`${code} save + read back`, stored, stored ? `resultId ${resultId}` : `status ${read.status}`);
  }

  // the whole chain drops with the project, so a rerun starts clean. An open
  // ingest refuses the delete by design, so close the master first.
  const closed = await request(
    "POST",
    `/api/v2/ingests/${master.data.ingestId}/close`,
    undefined,
    { authorization: `Bearer ${master.data.ticket}` },
  );
  check("close the master ingest", closed.status === 200, `status ${closed.status}`);

  const dropped = await request("DELETE", `/api/v1/projects/${projectId}`);
  check("drop the smoke project", dropped.status === 200, `status ${dropped.status}`);

  console.log(failures === 0 ? "\nall types passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
};

await run();
