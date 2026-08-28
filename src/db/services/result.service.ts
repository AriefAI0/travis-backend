import type { CpDetail, CviDetail, FmdDetail, ScourDetail, GviDetail, InspectionTypeCode, ItemResultSidebarData, ProjectResultSummaryRow, ResultEvidence, ResultMgiWithFindings, ResultSummaryDetail, CpPayloadInput, CviPayloadInput, FmdPayloadInput, MgiPayloadInput, GviPayloadInput, ScourPayloadInput } from "../../types/api";
import { inspectionPayloadSchema } from "../../types/api";
import { formatResultValue } from "../../types/result-format";
import { db, type DbOrTx } from "../client";
import { AppError } from "../../lib/error";
import {
  listResultImageSummariesByResultIds,
  mintClipVideoUrl,
  mintRecordingThumbnailUrl,
} from "./result-media.service";
import { getItemById } from "./structure.service";
import { listSessionItemsByItemId, listSessionsByIds } from "./session.service";
import { listVideoClipPlaybackByResultIds } from "./video.service";
import {
  createResultRecord,
  deleteResultById,
  findResultById,
  listResultRecords,
  listResultRecordsByProjectId,
  listResultRecordsBySessionId,
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
 * Dispatcher for typed detail tables (result_mgi, result_cp, result_fmd,
 * result_scour, result_gvi, result_cvi). Parses the payload union, rejects a
 * kind that disagrees with the result's inspection type, then writes through.
 */
export const writeTypedDetail = async (
  inspectionTypeCode: "GVI" | "CVI" | "MGI" | "CP" | "FMD" | "SCOUR",
  payload: unknown,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  const parsed = inspectionPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue ? issue.path.join(".") : "";
    throw new AppError(
      400,
      "payload_invalid",
      `payload: ${path ? `${path}: ` : ""}${issue?.message ?? "does not match any inspection payload shape"}`,
    );
  }

  const data = parsed.data;
  if (data.kind.toUpperCase() !== inspectionTypeCode) {
    throw new AppError(
      400,
      "payload_type_mismatch",
      `result ${resultId} expects a ${inspectionTypeCode} payload, got kind "${data.kind}"`,
    );
  }

  switch (data.kind) {
    case "mgi":
      return writeMgiDetail(data, resultId, database);
    case "cp":
      return writeCpDetail(data, resultId, database);
    case "fmd":
      return writeFmdDetail(data, resultId, database);
    case "scour":
      return writeScourDetail(data, resultId, database);
    case "gvi":
      return writeGviDetail(data, resultId, database);
    case "cvi":
      return writeCviDetail(data, resultId, database);
  }
};

/**
 * MGI detail writer (Phase 3)
 */
