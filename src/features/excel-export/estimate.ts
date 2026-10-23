// Size estimates for the three media levels, from real numbers.
//
// The dialog shows one figure per level and a ZIP64 flag. A clip uses its
// cached merge size, else the sum of its stored segments; images are sampled
// because statObject per image would cost a request each.
// flow: target read > image count > clip sizes > sampled averages > bytes

import type { DbOrTx } from "../../db/client";
import { env } from "../../config/env";
import { minio } from "../../lib/minio_storage/clients";
import { imageEvidenceLeaves } from "../../lib/minio_storage/paths";
import { findClipCacheRecord } from "../../db/repositories/clip-cache.repository";
import {
  findPlayableIngestRecord,
  listIngestSegmentRecords,
} from "../../db/repositories/recording-ingest.repository";
import { listVideoClipRecordsByResultIds } from "../../db/repositories/video-clip.repository";
import { listResultImageSummariesByResultIds } from "../../db/services/result-media.service";
import { loadTargets, type DatasheetTargets } from "../../db/services/datasheet-data.service";

// statObject calls behind one average. Enough to be right, cheap enough for a
// preview that must answer inside two seconds.
const SAMPLE_SIZE = 20;

// The workbook itself: a fixed cost per row plus its header and index.
const BYTES_PER_ROW = 500;
const WORKBOOK_BASE = 20 * 1024;
// One 160 px JPEG thumbnail per shipped image.
const BYTES_PER_THUMBNAIL = 8 * 1024;

export type SizeEstimate = { bytes: number; zip64: boolean };

export type ExportEstimates = {
  raw: SizeEstimate;
  images: SizeEstimate;
  clips: SizeEstimate;
};

const ZIP64_BYTES = 4 * 1024 ** 3;

const withFlag = (bytes: number): SizeEstimate => ({
  bytes: Math.round(bytes),
  zip64: bytes > ZIP64_BYTES,
});

// Mean size of the first `limit` objects, or 0 when none answer.
const sampleAverage = async (keys: string[], limit = SAMPLE_SIZE) => {
  let total = 0;
  let counted = 0;

  for (const key of keys.slice(0, limit)) {
    try {
      const stat = await minio.statObject(env.BUCKET_MEDIA, key);
      total += stat.size;
      counted++;
    } catch {
      // a missing object adds nothing to the average
    }
  }

  return counted === 0 ? 0 : total / counted;
};

// flow: results > image keys > clip sizes > three totals
export const estimateExportSizes = async (
  projectId: number,
  targets: DatasheetTargets,
  organizationId: number,
  database?: DbOrTx,
): Promise<ExportEstimates> => {
  const { sorted } = await loadTargets(projectId, targets, organizationId, database);
  const resultIds = sorted.map((row) => row.resultId);

  const [imagesByResult, clips] = await Promise.all([
    listResultImageSummariesByResultIds(resultIds, database),
    listVideoClipRecordsByResultIds(resultIds, database),
  ]);

  const imageKeys = [...imagesByResult.values()].flat().map((image) => {
    const leaves = imageEvidenceLeaves(image.storageStem, image.imageId, image.contentType);
    return image.hasAnnotated ? leaves.annotated.key : leaves.raw.key;
  });
  const imageCount = imageKeys.length;

  // a cached merge knows its own size; otherwise the segments add up
  const clipSizes: number[] = [];
  for (const clip of clips.slice(0, SAMPLE_SIZE)) {
    const ingestId = await findIngestIdForClip(clip.clipId, database);
    const cached = ingestId === null ? null : await findClipCacheRecord(ingestId, database);
    if (cached) {
      clipSizes.push(cached.sizeBytes);
      continue;
    }

    const segments = ingestId === null ? [] : await listIngestSegmentRecords(ingestId, null, database);
    clipSizes.push(segments.reduce((sum, segment) => sum + segment.sizeBytes, 0));
  }

  const averageClip =
    clipSizes.length === 0 ? 0 : clipSizes.reduce((sum, size) => sum + size, 0) / clipSizes.length;
  const clipTotal = clips.length * averageClip;

  const averageImage = imageCount === 0 ? 0 : await sampleAverage(imageKeys);

  const raw = WORKBOOK_BASE + sorted.length * BYTES_PER_ROW;
  const images = raw + imageCount * (averageImage + BYTES_PER_THUMBNAIL);
  const withClips = images + clipTotal;

  return { raw: withFlag(raw), images: withFlag(images), clips: withFlag(withClips) };
};

// The playable ingest of one clip: the same pick the merge makes.
const findIngestIdForClip = async (clipId: number, database?: DbOrTx) => {
  const ingest = await findPlayableIngestRecord({ kind: "clip", id: clipId }, database);
  return ingest?.ingestId ?? null;
};
