import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import * as schema from "../../../src/db/schema";
import {
  admitIngest,
  hashTicket,
  parseSegmentContentLength,
  parseSegmentHeaders,
  SEGMENT_MAX_BYTES,
  SEGMENT_TARGET_MS,
  storeIngestSegment,
  type SegmentStorage,
} from "../../../src/features/recording/ingest-service";

// project > session, plus the chain a result needs
const seedDomain = async () => {
  await testDb.insert(schema.project).values({ displayNumber: 9200, projectId: 9200, title: "P" });
  await testDb.insert(schema.session).values({ displayNumber: 1, sessionId: 9200, projectId: 9200, name: "S" });
  await testDb.insert(schema.taskGroup).values({
    taskGroupId: 9200,
    projectId: 9200,
    code: "100",
    label: "Rows",
  });
  await testDb.insert(schema.taskCode).values({
    taskCodeId: 9200,
    taskGroupId: 9200,
    code: "101",
    label: "Row A",
  });
  await testDb.insert(schema.description).values({
    descriptionId: 9200,
    taskCodeId: 9200,
    label: "I",
  });
  // session_item is gone: v2 results carry their own target
  await testDb.insert(schema.result).values({
    displayNumber: 9200,
    resultId: 9200,
    inspectionTypeCode: "GVI",
        descriptionId: 9200,
        layer: 1,
        masterStartMs: 0,
    projectId: 9200,
    sessionId: 9200,
  });
};

// 2026-09-20T23:59:59Z — the key date must not follow the next segment over midnight
const LATE_NIGHT_EPOCH = Math.floor(Date.parse("2026-09-20T23:59:59.000Z") / 1000);

const sha256Hex = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex");

const segmentBody = (label: string, size = 2048) => {
  const body = new Uint8Array(size);
  for (let i = 0; i < size; i++) body[i] = (label.charCodeAt(0) + i) & 0xff;
  return body;
};

// records every put and can be told to fail, proving MinIO-before-row ordering
const fakeStorage = () => {
  const puts: { bucket: string; key: string; size: number }[] = [];
  const storage: SegmentStorage = {
    put: async (bucket, key, body) => {
      puts.push({ bucket, key, size: body.byteLength });
    },
  };
  return { puts, storage };
};

const segmentRequest = (
  ingestId: number,
  ticket: string,
  sequence: number,
  body: Uint8Array,
  extra: Record<string, string> = {},
) => {
  const headers = new Headers({
    "x-segment-sequence": String(sequence),
    "x-segment-duration-ms": "2000",
    "x-segment-checksum-sha256": sha256Hex(body),
    ...extra,
  });
  return {
    ingestId,
    authorization: `Bearer ${ticket}`,
    headers: parseSegmentHeaders(headers),
    contentLength: parseSegmentContentLength(
      new Headers({ ...Object.fromEntries(headers), "content-length": String(body.byteLength) }),
    ),
    body,
  };
};