const writeMgiDetail = async (
  payload: MgiPayloadInput,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  // flow: insert result_mgi > insert findings, one tx
  const run = async (tx: DbOrTx): Promise<void> => {
    const resultMgi = await createResultMgi(
      {
        resultId,
        noMgObserved: payload.noMgObserved ? 1 : 0,
        criteriaPreset: payload.criteria.preset,
      },
      tx,
    );

    if (!resultMgi) {
      throw new Error("Failed to create MGI detail");
    }

    // Insert findings
    for (const [i, finding] of payload.findings.entries()) {
      await createResultMgiFinding(
        {
          resultMgiId: resultMgi.resultId,
          growthType: finding.growthType,
          species: finding.species,
          speciesOtherText: finding.speciesOtherText ?? null,
          coveragePercent: finding.coveragePercent,
          thicknessMm: finding.thicknessMm,
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
  payload: CpPayloadInput,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  await createResultCp(
    {
      resultId,
      anodeType: payload.anodeType,
      voltageMv: payload.voltageMv,
      depletion: payload.depletion,
      anodeWidth: payload.anodeWidth ?? null,
      anodeHeight: payload.anodeHeight ?? null,
      anodeLength: payload.anodeLength ?? null,
      widestPit: payload.widestPit ?? null,
      deepestPit: payload.deepestPit ?? null,
    },
    database,
  );
};

/**
 * FMD detail writer (Phase 5)
 */
const writeFmdDetail = async (
  payload: FmdPayloadInput,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  await createResultFmd(
    {
      resultId,
      depthEl: payload.depthEl,
      initialAttempt: payload.initialAttempt,
      additionalAttempt1: payload.additionalAttempt1,
      additionalAttempt2: payload.additionalAttempt2,
      additionalAttempt3: payload.additionalAttempt3,
    },
    database,
  );
};

/**
 * Scour detail writer (Phase 5)
 */
const writeScourDetail = async (
  payload: ScourPayloadInput,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  await createResultScour(
    {
      resultId,
      exposedPile: payload.exposedPile,
      exposedPileHeight: payload.exposedPileHeight,
      heightLeg1: payload.heightLeg1,
      heightMidpoint: payload.heightMidpoint,
      heightLeg2: payload.heightLeg2,
    },
    database,
  );
};

/**
 * GVI detail writer (Phase 6)
 */
const writeGviDetail = async (
  payload: GviPayloadInput,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  await createResultGvi(
    {
      resultId,
      gviCP: payload.gviCP ?? null,
      gviUT: payload.gviUT ?? null,
      condition: payload.condition,
    },
    database,
  );
};

/**
 * CVI detail writer (Phase 6)
 */
const writeCviDetail = async (
  payload: CviPayloadInput,
  resultId: number,
  database?: DbOrTx,
): Promise<void> => {
  // flow: insert result_cvi > insert positions, one tx
  const run = async (tx: DbOrTx): Promise<void> => {
    await createResultCvi(
      {
        resultId,
        datumReference: payload.datumReference,
        memberType: payload.memberType,
        cpPotentialMv: payload.cpPotentialMv,
      },
      tx,
    );

    for (const [index, position] of payload.positions.entries()) {
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

export const listResultsBySessionId = async (
  sessionId: number,
  database?: DbOrTx,
) => listResultRecordsBySessionId(sessionId, database);

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
    sessions: await Promise.all(
      sessionItems.map(async (sessionItemRecord) => {
      const sessionRecord = sessionById.get(sessionItemRecord.sessionId);
      const itemResults =
        resultsBySessionItemId.get(sessionItemRecord.sessionItemId) ?? [];

      return {
        sessionId: sessionItemRecord.sessionId,
        sessionItemId: sessionItemRecord.sessionItemId,
        sessionName: sessionRecord?.name ?? null,
        results: await Promise.all(itemResults.map(async (resultRecord) => {
          // summaries arrive ordered by imageId asc, so [0] IS the poster
          const entryImages = imagesByResultId.get(resultRecord.resultId) ?? [];

          return {
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
            images: entryImages,
            posterUrl: entryImages[0]?.url ?? null,
            clips: await Promise.all(
              (clipsByResultId.get(resultRecord.resultId) ?? []).map(
                async (clipPlayback) => ({
                  clipId: clipPlayback.clipId,
                  resultId: clipPlayback.resultId,
                  storageStem: clipPlayback.storageStem,
                  recordingStatus: clipPlayback.recordingStatus,
                  startOffsetMs: clipPlayback.startOffsetMs,
                  endOffsetMs: clipPlayback.endOffsetMs,
                  durationMs: clipPlayback.durationMs,
                  startEpochMs: clipPlayback.startEpochMs,
                  endEpochMs: clipPlayback.endEpochMs,
                  videoUrl: await mintClipVideoUrl(clipPlayback),
                  thumbnailUrl: await mintRecordingThumbnailUrl(clipPlayback),
                }),
              ),
            ),
          };
        })),
      };
      }),
    ),
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

  const clips = await Promise.all(
    (clipsByResultId.get(resultId) ?? []).map(async (clipPlayback) => ({
      clipId: clipPlayback.clipId,
      resultId: clipPlayback.resultId,
      storageStem: clipPlayback.storageStem,
      recordingStatus: clipPlayback.recordingStatus,
      startOffsetMs: clipPlayback.startOffsetMs,
      endOffsetMs: clipPlayback.endOffsetMs,
      durationMs: clipPlayback.durationMs,
      startEpochMs: clipPlayback.startEpochMs,
      endEpochMs: clipPlayback.endEpochMs,
      videoUrl: await mintClipVideoUrl(clipPlayback),
      thumbnailUrl: await mintRecordingThumbnailUrl(clipPlayback),
    })),
  );

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
