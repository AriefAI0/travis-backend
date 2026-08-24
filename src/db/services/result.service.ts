import type { CpDetail, CviDetail, FmdDetail, ScourDetail, GviDetail, InspectionTypeCode, ItemResultSidebarData, ProjectResultSummaryRow, ResultEvidence, ResultMgiWithFindings, ResultSummaryDetail } from "../../types/api";
import { formatResultValue } from "../../types/result-format";
import { db, type DbOrTx } from "../client";
import { listResultImageSummariesByResultIds } from "./result-media.service";
import { getItemById } from "./structure.service";
import { listSessionItemsByItemId, listSessionsByIds } from "./session.service";
import { listVideoClipPlaybackByResultIds } from "./video.service";
import {
  createResultRecord,
  deleteResultById,
  findResultById,
  listResultRecords,
  listResultRecordsByProjectId,
  listResultRecordsBySessionItemId,
  listResultRecordsBySessionItemIds,
  updateResultById,
} from "../repositories/result.repository";
import {
  createResultImageRecord,
  deleteResultImageById,
  findResultImageById,
  listResultImageRecords,
  listResultImageRecordsByResultId,
  updateResultImageById,
} from "../repositories/result-image.repository";
import { result, resultImage } from "../schema";

export type CreateResultInput = {
  sessionItemId: number;
  inspectionTypeCode: "GVI" | "CVI" | "MGI" | "CP" | "FMD" | "SCOUR";
  projectId: number;
  assetId: number;
  componentId: number;
  itemId: number;
  sessionId: number;
  remarks?: string | null;
};

export type CreateResultImageInput = {
  resultId: number;
  // required: keys derive from the stem alone (no URL column remains)
  storageStem: string;
  remarks?: string | null;
};

const normalizeOptionalText = (value?: string | null) => {
  const trimmedValue = value?.trim();

  return trimmedValue ? trimmedValue : null;
};

const normalizeResultUpdate = (
  data: Partial<typeof result.$inferInsert>,
): Partial<typeof result.$inferInsert> => {
  const nextData: Partial<typeof result.$inferInsert> = {};

  if ("sessionItemId" in data) {
    nextData.sessionItemId = data.sessionItemId;
  }

  if ("inspectionTypeCode" in data) {
    nextData.inspectionTypeCode = data.inspectionTypeCode;
  }

  if ("projectId" in data) {
    nextData.projectId = data.projectId;
  }

  if ("assetId" in data) {
    nextData.assetId = data.assetId;
  }

  if ("componentId" in data) {
    nextData.componentId = data.componentId;
  }

  if ("itemId" in data) {
    nextData.itemId = data.itemId;
  }

  if ("sessionId" in data) {
    nextData.sessionId = data.sessionId;
  }

  if ("remarks" in data) {
    nextData.remarks = normalizeOptionalText(data.remarks);
  }

  return nextData;
};

const normalizeResultImageUpdate = (
  data: Partial<typeof resultImage.$inferInsert>,
): Partial<typeof resultImage.$inferInsert> => {
  const nextData: Partial<typeof resultImage.$inferInsert> = {};

  if ("resultId" in data) {
    nextData.resultId = data.resultId;
  }

  if ("storageStem" in data) {
    if (data.storageStem === undefined || !data.storageStem.trim()) {
      throw new Error("Result image storage stem is required");
    }

    nextData.storageStem = data.storageStem;
  }

  if ("remarks" in data) {
    nextData.remarks = normalizeOptionalText(data.remarks);
  }

  return nextData;
};

import {
  createResultCp,
  getResultCpByResultId,
  listResultCpByResultIds,
} from "../repositories/result-cp.repository";
import {
  createResultFmd,
  getResultFmdByResultId,
  listResultFmdByResultIds,
} from "../repositories/result-fmd.repository";
import {
  createResultScour,
  getResultScourByResultId,
  listResultScourByResultIds,
} from "../repositories/result-scour.repository";
import {
  createResultGvi,
  getResultGviByResultId,
  listResultGviByResultIds,
} from "../repositories/result-gvi.repository";

import {
  createResultCvi,
  getResultCviByResultId,
  listResultCviByResultIds,
} from "../repositories/result-cvi.repository";
import { 
  createResultCviPosition,
  getResultCviPositions,
} from "../repositories/result-cvi-position.repository";

