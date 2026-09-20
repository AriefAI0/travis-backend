import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";

// frozen key prefix every ingest row carries; the value is not under test here
const KEY_PREFIX = "1/9001/9001/2026/09/20/master/9001";

// pg port: libsql's CHECK constraints became native pg enums, so invalid values
// surface as 'invalid input value for enum ...' (22P02), not CHECK failures.
// These tests verify the enums reject invalid values at the DB layer, bypassing
// the TS types via raw SQL — the whole point of the suite.
const expectEnumRejection = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => {
      throw new Error(
        "expected the enum to reject this insert, but it succeeded",
      );
    },
    (rejection: unknown) => rejection,
  );
  const causeMessage = (error as { cause?: { message?: string } })?.cause?.message;
  expect(String(`${error} ${causeMessage ?? ""}`)).toMatch(
    /invalid input value for enum/i,
  );
};

// CHECK and unique index violations surface as pg error strings
const expectDbRejection = async (promise: Promise<unknown>, pattern: RegExp) => {
  const error = await promise.then(
    () => {
      throw new Error("expected the database to reject this write, but it succeeded");
    },
    (rejection: unknown) => rejection,
  );
  const causeMessage = (error as { cause?: { message?: string } })?.cause?.message;
  expect(String(`${error} ${causeMessage ?? ""}`)).toMatch(pattern);
};

describe("enum constraints (pg port of CHECK suite)", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  it("item.status rejects values outside the enum", async () => {
    await testDb.insert(schema.project).values({ projectId: 9001, title: "P" });
    await testDb.insert(schema.asset).values({ assetId: 9001, projectId: 9001, name: "A" });
    await testDb
      .insert(schema.component)
      .values({ componentId: 9001, assetId: 9001, projectId: 9001, name: "C" });

    // Valid enum values are accepted (including the not_set default). These
    // inserts throw if the enum is over-constrained.
    await testDb
      .insert(schema.item)
      .values({ itemId: 9001, componentId: 9001, projectId: 9001, assetId: 9001, itemLabel: "I", status: "complete" });
    await testDb
      .insert(schema.item)
      .values({ itemId: 9002, componentId: 9001, projectId: 9001, assetId: 9001, itemLabel: "I2", status: "not_set" });

    // An invalid status is rejected by the enum (raw insert bypasses
    // the TS enum, which is the whole point — the enum must hold at the DB layer).
    await expectEnumRejection(
      testDb.execute(
        sql`INSERT INTO item (item_id, component_id, project_id, asset_id, item_label, status)
            VALUES (9003, 9001, 9001, 9001, 'I3', 'bogus_status')`,
      ),
    );
  });

  it("result.inspection_type_code rejects values outside the enum", async () => {
    await testDb.insert(schema.project).values({ projectId: 9002, title: "P" });
    await testDb.insert(schema.session).values({ sessionId: 9002, projectId: 9002, name: "S" });
    await testDb.insert(schema.asset).values({ assetId: 9002, projectId: 9002, name: "A" });
    await testDb
      .insert(schema.component)
      .values({ componentId: 9002, assetId: 9002, projectId: 9002, name: "C" });
    await testDb.insert(schema.item).values({
      itemId: 9002,
      componentId: 9002,
      projectId: 9002,
      assetId: 9002,
      itemLabel: "I",
    });
    await testDb
      .insert(schema.sessionItem)
      .values({ sessionItemId: 9002, sessionId: 9002, itemId: 9002 });

    // Valid code accepted.
    await testDb.insert(schema.result).values({
      resultId: 9002,
      sessionItemId: 9002,
      inspectionTypeCode: "GVI",
      projectId: 9002,
      assetId: 9002,
      componentId: 9002,
      itemId: 9002,
      sessionId: 9002,
    });

    // Invalid code rejected by the enum.
    await expectEnumRejection(
      testDb.execute(
        sql`INSERT INTO result (result_id, session_item_id, inspection_type_code, project_id, asset_id, component_id, item_id, session_id)
            VALUES (9003, 9002, 'BOGUS', 9002, 9002, 9002, 9002, 9002)`,
      ),
    );
  });

});

