import type { ItemResultSidebarImage } from "../../types/api";
import { env } from "../../config/env";
import { imageLeavesUnder } from "../../lib/minio_storage/paths";
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
  const leaves = imageLeavesUnder(row.storageStem, row.imageId, row.contentType);
  const leaf = row.hasAnnotated ? leaves.annotated : leaves.raw;
  return mintGetUrl(leaf.bucket, leaf.key);
};

// Card still for a master list row: the thumbnail job stores the object key
// itself, so the read mints straight from it. Null until the job has run.
export const mintTimelineThumbnailUrl = async (thumbnailKey: string | null) =>
  thumbnailKey ? mintGetUrl(env.BUCKET_MEDIA, thumbnailKey) : null;

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
