import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
  SEGMENT_TARGET_MS,
} from "../../../src/features/recordings-v2/ingest-service";

// project > session, plus the chain a result needs
const seedDomain = async () => {
  await testDb.insert(schema.project).values({ projectId: 9200, title: "P" });
  await testDb.insert(schema.session).values({ sessionId: 9200, projectId: 9200, name: "S" });
  await testDb.insert(schema.asset).values({ assetId: 9200, projectId: 9200, name: "A" });
  await testDb
    .insert(schema.component)
    .values({ componentId: 9200, assetId: 9200, projectId: 9200, name: "C" });
  await testDb.insert(schema.item).values({
    itemId: 9200,
    componentId: 9200,
    projectId: 9200,
    assetId: 9200,
    itemLabel: "I",
  });
  await testDb
    .insert(schema.sessionItem)
    .values({ sessionItemId: 9200, sessionId: 9200, itemId: 9200 });
  await testDb.insert(schema.result).values({
    resultId: 9200,
    sessionItemId: 9200,
    inspectionTypeCode: "GVI",
    projectId: 9200,
    assetId: 9200,
    componentId: 9200,
    itemId: 9200,
    sessionId: 9200,
  });
};

// 2026-09-20T23:59:59Z — the key date must not follow the next segment over midnight
const LATE_NIGHT_EPOCH = Math.floor(Date.parse("2026-09-20T23:59:59.000Z") / 1000);

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
      masterVideoId: expect.any(Number),
      sessionId: expect.any(Number),
      projectId: 9200,
    });
    expect(admission.ticket.length).toBeGreaterThan(20);

    const [master] = await testDb
      .select()
      .from(schema.masterVideo)
      .where(sql`${schema.masterVideo.masterVideoId} = ${admission.domain.masterVideoId}`);
    expect(master!.sessionId).toBe(admission.domain.sessionId);
    expect(master!.startEpoch).toBe(LATE_NIGHT_EPOCH);

    const [ingest] = await testDb.select().from(schema.recordingIngest);
    expect(ingest!.ingestId).toBe(admission.ingestId);
    expect(ingest!.kind).toBe("master");
    expect(ingest!.masterVideoId).toBe(admission.domain.masterVideoId);
    expect(ingest!.clipId).toBeNull();
    expect(ingest!.keyDate).toBe("2026-09-20");
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
        masterVideoId: master.domain.masterVideoId,
        startOffsetMs: 4000,
      },
      testDb,
    );

    if (clip.domain.kind !== "clip") throw new Error("expected a clip domain");
    expect(clip.domain).toEqual({
      kind: "clip",
      clipId: expect.any(Number),
      resultId: 9200,
      masterVideoId: master.domain.masterVideoId,
      sessionId: 9200,
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
    expect(ingest!.masterVideoId).toBeNull();
    // the clip inherits the master's key date, not its own wall clock
    expect(ingest!.keyDate).toBe("2026-09-20");
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
      masterVideoId: master.domain.masterVideoId,
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
        { kind: "clip", resultId: 9999, masterVideoId: master.domain.masterVideoId, startOffsetMs: 0 },
        testDb,
      ),
    ).rejects.toThrow(/Result not found/i);

    await expect(
      admitIngest({ kind: "clip", resultId: 9200, masterVideoId: 9999, startOffsetMs: 0 }, testDb),
    ).rejects.toThrow(/Master video not found/i);

    const ingests = await testDb.select().from(schema.recordingIngest);
    expect(ingests).toHaveLength(1); // the master only
  });
});