import {
  createResultMgi,
  createResultMgiFinding,
  getResultMgiByResultId as fetchResultMgiByResultId,
  listResultMgiFindingsByResultMgiId,
  listResultMgiSummaryByResultIds,
} from "../repositories/result-mgi.repository";

/**
 * Dispatcher for typed detail tables (result_mgi, result_cp, result_fmd, result_gvi, result_cvi).
 * Phase 3 implements MGI branch; Phase 4 implements CP branch; Phase 5 implements FMD branch; Phase 6 implements GVI/CVI branches.
 */
export const writeTypedDetail = async (
  inspectionTypeCode: "GVI" | "CVI" | "MGI" | "CP" | "FMD" | "SCOUR",
  payload: unknown,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  if (inspectionTypeCode === "MGI") {
    // MGI branch implemented in Phase 3
    return writeMgiDetail(payload, resultId, database);
  }

  if (inspectionTypeCode === "CP") {
    // CP branch implemented in Phase 4
    return writeCpDetail(payload, resultId, database);
  }

  if (inspectionTypeCode === "FMD") {
    // FMD branch implemented in Phase 5
    return writeFmdDetail(payload, resultId, database);
  }

  if (inspectionTypeCode === "SCOUR") {
    // SCOUR branch implemented in Phase 5
    return writeScourDetail(payload, resultId, database);
  }

  if (inspectionTypeCode === "GVI") {
    // GVI branch implemented in Phase 6
    return writeGviDetail(payload, resultId, database);
  }

  if (inspectionTypeCode === "CVI") {
    // CVI branch implemented in Phase 6
    return writeCviDetail(payload, resultId, database);
  }

  return Promise.resolve();
};

/**
 * MGI detail writer (Phase 3)
 */
const writeMgiDetail = async (
  payload: unknown,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  // Parse MGI payload
  const mgiPayload = payload as {
    kind: "mgi";
    version: 1;
    findings: Array<{
      id: string;
      growthType: "soft" | "hard";
      species: string;
      speciesOtherText?: string;
      coveragePercent?: number;
      thicknessMm?: number;
      remarks?: string;
    }>;
    criteria: {
      preset: "project_default" | "client_cnc" | "manual";
    };
    noMgObserved: boolean;
  };

  const criteria = mgiPayload.criteria;

  // flow: insert result_mgi > insert findings, one tx
  const run = async (tx: DbOrTx): Promise<void> => {
    const resultMgi = await createResultMgi(
      {
        resultId,
        noMgObserved: mgiPayload.noMgObserved ? 1 : 0,
        criteriaPreset: criteria.preset,
      },
      tx,
    );

    if (!resultMgi) {
      throw new Error("Failed to create MGI detail");
    }

    // Insert findings
    for (const [i, finding] of mgiPayload.findings.entries()) {
      await createResultMgiFinding(
        {
          resultMgiId: resultMgi.resultId,
          growthType: finding.growthType,
          species: finding.species,
          speciesOtherText: finding.speciesOtherText ?? null,
          coveragePercent: finding.coveragePercent ?? null,
          thicknessMm: finding.thicknessMm ?? null,
          remarks: finding.remarks ?? null,
          sortOrder: i,
        },
        tx,
      );
    }
  };

  return database ? run(database) : db.transaction(run);
};

/**
 * CP detail writer (Phase 4)
 */
const writeCpDetail = async (
  payload: unknown,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  // Parse CP payload
  const cpPayload = payload as {
    kind: "cp";
    version: 1;
    anodeType: string;
    voltageMv: number;
    depletion?: string;
    anodeWidth?: number;
    anodeHeight?: number;
    anodeLength?: number;
    widestPit?: number;
    deepestPit?: number;
  };

  await createResultCp(
    {
      resultId,
      anodeType: cpPayload.anodeType,
      voltageMv: cpPayload.voltageMv,
      depletion: cpPayload.depletion,
      anodeWidth: cpPayload.anodeWidth,
      anodeHeight: cpPayload.anodeHeight,
      anodeLength: cpPayload.anodeLength,
      widestPit: cpPayload.widestPit,
      deepestPit: cpPayload.deepestPit
    },
    database,
  );
};

/**
 * FMD detail writer (Phase 5)
 */
