// The merged-clip cache: a hit skips the whole fetch and merge ladder.
//
// A row names one ingest and the segment count it merged, so a clip that grew
// since the merge misses. The object lives beside the ingest's other exports.
// flow: ingest + count > row match > touch > object read > miss on NoSuchKey

import type { DbOrTx } from "../client";
import { env } from "../../config/env";
import { log } from "../../lib/logger";
import { minio } from "../../lib/minio_storage/clients";
import {
  findClipCacheRecord,
  listStaleClipCacheRecords,
  removeClipCacheRecord,
  touchClipCacheRecord,
  upsertClipCacheRecord,
  type ClipCacheRow,
} from "../repositories/clip-cache.repository";

// A cached merge nobody asked for in a week is dropped.
export const CLIP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// `<key_prefix>/exports/merged-<segmentCount>.mkv`
export const clipCacheKey = (keyPrefix: string, segmentCount: number) =>
  `${keyPrefix}/exports/merged-${segmentCount}.mkv`;

export type ClipCacheHit = { key: string; sizeBytes: number };

// flow: row > same count? > touch > return key. A wrong count is a miss.
export const findClipCacheHit = async (
  ingestId: number,
  segmentCount: number,
  database?: DbOrTx,
): Promise<ClipCacheHit | null> => {
  const row = await findClipCacheRecord(ingestId, database);
  if (!row || row.segmentCount !== segmentCount) return null;

  // touch before the read: the sweep must never race a live read
  await touchClipCacheRecord(ingestId, database);
  return { key: row.objectKey, sizeBytes: row.sizeBytes };
};

// A hit whose object is gone: the row is wrong, so drop it and merge again.
export const dropClipCache = async (ingestId: number, database?: DbOrTx) => {
  await removeClipCacheRecord(ingestId, database);
  log.warn("clip cache row dropped", { ingestId });
};

export const storeClipCache = async (
  values: { ingestId: number; segmentCount: number; objectKey: string; sizeBytes: number },
  database?: DbOrTx,
) => upsertClipCacheRecord(values, database);

export const listClipCacheRows = (database?: DbOrTx) => listStaleClipCacheRecords(new Date(0), database);

// Retention: rows and objects unused for a week leave both stores.
export const sweepClipCache = async (database?: DbOrTx) => {
  const cutoff = new Date(Date.now() - CLIP_CACHE_TTL_MS);
  const stale: ClipCacheRow[] = await listStaleClipCacheRecords(cutoff, database);

  for (const row of stale) {
    await minio.removeObject(env.BUCKET_MEDIA, row.objectKey).catch((error) => {
      log.warn("clip cache object remove failed", { key: row.objectKey, err: String(error) });
    });
    await removeClipCacheRecord(row.ingestId, database);
  }

  return stale.length;
};
