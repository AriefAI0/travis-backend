import type { ItemResultSidebarImage } from "../../types/api";
import { clipLeaves, snipImages } from "../../lib/minio_storage/paths";
import { mintGetUrl } from "../../lib/minio_storage/mint";
import type { DbOrTx } from "../client";
import {
  listResultImageRecordsByResultId,
  listResultImageRecordsByResultIds,
} from "../repositories/result-image.repository";

// mint presenters — the ONLY place media reads become presigned URLs.
// URLs expire, so they appear on freshly fetched reads, never stored DTOs.

// annotated twin wins when the column says it exists; no storage probe
export const mintImageGetUrl = (row: {
  imageId: number;
  storageStem: string;
  contentType: string;
  hasAnnotated: boolean;
}) => {
  const leaves = snipImages(row.storageStem, row.imageId, row.contentType);
  const leaf = row.hasAnnotated ? leaves.annotated : leaves.raw;
  return mintGetUrl(leaf.bucket, leaf.key);
};

// video gate: only a finalized clip has objects behind its stem. Images mint
// ungated — result_image has no status column and no processing step.
export const mintClipVideoUrl = (clip: {
  recordingStatus: string;
  storageStem: string | null;
}) => {
  if (clip.recordingStatus !== "finalized" || !clip.storageStem) return null;
  const { bucket, key } = clipLeaves(clip.storageStem).mkv;
  return mintGetUrl(bucket, key);
};

const toSummary = async (
  imageRecord: Awaited<ReturnType<typeof listResultImageRecordsByResultId>>[number],
): Promise<ItemResultSidebarImage> => ({
  imageId: imageRecord.imageId,
  storageStem: imageRecord.storageStem,
  contentType: imageRecord.contentType,
  hasAnnotated: imageRecord.hasAnnotated,
  remarks: imageRecord.remarks,
  url: await mintImageGetUrl(imageRecord),
});

export const listResultImageSummariesByResultId = async (
  resultId: number,
  database?: DbOrTx,
): Promise<ItemResultSidebarImage[]> => {
  const selectedImages = await listResultImageRecordsByResultId(
    resultId,
    database,
  );

  return Promise.all(selectedImages.map(toSummary));
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
    list.push(await toSummary(imageRecord));
    imagesByResult.set(imageRecord.resultId, list);
  }

  return imagesByResult;
};
