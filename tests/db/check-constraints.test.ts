import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";

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

  it("master_video.recording_status accepts the live values and rejects others", async () => {
    await testDb.insert(schema.project).values({ projectId: 9003, title: "P" });
    await testDb.insert(schema.session).values({ sessionId: 9003, projectId: 9003, name: "S" });

    // Every value the app actually writes (RECORDING_PERSISTENCE_STATUS) must be
    // accepted — the enum is bound to the live set, NOT the locked design's
    // stale (recording/finalized/failed/recovering) set.
    const liveStatuses = [
      "recording",
      "finalized",
      "interrupted",
      "finalization_failed",
      "canceled",
    ] as const;
    for (const [index, status] of liveStatuses.entries()) {
      await testDb.insert(schema.masterVideo).values({
        masterVideoId: 9003 + index,
        sessionId: 9003,
        storageStem: `file://${status}.mp4`,
        startEpoch: 0,
        recordingStatus: status,
      });
    }

    // A value that is NOT in the live set is rejected.
    await expectEnumRejection(
      testDb.execute(
        sql`INSERT INTO master_video (master_video_id, session_id, file_url, start_epoch, recording_status)
            VALUES (9999, 9003, 'file://bogus.mp4', 0, 'recovering')`,
      ),
    );
  });
});
