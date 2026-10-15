import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import * as schema from "../../../src/db/schema";
import {
  admitIngest,
  closeIngest,
  heartbeatIngest,
  INGEST_IDLE_CLOSE_MS,
  parseSegmentContentLength,
  parseSegmentHeaders,
  storeIngestSegment,
  type SegmentStorage,
} from "../../../src/features/recording/ingest-service";
import {
  INGEST_SWEEP_INTERVAL_MS,
  sweepInactiveIngests,
} from "../../../src/features/recording/ingest-sweep";
import { INGEST_RECOVERY_GRACE_MS } from "../../../src/lib/ingest_lease";

const START_EPOCH = Math.floor(Date.parse("2026-09-20T10:00:00.000Z") / 1000);
const CLOCK_START = new Date("2026-09-20T10:00:00.000Z");

// no-op storage: the lifecycle suite never needs object bytes on disk
const quietStorage: SegmentStorage = { put: async () => {} };

const seedDomain = async () => {
  await testDb.insert(schema.project).values({ organizationId: testOrgId, displayNumber: 9300, projectId: 9300, title: "P" });
  await testDb.insert(schema.session).values({ displayNumber: 1, sessionId: 9300, projectId: 9300, name: "S" });
  await testDb.insert(schema.taskGroup).values({
    taskGroupId: 9300,
    projectId: 9300,
    code: "100",
  });
  await testDb.insert(schema.taskCode).values({
    taskCodeId: 9300,
    taskGroupId: 9300,
    code: "101",
  });
  await testDb.insert(schema.description).values({
    descriptionId: 9300,
    taskCodeId: 9300,
    label: "I",
  });
  // session_item is gone: v2 results carry their own target
  await testDb.insert(schema.result).values({
    displayNumber: 9300,
    resultId: 9300,
    inspectionTypeCode: "GVI",
        descriptionId: 9300,
        layer: 1,
        masterStartMs: 0,
    projectId: 9300,
    sessionId: 9300,
  });
};

const segmentBody = (label: string) => {
  const body = new Uint8Array(1024);
  for (let i = 0; i < body.length; i++) body[i] = (label.charCodeAt(0) + i) & 0xff;
  return body;
};

const storeSegment = (ingestId: number, ticket: string, sequence: number, durationMs = 2000) => {
  const body = segmentBody(String(sequence));
  const headers = new Headers({
    "x-segment-sequence": String(sequence),
    "x-segment-duration-ms": String(durationMs),
    "x-segment-checksum-sha256": createHash("sha256").update(body).digest("hex"),
  });
  return storeIngestSegment(
    {
      ingestId,
      authorization: `Bearer ${ticket}`,
      headers: parseSegmentHeaders(headers),
      contentLength: parseSegmentContentLength(
        new Headers({ "content-length": String(body.byteLength) }),
      ),
      body,
      storage: quietStorage,
    },
    testDb,
  );
};

// pin the activity stamps so the 15 s rule is exact, not wall-clock
const pinIngestClock = async (
  ingestId: number,
  openedAt: Date,
  lastSegmentAt: Date | null,
  lastSeenAt: Date | null = null,
) => {
  await testDb
    .update(schema.recordingIngest)
    .set({ openedAt, lastSegmentAt, lastSeenAt })
    .where(eq(schema.recordingIngest.ingestId, ingestId));
};

// Stills are never run here: the worker owns MinIO and FFmpeg, and this file
// only proves lifecycle facts.
const noThumbnails = {
  master: () => undefined,
  clip: () => undefined,
};

