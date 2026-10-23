// Data access for the merged-clip cache: one row per ingest.

import { asc, eq, lt } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { clipMkvCache } from "../schema";

export type ClipCacheRow = typeof clipMkvCache.$inferSelect;

export const findClipCacheRecord = async (ingestId: number, database: DbOrTx = db) =>
  (await database.select().from(clipMkvCache).where(eq(clipMkvCache.ingestId, ingestId)).limit(1))[0] ??
  null;

// A read marks the row used before the object is opened, so the sweep cannot
// delete a file a worker is about to read.
export const touchClipCacheRecord = async (ingestId: number, database: DbOrTx = db) =>
  database
    .update(clipMkvCache)
    .set({ lastUsedAt: new Date() })
    .where(eq(clipMkvCache.ingestId, ingestId));

export const upsertClipCacheRecord = async (
  values: typeof clipMkvCache.$inferInsert,
  database: DbOrTx = db,
) =>
  database
    .insert(clipMkvCache)
    .values(values)
    .onConflictDoUpdate({
      target: clipMkvCache.ingestId,
      set: {
        segmentCount: values.segmentCount,
        objectKey: values.objectKey,
        sizeBytes: values.sizeBytes,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();

export const removeClipCacheRecord = async (ingestId: number, database: DbOrTx = db) =>
  database.delete(clipMkvCache).where(eq(clipMkvCache.ingestId, ingestId));

export const listStaleClipCacheRecords = async (before: Date, database: DbOrTx = db) =>
  database
    .select()
    .from(clipMkvCache)
    .where(lt(clipMkvCache.lastUsedAt, before))
    .orderBy(asc(clipMkvCache.lastUsedAt));