const writeFmdDetail = async (
  payload: unknown,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  const FmdPayload = payload as {
    kind: "fmd";
    version: 1;
    depthEl: number;
    initialAttempt: "dry" | "flooded" | "na"
    additionalAttempt1: "dry" | "flooded" | "na"
    additionalAttempt2: "dry" | "flooded" | "na"
    additionalAttempt3: "dry" | "flooded" | "na"
  };

  await createResultFmd(
    {
      resultId,
      depthEl: FmdPayload.depthEl,
      initialAttempt: FmdPayload.initialAttempt,
      additionalAttempt1: FmdPayload.additionalAttempt1,
      additionalAttempt2: FmdPayload.additionalAttempt2,
      additionalAttempt3: FmdPayload.additionalAttempt3,
    },
    database,
  );
};

/**
 * Scour detail writer (Phase 5)
 */
const writeScourDetail = async (
  payload: unknown,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  const ScourPayload = payload as {
    kind: "scour";
    version: 1;
    exposedPile: "exposed" | "not_exposed";
    exposedPileHeight: number | null;
    heightLeg1: number | null;
    heightMidpoint: number | null;
    heightLeg2: number | null;
  };

  await createResultScour(
    {
      resultId,
      exposedPile: ScourPayload.exposedPile,
      exposedPileHeight: ScourPayload.exposedPileHeight,
      heightLeg1: ScourPayload.heightLeg1,
      heightMidpoint: ScourPayload.heightMidpoint,
      heightLeg2: ScourPayload.heightLeg2,
    },
    database,
  );
};

/**
 * GVI detail writer (Phase 6)
 */
const writeGviDetail = async (
  payload: unknown,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  // Parse GVI payload
  const gviPayload = payload as {
    kind: "gvi";
    version: 1;
    gviCP: number | null;
    gviUT: number | null;
    condition: "ok" | "not_ok";
  };

  await createResultGvi(
    {
      resultId,
      gviCP: gviPayload.gviCP,
      gviUT: gviPayload.gviUT,
      condition: gviPayload.condition,
    },
    database,
  );
};

/**
 * CVI detail writer (Phase 6)
 */
const writeCviDetail = async (
  payload: unknown,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  // Parse CVI payload
  const cviPayload = payload as {
    kind: "cvi";
    version: 1;
    
    datumReference: string;
    memberType: "chord" | "brace";

    positions: Array<{
      clockPosition: string;
      utMm: number | null;
      findings: string | null;
    }>;
    cpPotentialMv: number | null;
  };

  // flow: insert result_cvi > insert positions, one tx
  const run = async (tx: DbOrTx): Promise<void> => {
    await createResultCvi(
      {
        resultId,
        datumReference: cviPayload.datumReference,
        memberType: cviPayload.memberType,
        cpPotentialMv: cviPayload.cpPotentialMv,
      },
      tx,
    );

    for (const [index, position] of cviPayload.positions.entries()) {
      await createResultCviPosition(
        {
          resultId,
          clockPosition: position.clockPosition,
          utMm: position.utMm,
          findings: position.findings,
          sortOrder: index,
        },
        tx,
      );
    }
  };

  return database ? run(database) : db.transaction(run);
};

export const createResult = async (
  data: CreateResultInput,
  database?: DbOrTx,
) =>
  createResultRecord(
    {
      sessionItemId: data.sessionItemId,
      inspectionTypeCode: data.inspectionTypeCode,
      projectId: data.projectId,
      assetId: data.assetId,
      componentId: data.componentId,
      itemId: data.itemId,
      sessionId: data.sessionId,
      remarks: normalizeOptionalText(data.remarks),
    },
    database,
  );

export const listResults = async (database?: DbOrTx) =>
  listResultRecords(database);

export const getResultById = async (resultId: number, database?: DbOrTx) =>
  findResultById(resultId, database);

const toIsoString = (value: Date) => value.toISOString();

export const listResultsBySessionItemId = async (
  sessionItemId: number,
  database?: DbOrTx,
) => listResultRecordsBySessionItemId(sessionItemId, database);

