import type { ItemResultSidebarImage } from "../../types/api";
import type { DbOrTx } from "../client";
import {
  listResultImageRecordsByResultId,
  listResultImageRecordsByResultIds,
} from "../repositories/result-image.repository";

export const listResultImageSummariesByResultId = async (
  resultId: number,
  database?: DbOrTx,
): Promise<ItemResultSidebarImage[]> => {
  const selectedImages = await listResultImageRecordsByResultId(
    resultId,
    database,
  );

  return selectedImages.map((imageRecord) => ({
    imageId: imageRecord.imageId,
    rawUrl: imageRecord.rawUrl,
    annotatedUrl: imageRecord.annotatedUrl,
    remarks: imageRecord.remarks,
  }));
};

/**
 * Batched image-summary fetch across many results, returned as a Map keyed by
 * resultId so callers assemble per-result image lists from a single query.
 */
export const listResultImageSummariesByResultIds = async (
  resultIds: number[],
  database?: DbOrTx,
): Promise<Map<number, ItemResultSidebarImage[]>> => {
  const imagesByResult = new Map<number, ItemResultSidebarImage[]>();

  if (resultIds.length === 0) {
    return imagesByResult;
  }

  const records = await listResultImageRecordsByResultIds(resultIds, database);

  for (const imageRecord of records) {
    const list = imagesByResult.get(imageRecord.resultId) ?? [];
    list.push({
      imageId: imageRecord.imageId,
      rawUrl: imageRecord.rawUrl,
      annotatedUrl: imageRecord.annotatedUrl,
      remarks: imageRecord.remarks,
    });
    imagesByResult.set(imageRecord.resultId, list);
  }

  return imagesByResult;
};
