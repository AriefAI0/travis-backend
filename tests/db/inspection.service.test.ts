import { beforeEach, afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";
import { AppError } from "../../src/lib/error";
import {
  cancelInspection,
  getActiveInspection,
  resolveSessionItemId,
  startInspection,
  stopInspection,
} from "../../src/db/services/inspection.service";
import { createSession, listSessionItems } from "../../src/db/services/session.service";
import {
  getResultById,
  getResultMgiDetailByResultId,
  listResults,
} from "../../src/db/services/result.service";
import {
  RECORDING_PERSISTENCE_STATUS,
  createMasterVideo,
  createVideoClip,
  getVideoClipById,
  listVideoClips,
} from "../../src/db/services/video.service";

// assert a thrown AppError carries the expected code
const expectAppError = async (fn: () => Promise<unknown>, code: string) => {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected AppError with code ${code}`);
};

// project > asset > component > item chain the denorm walk reads
const seedHierarchy = async () => {
  await testDb.insert(schema.project).values({ projectId: 1, title: "Project One" });
  await testDb.insert(schema.asset).values({ assetId: 11, projectId: 1, name: "Platform A" });
  await testDb
    .insert(schema.component)
    .values({ componentId: 21, assetId: 11, projectId: 1, name: "Jacket Leg" });
  await testDb.insert(schema.item).values({
    itemId: 31,
    componentId: 21,
    projectId: 1,
    assetId: 11,
    itemLabel: "JL-01",
    status: "pending",
  });
  const session = (await createSession({ projectId: 1 }, testDb))!;
  return { sessionId: session.sessionId };
};

// master on 'recording' — the state an inspection start requires
const seedRecordingMaster = (sessionId: number) =>
  createMasterVideo(
    {
      sessionId,
      startEpoch: 1000,
      recordingStatus: RECORDING_PERSISTENCE_STATUS.recording,
    },
    testDb,
  );

// valid MGI typed-detail payload (writeMgiDetail shape)
const mgiPayload = {
  kind: "mgi",
  version: 1,
  findings: [],
  criteria: { preset: "project_default" },
  noMgObserved: true,
};

describe("inspection.service", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  it("start creates the result row only, with resolved denorm ids", async () => {
    const { sessionId } = await seedHierarchy();
    const master = (await seedRecordingMaster(sessionId))!;

    const result = (await startInspection(
      { sessionId, itemId: 31, inspectionTypeCode: "CVI" },
      testDb,
    ))!;

    expect(result).toMatchObject({
      projectId: 1,
      assetId: 11,
      componentId: 21,
      itemId: 31,
      sessionId,
      inspectionTypeCode: "CVI",
    });
    // no clip row — MinIO create owns it, not the start
    expect(await listVideoClips(testDb)).toHaveLength(0);
    // the master row is untouched by start
    expect(master.masterVideoId).toBeGreaterThan(0);
  });

  it("start creates the session_item when the pair is new", async () => {
    const { sessionId } = await seedHierarchy();
    await seedRecordingMaster(sessionId);

    expect(await listSessionItems(testDb)).toHaveLength(0);
    await startInspection({ sessionId, itemId: 31, inspectionTypeCode: "GVI" }, testDb);

    const sessionItemId = await resolveSessionItemId(sessionId, 31, testDb);
    expect(sessionItemId).toBeGreaterThan(0);
  });

  it("start without a master recording throws no_master_video and writes nothing", async () => {
    const { sessionId } = await seedHierarchy();

    await expectAppError(
      () => startInspection({ sessionId, itemId: 31, inspectionTypeCode: "CVI" }, testDb),
      "no_master_video",
    );

    // all-or-nothing: no result row AND no session_item row behind the refusal
    expect(await listResults(testDb)).toHaveLength(0);
    expect(await listSessionItems(testDb)).toHaveLength(0);
  });

  it("start rejects when the master exists but is not recording", async () => {
    const { sessionId } = await seedHierarchy();
    await createMasterVideo(
      {
        sessionId,
        startEpoch: 1000,
        recordingStatus: RECORDING_PERSISTENCE_STATUS.finalized,
      },
      testDb,
    );

    await expectAppError(
      () => startInspection({ sessionId, itemId: 31, inspectionTypeCode: "CVI" }, testDb),
      "no_master_video",
    );
    expect(await listResults(testDb)).toHaveLength(0);
  });

  it("a second start on the same pair throws inspection_in_progress", async () => {
    const { sessionId } = await seedHierarchy();
    await seedRecordingMaster(sessionId);

    await startInspection({ sessionId, itemId: 31, inspectionTypeCode: "CVI" }, testDb);
    await expectAppError(
      () => startInspection({ sessionId, itemId: 31, inspectionTypeCode: "CVI" }, testDb),
      "inspection_in_progress",
    );
    // exactly one result row exists
    expect(await listResults(testDb)).toHaveLength(1);
  });

  it("the guard is per pair — another inspection type on the same item starts", async () => {
    const { sessionId } = await seedHierarchy();
    await seedRecordingMaster(sessionId);

    await startInspection({ sessionId, itemId: 31, inspectionTypeCode: "CVI" }, testDb);
    const second = await startInspection(
      { sessionId, itemId: 31, inspectionTypeCode: "GVI" },
      testDb,
    );

    expect(second).toMatchObject({ inspectionTypeCode: "GVI" });
    expect(await listResults(testDb)).toHaveLength(2);
  });

  it("stop writes the typed detail, the remarks, and closes the inspection", async () => {
    const { sessionId } = await seedHierarchy();
    await seedRecordingMaster(sessionId);
    const result = (await startInspection(
      { sessionId, itemId: 31, inspectionTypeCode: "MGI" },
      testDb,
    ))!;
    const sessionItemId = await resolveSessionItemId(sessionId, 31, testDb);

    expect(await getActiveInspection(sessionItemId, "MGI", testDb)).not.toBeNull();

    const stopped = (await stopInspection(
      result.resultId,
      { remarks: "checked", payload: mgiPayload },
      testDb,
    ))!;

    expect(stopped).toMatchObject({ remarks: "checked" });
    expect(await getResultMgiDetailByResultId(result.resultId, testDb)).not.toBeNull();
    expect(await getActiveInspection(sessionItemId, "MGI", testDb)).toBeNull();
  });

  it("a failed stop rolls back — a bad payload leaves the inspection open", async () => {
    const { sessionId } = await seedHierarchy();
    await seedRecordingMaster(sessionId);
    const result = (await startInspection(
      { sessionId, itemId: 31, inspectionTypeCode: "MGI" },
      testDb,
    ))!;

    // invalid preset: the payload parse rejects inside the transaction
    await expect(
      testDb.transaction((tx) =>
        stopInspection(
          result.resultId,
          { remarks: "never lands", payload: { ...mgiPayload, criteria: { preset: "bogus" } } },
          tx,
        ),
      ),
    ).rejects.toThrow();

    // remarks untouched, detail absent, inspection still open
    const stillOpen = await getResultById(result.resultId, testDb);
    expect(stillOpen).toMatchObject({ remarks: null });
    expect(await getResultMgiDetailByResultId(result.resultId, testDb)).toBeNull();
  });

  it("stop refuses a missing result and a double stop", async () => {
    const { sessionId } = await seedHierarchy();
    await seedRecordingMaster(sessionId);

    await expectAppError(
      () => stopInspection(999, { payload: mgiPayload }, testDb),
      "not_found",
    );

    const result = (await startInspection(
      { sessionId, itemId: 31, inspectionTypeCode: "MGI" },
      testDb,
    ))!;
    await stopInspection(result.resultId, { payload: mgiPayload }, testDb);

    await expectAppError(
      () => stopInspection(result.resultId, { payload: mgiPayload }, testDb),
      "inspection_already_stopped",
    );
  });

  it("a stopped pair can start a fresh inspection of the same type", async () => {
    const { sessionId } = await seedHierarchy();
    await seedRecordingMaster(sessionId);

    const first = (await startInspection(
      { sessionId, itemId: 31, inspectionTypeCode: "MGI" },
      testDb,
    ))!;
    await stopInspection(first.resultId, { payload: mgiPayload }, testDb);

    const second = await startInspection(
      { sessionId, itemId: 31, inspectionTypeCode: "MGI" },
      testDb,
    );
    expect(second).not.toBeNull();
  });

  it("cancel removes the result and cascades the clip row", async () => {
    const { sessionId } = await seedHierarchy();
    const master = (await seedRecordingMaster(sessionId))!;
    const result = (await startInspection(
      { sessionId, itemId: 31, inspectionTypeCode: "CVI" },
      testDb,
    ))!;
    // the clip row MinIO create would own
    const clip = (await createVideoClip(
      {
        resultId: result.resultId,
        masterVideoId: master.masterVideoId,
        startOffsetMs: 0,
        endOffsetMs: null,
        recordingStatus: RECORDING_PERSISTENCE_STATUS.recording,
      },
      testDb,
    ))!;

    const deleted = await cancelInspection(result.resultId, testDb);

    expect(deleted).not.toBeNull();
    expect(await getResultById(result.resultId, testDb)).toBeNull();
    expect(await getVideoClipById(clip.clipId, testDb)).toBeNull();
  });

  it("cancel refuses a stopped inspection and a missing result", async () => {
    const { sessionId } = await seedHierarchy();
    await seedRecordingMaster(sessionId);

    await expectAppError(() => cancelInspection(999, testDb), "not_found");

    const result = (await startInspection(
      { sessionId, itemId: 31, inspectionTypeCode: "MGI" },
      testDb,
    ))!;
    await stopInspection(result.resultId, { payload: mgiPayload }, testDb);

    await expectAppError(
      () => cancelInspection(result.resultId, testDb),
      "inspection_already_stopped",
    );
    // the stopped inspection survives the refusal
    expect(await getResultById(result.resultId, testDb)).not.toBeNull();
  });
});