export const getItemResultSidebar = async (
  itemId: number,
  database?: DbOrTx,
): Promise<ItemResultSidebarData | null> => {
  const selectedItem = await getItemById(itemId, database);

  if (!selectedItem) {
    return null;
  }

  const sessionItems = await listSessionItemsByItemId(itemId, database);
  const sessionItemIds = sessionItems.map(
    (sessionItem) => sessionItem.sessionItemId,
  );
  const sessionIds = [
    ...new Set(sessionItems.map((sessionItem) => sessionItem.sessionId)),
  ];

  // Round 1: sessions + results in parallel. Results are needed to key round 2.
  const [sessions, results] = await Promise.all([
    listSessionsByIds(sessionIds, database),
    listResultRecordsBySessionItemIds(sessionItemIds, database),
  ]);

  const resultIds = results.map((resultRecord) => resultRecord.resultId);

  // Round 2: images + clip playback in parallel, each a single batched query.
  // The previous implementation issued these per session_item / per result
  // (2 + 2*S + 2*S*R queries); this is 6 total regardless of row count.
  const [imagesByResultId, clipsByResultId] = await Promise.all([
    listResultImageSummariesByResultIds(resultIds, database),
    listVideoClipPlaybackByResultIds(resultIds, database),
  ]);

  const sessionById = new Map(
    sessions.map((session) => [session.sessionId, session]),
  );
  const resultsBySessionItemId = new Map<number, typeof results>();
  for (const resultRecord of results) {
    const bucket = resultsBySessionItemId.get(resultRecord.sessionItemId) ?? [];
    bucket.push(resultRecord);
    resultsBySessionItemId.set(resultRecord.sessionItemId, bucket);
  }

  return {
    itemId: selectedItem.itemId,
    itemLabel: selectedItem.itemLabel,
    position: selectedItem.position,
    status: selectedItem.status,
    sessions: sessionItems.map((sessionItemRecord) => {
      const sessionRecord = sessionById.get(sessionItemRecord.sessionId);
      const itemResults =
        resultsBySessionItemId.get(sessionItemRecord.sessionItemId) ?? [];

      return {
        sessionId: sessionItemRecord.sessionId,
        sessionItemId: sessionItemRecord.sessionItemId,
        sessionName: sessionRecord?.name ?? null,
        results: itemResults.map((resultRecord) => ({
          resultId: resultRecord.resultId,
          inspectionTypeCode: resultRecord.inspectionTypeCode,
          inspectionTypeName: resultRecord.inspectionTypeCode, // Same value (code is canonical)
          projectId: resultRecord.projectId,
          assetId: resultRecord.assetId,
          componentId: resultRecord.componentId,
          itemId: resultRecord.itemId,
          sessionId: resultRecord.sessionId,
          remarks: resultRecord.remarks,
          createdAt: toIsoString(resultRecord.createdAt),
          updatedAt: toIsoString(resultRecord.updatedAt),
          images: imagesByResultId.get(resultRecord.resultId) ?? [],
          clips: (clipsByResultId.get(resultRecord.resultId) ?? []).map(
            (clipPlayback) => ({
              clipId: clipPlayback.clipId,
              resultId: clipPlayback.resultId,
              storageStem: clipPlayback.storageStem,
              startOffsetMs: clipPlayback.startOffsetMs,
              endOffsetMs: clipPlayback.endOffsetMs,
              durationMs: clipPlayback.durationMs,
              startEpochMs: clipPlayback.startEpochMs,
              endEpochMs: clipPlayback.endEpochMs,
            }),
          ),
        })),
      };
    }),
  };
};

export const updateResult = async (
  resultId: number,
  data: Partial<typeof result.$inferInsert>,
  database?: DbOrTx,
) => updateResultById(resultId, normalizeResultUpdate(data), database);

/* =========================================================
   Event recorder — project results summary + result evidence
   ========================================================= */

