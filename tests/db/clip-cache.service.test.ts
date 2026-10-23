import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";
import {
  CLIP_CACHE_TTL_MS,
  clipCacheKey,
  findClipCacheHit,
  storeClipCache,
  sweepClipCache,
} from "../../src/db/services/clip-cache.service";
import { findClipCacheRecord } from "../../src/db/repositories/clip-cache.repository";

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

const PREFIX = "org/project/session/clips/1-gvi";

// one clip ingest, the row the cache hangs off
const seedIngest = async () => {
  await testDb.insert(schema.project).values({
    organizationId: testOrgId,
    projectId: 1,
    displayNumber: 1,
    title: "Alpha",
  });
  await testDb.insert(schema.session).values({ sessionId: 101, projectId: 1, displayNumber: 1, name: "Run 1" });
  await testDb.insert(schema.recordingIngest).values({
    ingestId: 42,
    kind: "master",
    sessionId: 101,
    ticketHash: "ticket",
    keyDate: "2026-10-24",
    keyPrefix: PREFIX,
  });
};

describe("clip cache", () => {
  it("names the object after the ingest prefix and its segment count", () => {
    expect(clipCacheKey(PREFIX, 12)).toBe(`${PREFIX}/exports/merged-12.mkv`);
  });

  it("hits a stored merge and touches it", async () => {
    await seedIngest();
    await storeClipCache(
      { ingestId: 42, segmentCount: 12, objectKey: clipCacheKey(PREFIX, 12), sizeBytes: 4096 },
      testDb,
    );

    const hit = await findClipCacheHit(42, 12, testDb);

    expect(hit).toEqual({ key: `${PREFIX}/exports/merged-12.mkv`, sizeBytes: 4096 });
  });

  it("misses when the clip grew since the merge", async () => {
    await seedIngest();
    await storeClipCache(
      { ingestId: 42, segmentCount: 12, objectKey: clipCacheKey(PREFIX, 12), sizeBytes: 4096 },
      testDb,
    );

    expect(await findClipCacheHit(42, 13, testDb)).toBeNull();
  });

  it("drops the row with its ingest", async () => {
    await seedIngest();
    await storeClipCache(
      { ingestId: 42, segmentCount: 12, objectKey: clipCacheKey(PREFIX, 12), sizeBytes: 4096 },
      testDb,
    );

    await testDb.delete(schema.recordingIngest).where(eq(schema.recordingIngest.ingestId, 42));

    expect(await findClipCacheRecord(42, testDb)).toBeNull();
  });

  it("sweeps a row unused for a week", async () => {
    await seedIngest();
    await storeClipCache(
      { ingestId: 42, segmentCount: 12, objectKey: clipCacheKey(PREFIX, 12), sizeBytes: 4096 },
      testDb,
    );
    await testDb
      .update(schema.clipMkvCache)
      .set({ lastUsedAt: new Date(Date.now() - CLIP_CACHE_TTL_MS - 1_000) });

    expect(await sweepClipCache(testDb)).toBe(1);
    expect(await findClipCacheRecord(42, testDb)).toBeNull();
  });

  it("keeps a row used inside the week", async () => {
    await seedIngest();
    await storeClipCache(
      { ingestId: 42, segmentCount: 12, objectKey: clipCacheKey(PREFIX, 12), sizeBytes: 4096 },
      testDb,
    );

    expect(await sweepClipCache(testDb)).toBe(0);
    expect(await findClipCacheRecord(42, testDb)).not.toBeNull();
  });
});