describe("direct ingest admission", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
    await seedDomain();
  });

  test("master admission mints a session, a master row, and an ingest row", async () => {
    const admission = await admitIngest(
      { kind: "master", projectId: 9200, startEpoch: LATE_NIGHT_EPOCH },
      testDb,
    );

    expect(admission.segmentTargetMs).toBe(SEGMENT_TARGET_MS);
    expect(admission.domain).toEqual({
      kind: "master",
      sessionId: expect.any(Number),
      projectId: 9200,
    });
    expect(admission.ticket.length).toBeGreaterThan(20);

    const [master] = await testDb
      .select()
      .from(schema.session)
      .where(sql`${schema.session.sessionId} = ${admission.domain.sessionId}`);
    expect(master!.sessionId).toBe(admission.domain.sessionId);
    expect(master!.startEpoch).toBe(LATE_NIGHT_EPOCH);

    const [ingest] = await testDb.select().from(schema.recordingIngest);
    expect(ingest!.ingestId).toBe(admission.ingestId);
    expect(ingest!.kind).toBe("master");
    expect(ingest!.sessionId).toBe(admission.domain.sessionId);
    expect(ingest!.clipId).toBeNull();
    expect(ingest!.keyDate).toBe("2026-09-20");
    // readable prefix, frozen here: project slug, display number, UTC start
    // the seeded session is ordinal 1, so this admission mints ordinal 2
    expect(ingest!.keyPrefix).toBe("9200-p-2026-09-20/session-2-2026-09-20-2359/master-video");
    expect(ingest!.closedAt).toBeNull();
    expect(ingest!.contiguousSequence).toBe(-1);
  });

  test("clip admission links the result, the master, and the master's date", async () => {
    const master = await admitIngest(
      { kind: "master", projectId: 9200, startEpoch: LATE_NIGHT_EPOCH },
      testDb,
    );
    if (master.domain.kind !== "master") throw new Error("expected a master domain");

    const clip = await admitIngest(
      {
        kind: "clip",
        resultId: 9200,
        sessionId: master.domain.sessionId,
        startOffsetMs: 4000,
      },
      testDb,
    );

    if (clip.domain.kind !== "clip") throw new Error("expected a clip domain");
    expect(clip.domain).toEqual({
      kind: "clip",
      clipId: expect.any(Number),
      resultId: 9200,
      sessionId: master.domain.sessionId,
      projectId: 9200,
    });

    const [clipRow] = await testDb
      .select()
      .from(schema.videoClip)
      .where(sql`${schema.videoClip.clipId} = ${clip.domain.clipId}`);
    expect(clipRow!.resultId).toBe(9200);
    expect(clipRow!.startOffsetMs).toBe(4000);

    const [ingest] = await testDb
      .select()
      .from(schema.recordingIngest)
      .where(sql`${schema.recordingIngest.ingestId} = ${clip.ingestId}`);
    expect(ingest!.kind).toBe("clip");
    expect(ingest!.clipId).toBe(clip.domain.clipId);
    expect(ingest!.sessionId).toBeNull();
    // the clip inherits the master's key date, not its own wall clock
    expect(ingest!.keyDate).toBe("2026-09-20");
    // and its folder nests under the same session root, naming the item. The
    // number is the RESULT's ordinal (9200 here), never the clip's own id.
    expect(ingest!.keyPrefix).toBe(
      "9200-p-2026-09-20/session-2-2026-09-20-2359/clips/9200-i-gvi",
    );
    expect(ingest!.keyPrefix).not.toContain(`/${clip.domain.clipId}-i-gvi`);
  });

  test("a second clip admission is refused while the first ingest stays open", async () => {
    const master = await admitIngest(
      { kind: "master", projectId: 9200, startEpoch: LATE_NIGHT_EPOCH },
      testDb,
    );
    if (master.domain.kind !== "master") throw new Error("expected a master domain");
    const body = {
      kind: "clip" as const,
      resultId: 9200,
      sessionId: master.domain.sessionId,
      startOffsetMs: 4000,
    };

    await admitIngest(body, testDb);
    await expect(admitIngest(body, testDb)).rejects.toThrow(/open ingest/i);

    // one clip row per result survives the refusal
    const clips = await testDb.select().from(schema.videoClip);
    expect(clips).toHaveLength(1);
    const ingests = await testDb.select().from(schema.recordingIngest);
    expect(ingests).toHaveLength(2); // master + clip, never a third
  });

  test("the raw ticket reaches no column — only its digest", async () => {
    const admission = await admitIngest(
      { kind: "master", projectId: 9200, startEpoch: LATE_NIGHT_EPOCH },
      testDb,
    );

    const [ingest] = await testDb.select().from(schema.recordingIngest);
    expect(ingest!.ticketHash).toBe(hashTicket(admission.ticket));
    for (const value of Object.values(ingest!)) {
      expect(String(value)).not.toBe(admission.ticket);
    }

    // the returned ticket never equals the stored digest, so no read-back exists
    expect(admission.ticket).not.toBe(ingest!.ticketHash);
    expect(ingest!.ticketHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("each admission mints a distinct ingest id and ticket", async () => {
    const first = await admitIngest(
      { kind: "master", projectId: 9200, startEpoch: LATE_NIGHT_EPOCH },
      testDb,
    );
    const second = await admitIngest(
      { kind: "master", projectId: 9200, startEpoch: LATE_NIGHT_EPOCH + 60 },
      testDb,
    );

    expect(first.ingestId).not.toBe(second.ingestId);
    expect(first.ticket).not.toBe(second.ticket);
  });

  test("unknown parents are 404 and no ingest row survives the failure", async () => {
    const master = await admitIngest(
      { kind: "master", projectId: 9200, startEpoch: LATE_NIGHT_EPOCH },
      testDb,
    );
    if (master.domain.kind !== "master") throw new Error("expected a master domain");

    await expect(
      admitIngest(
        { kind: "clip", resultId: 9999, sessionId: master.domain.sessionId, startOffsetMs: 0 },
        testDb,
      ),
    ).rejects.toThrow(/Result not found/i);

    await expect(
      admitIngest({ kind: "clip", resultId: 9200, sessionId: 9999, startOffsetMs: 0 }, testDb),
    ).rejects.toThrow(/Session not found/i);

    const ingests = await testDb.select().from(schema.recordingIngest);
    expect(ingests).toHaveLength(1); // the master only
  });

  // one admitted master ingest, ready for segment traffic
  const admitMasterForSegments = async () => {
    const admission = await admitIngest(
      { kind: "master", projectId: 9200, startEpoch: LATE_NIGHT_EPOCH },
      testDb,
    );
    if (admission.domain.kind !== "master") throw new Error("expected a master domain");
    return admission;
  };

  const ingestKeyPrefix = async () => {
    const [ingest] = await testDb.select().from(schema.recordingIngest);
    return ingest!.keyPrefix;
  };

  test("one segment creates one object, one row, and advances the prefix", async () => {
    const admission = await admitMasterForSegments();
    const { puts, storage } = fakeStorage();
    const body = segmentBody("a");

    const outcome = await storeIngestSegment(
      { ...segmentRequest(admission.ingestId, admission.ticket, 0, body), storage },
      testDb,
    );

    expect(outcome.replayed).toBe(false);
    expect(outcome.contiguousSequence).toBe(0);
    expect(outcome.durationMs).toBe(2000);

    // the object lands under the prefix admission froze, not a re-derived one
    const expectedKey = `${await ingestKeyPrefix()}/segments/0000000000.ts`;
    expect(puts).toEqual([{ bucket: "travis-media", key: expectedKey, size: body.byteLength }]);

    const [row] = await testDb.select().from(schema.recordingIngestSegment);
    expect(row!.sequence).toBe(0);
    expect(row!.objectKey).toBe(expectedKey);
    expect(row!.sizeBytes).toBe(body.byteLength);
    expect(row!.durationMs).toBe(2000);
    expect(row!.discontinuity).toBe(false);

    const [ingest] = await testDb.select().from(schema.recordingIngest);
    expect(ingest!.contiguousSequence).toBe(0);
    expect(ingest!.durationMs).toBe(2000);
    expect(ingest!.lastSegmentAt).not.toBeNull();
  });

  test("a byte-identical replay writes no second object and no second row", async () => {
    const admission = await admitMasterForSegments();
    const { puts, storage } = fakeStorage();
    const body = segmentBody("a");
    const request = { ...segmentRequest(admission.ingestId, admission.ticket, 0, body), storage };

    await storeIngestSegment(request, testDb);
    const replay = await storeIngestSegment(request, testDb);

    expect(replay.replayed).toBe(true);
    expect(puts).toHaveLength(1);
    expect(await testDb.select().from(schema.recordingIngestSegment)).toHaveLength(1);
  });

  test("the same sequence with different bytes is a conflict", async () => {
    const admission = await admitMasterForSegments();
    const { puts, storage } = fakeStorage();

    await storeIngestSegment(
      { ...segmentRequest(admission.ingestId, admission.ticket, 0, segmentBody("a")), storage },
      testDb,
    );

    await expect(
      storeIngestSegment(
        { ...segmentRequest(admission.ingestId, admission.ticket, 0, segmentBody("b")), storage },
        testDb,
      ),
    ).rejects.toThrow(/already holds different bytes/i);
    expect(puts).toHaveLength(1);
  });

  test("a hole stops the prefix, and a late fill recomputes the whole duration", async () => {
    const admission = await admitMasterForSegments();
    const { storage } = fakeStorage();
    const store = (sequence: number, durationMs = 2000) =>
      storeIngestSegment(
        {
          ...segmentRequest(admission.ingestId, admission.ticket, sequence, segmentBody("s"), {
            "x-segment-duration-ms": String(durationMs),
          }),
          storage,
        },
        testDb,
      );

    expect((await store(0)).contiguousSequence).toBe(0);

    // sequence 2 lands first: the prefix stops at the hole
    const late = await store(2, 1500);
    expect(late.contiguousSequence).toBe(0);
    expect(late.durationMs).toBe(2000);

    // filling the hole pulls sequence 2 into the prefix and re-sums
    const filled = await store(1, 2500);
    expect(filled.contiguousSequence).toBe(2);
    expect(filled.durationMs).toBe(6000);
  });

  test("a wrong ticket is refused and nothing is written", async () => {
    const admission = await admitMasterForSegments();
    const { puts, storage } = fakeStorage();
    const other = await admitMasterForSegments();

    await expect(
      storeIngestSegment(
        {
          ...segmentRequest(admission.ingestId, other.ticket, 0, segmentBody("a")),
          storage,
        },
        testDb,
      ),
    ).rejects.toThrow(/does not match this ingest/i);

    expect(puts).toHaveLength(0);
    expect(await testDb.select().from(schema.recordingIngestSegment)).toHaveLength(0);
  });

  test("a closed ingest answers 410", async () => {
    const admission = await admitMasterForSegments();
    const { puts, storage } = fakeStorage();

    await testDb
      .update(schema.recordingIngest)
      .set({ closedAt: new Date(), finalSequence: -1 })
      .where(sql`${schema.recordingIngest.ingestId} = ${admission.ingestId}`);

    await expect(
      storeIngestSegment(
        { ...segmentRequest(admission.ingestId, admission.ticket, 0, segmentBody("a")), storage },
        testDb,
      ),
    ).rejects.toThrow(/closed at sequence/i);

    expect(puts).toHaveLength(0);
    expect(await testDb.select().from(schema.recordingIngestSegment)).toHaveLength(0);
  });

  test("a refused storage write leaves the database untouched", async () => {
    const admission = await admitMasterForSegments();
    const failing: SegmentStorage = {
      put: async () => {
        throw new Error("minio unreachable");
      },
    };

    await expect(
      storeIngestSegment(
        { ...segmentRequest(admission.ingestId, admission.ticket, 0, segmentBody("a")), storage: failing },
        testDb,
      ),
    ).rejects.toThrow(/minio unreachable/i);

    expect(await testDb.select().from(schema.recordingIngestSegment)).toHaveLength(0);
    const [ingest] = await testDb.select().from(schema.recordingIngest);
    expect(ingest!.contiguousSequence).toBe(-1);
    expect(ingest!.durationMs).toBeNull();
    expect(ingest!.lastSegmentAt).toBeNull();
  });

  test("a bad body never reaches storage", async () => {
    const admission = await admitMasterForSegments();
    const { puts, storage } = fakeStorage();
    const body = segmentBody("a");
    const request = segmentRequest(admission.ingestId, admission.ticket, 0, body);

    // a body that does not match its announced checksum
    await expect(
      storeIngestSegment(
        { ...request, headers: { ...request.headers, checksumSha256: "f".repeat(64) }, storage },
        testDb,
      ),
    ).rejects.toThrow(/checksum/i);

    // a short read against the announced length
    await expect(
      storeIngestSegment({ ...request, body: body.slice(0, 10), storage }, testDb),
    ).rejects.toThrow(/content-length/i);

    expect(puts).toHaveLength(0);
  });
});

describe("segment request contract", () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  test("accepts the documented header set", () => {
    const parsed = parseSegmentHeaders(
      headers({
        "x-segment-sequence": "17",
        "x-segment-duration-ms": "1999",
        "x-segment-checksum-sha256": "a".repeat(64),
        "x-segment-discontinuity": "1",
      }),
    );
    expect(parsed).toEqual({
      sequence: 17,
      durationMs: 1999,
      checksumSha256: "a".repeat(64),
      discontinuity: true,
    });

    expect(
      parseSegmentHeaders(
        headers({
          "x-segment-sequence": "0",
          "x-segment-duration-ms": "100",
          "x-segment-checksum-sha256": "b".repeat(64),
        }),
      ).discontinuity,
    ).toBe(false);
  });

  test("rejects a missing or out-of-range header", () => {
    const base = {
      "x-segment-sequence": "0",
      "x-segment-duration-ms": "2000",
      "x-segment-checksum-sha256": "c".repeat(64),
    };
    const rejects = (values: Record<string, string>, pattern: RegExp) =>
      expect(() => parseSegmentHeaders(headers(values))).toThrow(pattern);

    rejects({ ...base, "x-segment-sequence": "" }, /x-segment-sequence/i);
    rejects({ ...base, "x-segment-sequence": "1.5" }, /x-segment-sequence/i);
    rejects({ ...base, "x-segment-sequence": "-1" }, /x-segment-sequence/i);
    rejects({ ...base, "x-segment-duration-ms": "99" }, /x-segment-duration-ms/i);
    rejects({ ...base, "x-segment-duration-ms": "10001" }, /x-segment-duration-ms/i);
    rejects({ ...base, "x-segment-checksum-sha256": "A".repeat(64) }, /x-segment-checksum/i);
    rejects({ ...base, "x-segment-checksum-sha256": "abc" }, /x-segment-checksum/i);
    rejects({ ...base, "x-segment-discontinuity": "yes" }, /x-segment-discontinuity/i);
  });

  test("content-length is required and capped before buffering", () => {
    expect(parseSegmentContentLength(headers({ "content-length": "1024" }))).toBe(1024);
    expect(() => parseSegmentContentLength(headers({}))).toThrow(/content-length/i);
    expect(() => parseSegmentContentLength(headers({ "content-length": "0" }))).toThrow(
      /content-length/i,
    );
    expect(() =>
      parseSegmentContentLength(headers({ "content-length": String(SEGMENT_MAX_BYTES + 1) })),
    ).toThrow(/exceeds/i);
    // the cap stays below the MinIO multipart threshold
    expect(SEGMENT_MAX_BYTES).toBeLessThan(64 * 1024 * 1024);
  });
});