export const listProjectSummary = async (
  projectId: number,
  database?: DbOrTx,
): Promise<ProjectResultSummaryRow[]> => {
  if (!Number.isInteger(projectId) || projectId < 1) {
    throw new Error("Project id must be a positive integer");
  }

  const results = await listResultRecordsByProjectId(projectId, database);

  if (results.length === 0) {
    return [];
  }

  // Group resultIds by code so each typed-detail table is read once (≤5 queries
  // regardless of row count) — same round-1/round-2 batching shape as getItemResultSidebar.
  const resultIdsByCode: Record<InspectionTypeCode, number[]> = {
    GVI: [],
    CVI: [],
    MGI: [],
    CP: [],
    FMD: [],
    SCOUR: [],
  };
  for (const resultRecord of results) {
    resultIdsByCode[resultRecord.inspectionTypeCode].push(resultRecord.resultId);
  }

  const [gvi, cvi, mgi, cp, fmd, scour] = await Promise.all([
    listResultGviByResultIds(resultIdsByCode.GVI, database),
    listResultCviByResultIds(resultIdsByCode.CVI, database),
    listResultMgiSummaryByResultIds(resultIdsByCode.MGI, database),
    listResultCpByResultIds(resultIdsByCode.CP, database),
    listResultFmdByResultIds(resultIdsByCode.FMD, database),
    listResultScourByResultIds(resultIdsByCode.SCOUR, database),
  ]);

  const detailFor = (
    resultRecord: (typeof results)[number],
  ): ResultSummaryDetail | null => {
    switch (resultRecord.inspectionTypeCode) {
      case "GVI": {
        const detail = gvi.get(resultRecord.resultId);
        return detail ? { condition: detail.condition } : null;
      }
      case "CVI": {
        const detail = cvi.get(resultRecord.resultId);
        return detail ? { 
          datumReference: detail.datumReference,
          memberType: detail.memberType,
          cpPotentialMv: detail.cpPotentialMv,
         } : null;
      }
      case "CP": {
        const detail = cp.get(resultRecord.resultId);
        return detail ? { 
          anodeType: detail.anodeType, 
          voltageMv: detail.voltageMv, 
          depletion: detail.depletion,
          anodeWidth: detail.anodeWidth,
          anodeHeight: detail.anodeHeight,
          anodeLength: detail.anodeLength,
          widestPit: detail.widestPit,
          deepestPit: detail.deepestPit 
        } : null;
      }
      case "FMD": {
        const detail = fmd.get(resultRecord.resultId);
        return detail ? { 
          initialAttempt: detail.initialAttempt,
         } : null;
      }
      case "SCOUR": {
        const detail = scour.get(resultRecord.resultId);
        return detail ? { 
          exposedPile: detail.exposedPile,
         } : null;
      }
      case "MGI": {
        const detail = mgi.get(resultRecord.resultId);
        return detail
          ? { noMgObserved: detail.noMgObserved, findingCount: detail.findingCount }
          : null;
      }
    }
  };

  return results.map((resultRecord) => ({
    resultId: resultRecord.resultId,
    createdAt: toIsoString(resultRecord.createdAt),
    inspectionTypeCode: resultRecord.inspectionTypeCode,
    assetId: resultRecord.assetId,
    componentId: resultRecord.componentId,
    itemId: resultRecord.itemId,
    remarks: resultRecord.remarks,
    resultValue: formatResultValue(
      resultRecord.inspectionTypeCode,
      detailFor(resultRecord),
    ),
  }));
};

export const getResultEvidence = async (
  resultId: number,
  database?: DbOrTx,
): Promise<ResultEvidence> => {
  if (!Number.isInteger(resultId) || resultId < 1) {
    throw new Error("Result id must be a positive integer");
  }

  const [clipsByResultId, imagesByResultId] = await Promise.all([
    listVideoClipPlaybackByResultIds([resultId], database),
    listResultImageSummariesByResultIds([resultId], database),
  ]);

  const clips = (clipsByResultId.get(resultId) ?? []).map((clipPlayback) => ({
    clipId: clipPlayback.clipId,
    resultId: clipPlayback.resultId,
    storageStem: clipPlayback.storageStem,
    startOffsetMs: clipPlayback.startOffsetMs,
    endOffsetMs: clipPlayback.endOffsetMs,
    durationMs: clipPlayback.durationMs,
    startEpochMs: clipPlayback.startEpochMs,
    endEpochMs: clipPlayback.endEpochMs,
  }));

  return {
    clips,
    images: imagesByResultId.get(resultId) ?? [],
  };
};

/**
 * Bump only result.updatedAt. Report staleness (ReportContentSignature /
 * isReportStale) keys on updatedAt, so evidence-image changes must advance it
 * or the report will not auto-regenerate. updateResultById sets updatedAt
 * unconditionally, so an empty payload still moves the timestamp.
 */
export const touchResult = async (resultId: number, database?: DbOrTx) =>
  updateResultById(resultId, {}, database);

export const deleteResult = async (resultId: number, database?: DbOrTx) =>
  deleteResultById(resultId, database);

