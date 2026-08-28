import type {
  ReportContentSignature,
  ReportGatherData,
  ReportGatherItem,
} from "../../types/api";
import type { DbOrTx } from "../client";
import { getProjectById } from "./project.service";
import { listProjectStructureTree } from "./structure.service";
import {
  getCpDetailByResultId,
  getCviDetailByResultId,
  getFmdDetailByResultId,
  getGviDetailByResultId,
  getItemResultSidebar,
  getResultMgiDetailByResultId,
  getScourDetailByResultId,
} from "./result.service";

// DB-only port of the app's reportDataGatherer walk: one server call replaces
// the app's 10+ per-item/per-result service walks. Canvas composition, row
// mapping and image reads stay app-side.

type FlatItem = {
  itemId: number;
  itemLabel: string;
  position: string | null;
  assetName: string;
  componentName: string;
};

// tree -> flat asset/component/item rows
const flattenItems = async (
  projectId: number,
  database?: DbOrTx,
): Promise<FlatItem[]> => {
  const tree = await listProjectStructureTree(projectId, database);
  const items: FlatItem[] = [];
  for (const asset of tree) {
    for (const component of asset.components) {
      for (const item of component.items) {
        items.push({
          itemId: item.itemId,
          itemLabel: item.itemLabel,
          position: item.position,
          assetName: asset.name,
          componentName: component.name,
        });
      }
    }
  }
  return items;
};

// cheap staleness fingerprint: result ids + updatedAt only
export const gatherReportSignature = async (
  projectId: number,
  database?: DbOrTx,
): Promise<ReportContentSignature> => {
  const itemIds = (await flattenItems(projectId, database)).map((item) => item.itemId);

  const resultIds: number[] = [];
  const updatedAtByResultId: Record<number, string> = {};

  for (const itemId of itemIds) {
    const sidebar = await getItemResultSidebar(itemId, database);
    if (!sidebar) continue;
    for (const session of sidebar.sessions) {
      for (const result of session.results) {
        resultIds.push(result.resultId);
        updatedAtByResultId[result.resultId] = result.updatedAt;
      }
    }
  }

  return {
    resultIds,
    updatedAtByResultId,
    generatedAt: new Date().toISOString(),
  };
};

// typed detail per result, same dispatch as the app gatherer
const gatherTypedDetail = async (
  inspectionTypeCode: "GVI" | "CVI" | "MGI" | "CP" | "FMD" | "SCOUR",
  resultId: number,
  database?: DbOrTx,
) => {
  switch (inspectionTypeCode) {
    case "CP":
      return getCpDetailByResultId(resultId, database);
    case "FMD":
      return getFmdDetailByResultId(resultId, database);
    case "SCOUR":
      return getScourDetailByResultId(resultId, database);
    case "GVI":
      return getGviDetailByResultId(resultId, database);
    case "CVI":
      return getCviDetailByResultId(resultId, database);
    case "MGI":
      return getResultMgiDetailByResultId(resultId, database);
  }
};

// full gather model: project + per-item results with typed details + signature
export const gatherReportData = async (
  projectId: number,
  database?: DbOrTx,
): Promise<ReportGatherData> => {
  const project = await getProjectById(projectId, database);
  const flatItems = await flattenItems(projectId, database);

  const resultIds: number[] = [];
  const updatedAtByResultId: Record<number, string> = {};
  const items: ReportGatherItem[] = [];

  for (const flatItem of flatItems) {
    const sidebar = await getItemResultSidebar(flatItem.itemId, database);
    if (!sidebar) continue;

    const itemResults = sidebar.sessions.flatMap((session) =>
      session.results.map((result) => ({ result, sessionName: session.sessionName })),
    );
    if (itemResults.length === 0) continue;

    const results = [];
    for (const { result, sessionName } of itemResults) {
      resultIds.push(result.resultId);
      updatedAtByResultId[result.resultId] = result.updatedAt;
      results.push({
        result,
        sessionName,
        typedDetail: await gatherTypedDetail(
          result.inspectionTypeCode,
          result.resultId,
          database,
        ),
      });
    }

    items.push({
      itemId: flatItem.itemId,
      itemLabel: flatItem.itemLabel,
      position: flatItem.position,
      assetName: flatItem.assetName,
      componentName: flatItem.componentName,
      results,
    });
  }

  return {
    project,
    items,
    signature: {
      resultIds,
      updatedAtByResultId,
      generatedAt: new Date().toISOString(),
    },
  };
};