describe("direct ingest lifecycle", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
    await seedDomain();
  });

  const admitMaster = async () => {
    const admission = await admitIngest(
      { kind: "master", projectId: 9300, startEpoch: START_EPOCH },
      testDb,
    );
    if (admission.domain.kind !== "master") throw new Error("expected a master domain");
    return admission;
  };

  test("an empty ingest closes on openedAt after exactly 15 seconds", async () => {
    const admission = await admitMaster();
    await pinIngestClock(admission.ingestId, CLOCK_START, null);

    const justBefore = new Date(CLOCK_START.getTime() + INGEST_IDLE_CLOSE_MS - 1);
    expect(await sweepInactiveIngests(justBefore, testDb)).toEqual([]);

    const atCutoff = new Date(CLOCK_START.getTime() + INGEST_IDLE_CLOSE_MS);
    expect(await sweepInactiveIngests(atCutoff, testDb)).toEqual([admission.ingestId]);

    const [ingest] = await testDb.select().from(schema.recordingIngest);
    expect(ingest!.closedAt).not.toBeNull();
    expect(ingest!.finalSequence).toBe(-1);
    expect(ingest!.durationMs).toBe(0);
  });

  // A segment-bearing ingest gets the recovery grace, so a restarted app can
  // rebind and drain before the sweep ends it.
  test("a segment-bearing ingest survives the idle window and closes at the grace", async () => {
    const admission = await admitMaster();
    await storeSegment(admission.ingestId, admission.ticket, 0);
    const lastSegmentAt = new Date(CLOCK_START.getTime() + 60_000);
    await pinIngestClock(admission.ingestId, CLOCK_START, lastSegmentAt);

    // Well past the 15 s idle window the footage still buys recovery time.
    expect(
      await sweepInactiveIngests(new Date(CLOCK_START.getTime() + 75_000), testDb),
    ).toEqual([]);
    expect(
      await sweepInactiveIngests(
        new Date(lastSegmentAt.getTime() + INGEST_RECOVERY_GRACE_MS - 1),
        testDb,
      ),
    ).toEqual([]);
    expect(
      await sweepInactiveIngests(
        new Date(lastSegmentAt.getTime() + INGEST_RECOVERY_GRACE_MS),
        testDb,
      ),
    ).toEqual([admission.ingestId]);
  });

  test("close freezes the contiguous prefix and stamps the master facts", async () => {
    const admission = await admitMaster();
    await storeSegment(admission.ingestId, admission.ticket, 0, 2000);
    await storeSegment(admission.ingestId, admission.ticket, 1, 2500);
    // sequence 3 is a hole-driven straggler: stored, but past the frozen range
    await storeSegment(admission.ingestId, admission.ticket, 3, 2000);

    const closed = await closeIngest(
      { ingestId: admission.ingestId, ticket: admission.ticket, dispatch: noThumbnails },
      testDb,
    );

    expect(closed.replayed).toBe(false);
    expect(closed.finalSequence).toBe(1);
    expect(closed.durationMs).toBe(4500);

    const [master] = await testDb
      .select()
      .from(schema.session)
      .where(eq(schema.session.sessionId, admission.domain.sessionId));
    expect(master!.durationMs).toBe(4500);
    expect(master!.endEpoch).toBe(START_EPOCH + 4);

    const segments = await testDb.select().from(schema.recordingIngestSegment);
    expect(segments).toHaveLength(3); // the frozen range hides sequence 3, never deletes it
  });

  test("an equivalent close replays the prior result", async () => {
    const admission = await admitMaster();
    await storeSegment(admission.ingestId, admission.ticket, 0);

    const first = await closeIngest(
      { ingestId: admission.ingestId, ticket: admission.ticket, dispatch: noThumbnails },
      testDb,
    );
    const replay = await closeIngest(
      { ingestId: admission.ingestId, ticket: admission.ticket, dispatch: noThumbnails },
      testDb,
    );

    expect(replay.replayed).toBe(true);
    expect(replay.finalSequence).toBe(first.finalSequence);
    expect(replay.durationMs).toBe(first.durationMs);
    expect(replay.closedAt).toEqual(first.closedAt);
  });

  test("a close without the matching ticket is refused", async () => {
    const admission = await admitMaster();
    const other = await admitMaster();

    await expect(
      closeIngest(
      { ingestId: admission.ingestId, ticket: other.ticket, dispatch: noThumbnails }, testDb),
    ).rejects.toThrow(/does not match this ingest/i);

    const [ingest] = await testDb
      .select()
      .from(schema.recordingIngest)
      .where(eq(schema.recordingIngest.ingestId, admission.ingestId));
    expect(ingest!.closedAt).toBeNull();
  });

  test("later uploads to a closed ingest answer 410", async () => {
    const admission = await admitMaster();
    await storeSegment(admission.ingestId, admission.ticket, 0);
    await closeIngest(
      { ingestId: admission.ingestId, ticket: admission.ticket, dispatch: noThumbnails }, testDb);

    await expect(
      storeSegment(admission.ingestId, admission.ticket, 1),
    ).rejects.toThrow(/closed at sequence 0/i);
  });

  test("a clip close stamps its end offset on the master timeline", async () => {
    const master = await admitMaster();
    const clip = await admitIngest(
      {
        kind: "clip",
        resultId: 9300,
        sessionId: master.domain.sessionId,
        startOffsetMs: 30_000,
      },
      testDb,
    );
    if (clip.domain.kind !== "clip") throw new Error("expected a clip domain");

    await storeSegment(clip.ingestId, clip.ticket, 0, 2000);
    await storeSegment(clip.ingestId, clip.ticket, 1, 1500);
    const closed = await closeIngest(
      { ingestId: clip.ingestId, ticket: clip.ticket, dispatch: noThumbnails }, testDb);

    expect(closed.finalSequence).toBe(1);
    expect(closed.durationMs).toBe(3500);

    const [row] = await testDb
      .select()
      .from(schema.videoClip)
      .where(eq(schema.videoClip.clipId, clip.domain.clipId));
    expect(row!.endOffsetMs).toBe(33_500);
  });

  test("the sweep leaves a healthy capture alone and closes a silent one", async () => {
    const live = await admitMaster();
    const silent = await admitMaster();
    await pinIngestClock(live.ingestId, CLOCK_START, new Date(CLOCK_START.getTime() + 10_000));
    await pinIngestClock(silent.ingestId, CLOCK_START, null);

    const closed = await sweepInactiveIngests(
      new Date(CLOCK_START.getTime() + INGEST_IDLE_CLOSE_MS),
      testDb,
    );

    expect(closed).toEqual([silent.ingestId]);
    const [liveRow] = await testDb
      .select()
      .from(schema.recordingIngest)
      .where(eq(schema.recordingIngest.ingestId, live.ingestId));
    expect(liveRow!.closedAt).toBeNull();
  });

  test("the sweep interval stays well inside the idle window", () => {
    expect(INGEST_SWEEP_INTERVAL_MS).toBeLessThan(INGEST_IDLE_CLOSE_MS / 2);
  });

  // A paused master or clip stores no segments: without the lease it would look
  // exactly like a crashed capture, and resuming it would answer 410.
  test("a heartbeat holds a segment-less ingest open past the idle window", async () => {
    const admission = await admitMaster();
    await pinIngestClock(admission.ingestId, CLOCK_START, null);
    const renewed = new Date(CLOCK_START.getTime() + 60_000);
    await heartbeatIngest({ ingestId: admission.ingestId, ticket: admission.ticket }, testDb);
    await pinIngestClock(admission.ingestId, CLOCK_START, null, renewed);

    expect(
      await sweepInactiveIngests(new Date(renewed.getTime() + INGEST_IDLE_CLOSE_MS - 1), testDb),
    ).toEqual([]);
    expect(
      await sweepInactiveIngests(new Date(renewed.getTime() + INGEST_IDLE_CLOSE_MS), testDb),
    ).toEqual([admission.ingestId]);
  });

  test("a lease that stops renewing lets the sweep close the ingest", async () => {
    const admission = await admitMaster();
    await pinIngestClock(admission.ingestId, CLOCK_START, null);
    const lastSeenAt = new Date(CLOCK_START.getTime() + 60_000);
    await heartbeatIngest({ ingestId: admission.ingestId, ticket: admission.ticket }, testDb);
    await pinIngestClock(admission.ingestId, CLOCK_START, null, lastSeenAt);

    // 15 s after opening is stale by openedAt, but the lease is still fresh
    expect(await sweepInactiveIngests(new Date(CLOCK_START.getTime() + 15_000), testDb)).toEqual([]);
    expect(
      await sweepInactiveIngests(new Date(lastSeenAt.getTime() + INGEST_IDLE_CLOSE_MS), testDb),
    ).toEqual([admission.ingestId]);
  });

  test("the newest of segment, lease and open time wins", async () => {
    const admission = await admitMaster();
    await pinIngestClock(
      admission.ingestId,
      CLOCK_START,
      new Date(CLOCK_START.getTime() + 10_000),
      new Date(CLOCK_START.getTime() + 20_000),
    );

    // the lease is the newest stamp, so the segment cannot age it out; the
    // grace is measured from the lease, not the segment
    expect(
      await sweepInactiveIngests(new Date(CLOCK_START.getTime() + 315_000), testDb),
    ).toEqual([]);
    expect(
      await sweepInactiveIngests(new Date(CLOCK_START.getTime() + 320_000), testDb),
    ).toEqual([admission.ingestId]);
  });

  // Both tiers in one pass: an empty ingest dies in seconds while a
  // segment-bearing one keeps its recovery window.
  test("one sweep closes the empty ingest and keeps the footage-bearing one", async () => {
    const empty = await admitMaster();
    const loaded = await admitMaster();
    await pinIngestClock(empty.ingestId, CLOCK_START, null);
    await pinIngestClock(loaded.ingestId, CLOCK_START, CLOCK_START);

    expect(
      await sweepInactiveIngests(new Date(CLOCK_START.getTime() + INGEST_IDLE_CLOSE_MS), testDb),
    ).toEqual([empty.ingestId]);
    expect(
      await sweepInactiveIngests(
        new Date(CLOCK_START.getTime() + INGEST_RECOVERY_GRACE_MS),
        testDb,
      ),
    ).toEqual([loaded.ingestId]);
  });

  test("a heartbeat without the matching ticket is refused", async () => {
    const admission = await admitMaster();
    const other = await admitMaster();

    await expect(
      heartbeatIngest({ ingestId: admission.ingestId, ticket: other.ticket }, testDb),
    ).rejects.toThrow(/does not match this ingest/i);

    const [ingest] = await testDb
      .select()
      .from(schema.recordingIngest)
      .where(eq(schema.recordingIngest.ingestId, admission.ingestId));
    expect(ingest!.lastSeenAt).toBeNull();
  });

  test("a heartbeat to a closed ingest answers 410 like a segment does", async () => {
    const admission = await admitMaster();
    await storeSegment(admission.ingestId, admission.ticket, 0);
    await closeIngest(
      { ingestId: admission.ingestId, ticket: admission.ticket, dispatch: noThumbnails },
      testDb,
    );

    await expect(
      heartbeatIngest({ ingestId: admission.ingestId, ticket: admission.ticket }, testDb),
    ).rejects.toThrow(/closed at sequence 0/i);
  });
});