export const createResultImage = async (
  data: CreateResultImageInput,
  database?: DbOrTx,
) =>
  createResultImageRecord(
    {
      resultId: data.resultId,
      storageStem: data.storageStem,
      remarks: normalizeOptionalText(data.remarks),
    },
    database,
  );

export const listResultImages = async (database?: DbOrTx) =>
  listResultImageRecords(database);

export const getResultImageById = async (
  imageId: number,
  database?: DbOrTx,
) => findResultImageById(imageId, database);

export const listResultImagesByResultId = async (
  resultId: number,
  database?: DbOrTx,
) => listResultImageRecordsByResultId(resultId, database);

export const updateResultImage = async (
  imageId: number,
  data: Partial<typeof resultImage.$inferInsert>,
  database?: DbOrTx,
) => updateResultImageById(imageId, normalizeResultImageUpdate(data), database);

export const deleteResultImage = async (
  imageId: number,
  database?: DbOrTx,
) => deleteResultImageById(imageId, database);

/* =========================================================
   MGI readback (Phase 3)
   ========================================================= */

export const getResultMgiDetailByResultId = async (
  resultId: number,
  database?: DbOrTx,
): Promise<ResultMgiWithFindings | null> => {
  const resultMgi = await fetchResultMgiByResultId(resultId, database);
  if (!resultMgi) {
    return null;
  }

  const findings = await listResultMgiFindingsByResultMgiId(resultMgi.resultId, database);

  return {
    detail: {
      ...resultMgi,
      createdAt: toIsoString(resultMgi.createdAt),
      updatedAt: toIsoString(resultMgi.updatedAt),
    },
    findings: findings.map((f) => ({
      ...f,
      createdAt: toIsoString(f.createdAt),
      updatedAt: toIsoString(f.updatedAt),
    })),
  };
};

/* =========================================================
   CP readback (Phase 4)
   ========================================================= */

export const getCpDetailByResultId = async (
  resultId: number,
  database?: DbOrTx,
): Promise<CpDetail | null> => {
  const resultCp = await getResultCpByResultId(resultId, database);
  if (!resultCp) {
    return null;
  }

  return {
    ...resultCp,
    createdAt: toIsoString(resultCp.createdAt),
    updatedAt: toIsoString(resultCp.updatedAt),
  };
};

/* =========================================================
   FMD readback (Phase 5)
   ========================================================= */

export const getFmdDetailByResultId = async (
  resultId: number,
  database?: DbOrTx,
): Promise<FmdDetail | null> => {
  const resultFmd = await getResultFmdByResultId(resultId, database);
  if (!resultFmd) {
    return null;
  }

  return {
    ...resultFmd,
    createdAt: toIsoString(resultFmd.createdAt),
    updatedAt: toIsoString(resultFmd.updatedAt),
  };
};

/* =========================================================
   SCOUR readback (Phase 5)
   ========================================================= */

export const getScourDetailByResultId = async (
  resultId: number,
  database?: DbOrTx,
): Promise<ScourDetail | null> => {
  const resultScour = await getResultScourByResultId(resultId, database);
  if (!resultScour) {
    return null;
  }

  return {
    ...resultScour,
    createdAt: toIsoString(resultScour.createdAt),
    updatedAt: toIsoString(resultScour.updatedAt),
  };
};


/* =========================================================
   GVI readback (Phase 6)
   ========================================================= */

export const getGviDetailByResultId = async (
  resultId: number,
  database?: DbOrTx,
): Promise<GviDetail | null> => {
  const resultGvi = await getResultGviByResultId(resultId, database);
  if (!resultGvi) {
    return null;
  }

  return {
    ...resultGvi,
    createdAt: toIsoString(resultGvi.createdAt),
    updatedAt: toIsoString(resultGvi.updatedAt),
  };
};

/* =========================================================
   CVI readback (Phase 6)
   ========================================================= */

export const getCviDetailByResultId = async (
  resultId: number,
  database?: DbOrTx,
): Promise<CviDetail | null> => {
  const resultCvi = await getResultCviByResultId(resultId, database);
  if (!resultCvi) {
    return null;
  }

  const positions = await getResultCviPositions(
    resultId,
    database,
  );

  return {
    ...resultCvi,
    positions,
    createdAt: toIsoString(resultCvi.createdAt),
    updatedAt: toIsoString(resultCvi.updatedAt),
  };
};