// Direct ingest ledger: one target per row, one open clip ingest per clip,
// and a composite segment key that swallows a replay.
describe("direct recording ingest constraints", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  // project > session > master_video, plus the chain a video_clip needs
  const seedTargets = async () => {
    await testDb.insert(schema.project).values({ projectId: 9100, title: "P" });
    await testDb.insert(schema.session).values({ sessionId: 9100, projectId: 9100, name: "S" });
    await testDb
      .insert(schema.masterVideo)
      .values({ masterVideoId: 9100, sessionId: 9100, startEpoch: 0 });
    await testDb.insert(schema.asset).values({ assetId: 9100, projectId: 9100, name: "A" });
    await testDb
      .insert(schema.component)
      .values({ componentId: 9100, assetId: 9100, projectId: 9100, name: "C" });
    await testDb.insert(schema.item).values({
      itemId: 9100,
      componentId: 9100,
      projectId: 9100,
      assetId: 9100,
      itemLabel: "I",
    });
    await testDb
      .insert(schema.sessionItem)
      .values({ sessionItemId: 9100, sessionId: 9100, itemId: 9100 });
    await testDb.insert(schema.result).values({
      resultId: 9100,
      sessionItemId: 9100,
      inspectionTypeCode: "GVI",
      projectId: 9100,
      assetId: 9100,
      componentId: 9100,
      itemId: 9100,
      sessionId: 9100,
    });
    await testDb
      .insert(schema.videoClip)
      .values({ clipId: 9100, resultId: 9100, masterVideoId: 9100, startOffsetMs: 0 });
  };

  it("recording_ingest accepts one target and rejects zero or two", async () => {
    await seedTargets();

    await testDb.insert(schema.recordingIngest).values({
      kind: "master",
      masterVideoId: 9100,
      ticketHash: "a".repeat(64),
      keyDate: "2026-09-20",
      keyPrefix: KEY_PREFIX,
    });
    await testDb.insert(schema.recordingIngest).values({
      kind: "clip",
      clipId: 9100,
      ticketHash: "b".repeat(64),
      keyDate: "2026-09-20",
      keyPrefix: KEY_PREFIX,
    });

    await expectDbRejection(
      testDb.execute(
        sql`INSERT INTO recording_ingest (kind, ticket_hash, key_date, key_prefix)
            VALUES ('master', 'c', '2026-09-20', 'prefix')`,
      ),
      /violates check constraint|recording_ingest_kind_target_check/i,
    );
    await expectDbRejection(
      testDb.execute(
        sql`INSERT INTO recording_ingest (kind, master_video_id, clip_id, ticket_hash, key_date, key_prefix)
            VALUES ('clip', 9100, 9100, 'd', '2026-09-20', 'prefix')`,
      ),
      /violates check constraint|recording_ingest_kind_target_check/i,
    );
  });

  it("a clip holds at most one open ingest", async () => {
    await seedTargets();
    await testDb.insert(schema.recordingIngest).values({
      kind: "clip",
      clipId: 9100,
      ticketHash: "a".repeat(64),
      keyDate: "2026-09-20",
      keyPrefix: KEY_PREFIX,
    });

    await expectDbRejection(
      testDb.insert(schema.recordingIngest).values({
        kind: "clip",
        clipId: 9100,
        ticketHash: "b".repeat(64),
        keyDate: "2026-09-20",
        keyPrefix: KEY_PREFIX,
      }),
      /duplicate key|uq_recording_ingest_open_clip/i,
    );
  });

  it("a segment replay hits the composite key instead of a second row", async () => {
    await seedTargets();
    const [ingest] = await testDb
      .insert(schema.recordingIngest)
      .values({
        kind: "master",
        masterVideoId: 9100,
        ticketHash: "a".repeat(64),
        keyDate: "2026-09-20",
        keyPrefix: KEY_PREFIX,
      })
      .returning({ ingestId: schema.recordingIngest.ingestId });

    const segment = {
      ingestId: ingest!.ingestId,
      sequence: 0,
      checksumSha256: "e".repeat(64),
      sizeBytes: 1024,
      durationMs: 2000,
      objectKey: "1/9100/9100/2026/09/20/master/9100/0000000000.ts",
    };
    await testDb.insert(schema.recordingIngestSegment).values(segment);

    await expectDbRejection(
      testDb.insert(schema.recordingIngestSegment).values(segment),
      /duplicate key|recording_ingest_segment_pk/i,
    );
  });
});
