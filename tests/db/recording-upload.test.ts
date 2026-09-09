import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../helpers/db";
import { AppError } from "../../src/lib/error";
import * as schema from "../../src/db/schema";
import {
  admitRecordingUpload,
  bootstrapBackendIdentity,
  commitRecordingSegmentReceipt,
  enqueueRecordingFinalizeJob,
  recordRecordingDiscard,
  reserveRecordingSegment,
  setRecoveryAuthority,
} from "../../src/db/services/recording-upload.service";

// deterministic domain chain for FK tests: project > session > asset > component
// > item > sessionItem > result > masterVideo > clip
const seedDomainChain = async () => {
  await testDb.insert(schema.project).values({ projectId: 9001, title: "P" });
  await testDb
    .insert(schema.session)
    .values({ sessionId: 9001, projectId: 9001, name: "S" });
  await testDb.insert(schema.asset).values({ assetId: 9001, projectId: 9001, name: "A" });
  await testDb
    .insert(schema.component)
    .values({ componentId: 9001, assetId: 9001, projectId: 9001, name: "C" });
  await testDb.insert(schema.item).values({
    itemId: 9001,
    componentId: 9001,
    projectId: 9001,
    assetId: 9001,
    itemLabel: "I",
  });
  await testDb
    .insert(schema.sessionItem)
    .values({ sessionItemId: 9001, sessionId: 9001, itemId: 9001 });
  await testDb.insert(schema.result).values({
    resultId: 9001,
    sessionItemId: 9001,
    inspectionTypeCode: "GVI",
    projectId: 9001,
    assetId: 9001,
    componentId: 9001,
    itemId: 9001,
    sessionId: 9001,
  });
  await testDb.insert(schema.masterVideo).values({
    masterVideoId: 9001,
    sessionId: 9001,
    startEpoch: 1000,
  });
  await testDb.insert(schema.videoClip).values({
    clipId: 9001,
    resultId: 9001,
    masterVideoId: 9001,
    startOffsetMs: 0,
  });
};

const admitMaster = (recordingId: string = randomUUID()) =>
  admitRecordingUpload(
    {
      recordingId,
      backendInstanceId: randomUUID(),
      admissionHash: "hash-1",
      kind: "master",
      masterVideoId: 9001,
      objectPrefix: `recordings/${recordingId}/segments`,
    },
    testDb
  );

// await a drizzle builder and return its rejection (builders are not Promises)
const rejectionOf = async (builder: { then: PromiseLike<unknown>["then"] }) => {
  try {
    await builder;
    return null;
  } catch (error) {
    return error;
  }
};

describe("recording upload v2 persistence", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
    await seedDomainChain();
  });

  it("bootstraps the backend identity singleton idempotently", async () => {
    const first = await bootstrapBackendIdentity(testDb);
    const second = await bootstrapBackendIdentity(testDb);
    expect(second.instanceId).toBe(first.instanceId);

    const rows = await testDb.query.backendIdentity.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0]!.recoveryAuthorityEnabled).toBe(false);
  });

  it("flips recovery authority only on the bootstrapped singleton", async () => {
    await expect(setRecoveryAuthority(true, testDb)).rejects.toBeInstanceOf(AppError);

    await bootstrapBackendIdentity(testDb);
    const updated = await setRecoveryAuthority(true, testDb);
    expect(updated.recoveryAuthorityEnabled).toBe(true);
  });

  it("admits a recording once and replays the same identity", async () => {
    const first = await admitMaster();
    expect(first.admitted).toBe(true);

    const replay = await admitMaster(first.upload.recordingId);
    expect(replay.admitted).toBe(false);
    expect(replay.upload.recordingId).toBe(first.upload.recordingId);

    const rows = await testDb.query.recordingUpload.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0]!.protocolVersion).toBe(2);
    expect(rows[0]!.captureState).toBe("recording");
  });

  it("rejects a reused UUID with a changed admission identity (409)", async () => {
    const { upload } = await admitMaster();
    await expect(
      admitRecordingUpload(
        {
          recordingId: upload.recordingId,
          backendInstanceId: upload.backendInstanceId,
          admissionHash: "hash-2",
          kind: "master",
          masterVideoId: 9001,
          objectPrefix: upload.objectPrefix,
        },
        testDb
      )
    ).rejects.toMatchObject({ status: 409, code: "identity_conflict" });
  });

  it("enforces exactly one domain FK per kind", async () => {
    // master without masterVideoId violates the kind check
    const missingTarget = await rejectionOf(
      testDb.insert(schema.recordingUpload).values({
        recordingId: randomUUID(),
        protocolVersion: 2,
        backendInstanceId: randomUUID(),
        admissionHash: "h",
        kind: "master",
        objectPrefix: "recordings/x/segments",
      })
    );
    expect(missingTarget).toBeDefined();

    // master with a clip target violates the kind check
    const wrongTarget = await rejectionOf(
      testDb.insert(schema.recordingUpload).values({
        recordingId: randomUUID(),
        protocolVersion: 2,
        backendInstanceId: randomUUID(),
        admissionHash: "h",
        kind: "master",
        clipId: 9001,
        objectPrefix: "recordings/x/segments",
      })
    );
    expect(wrongTarget).toBeDefined();

    // clip kind with clipId is accepted
    const clipRecording = randomUUID();
    await testDb.insert(schema.recordingUpload).values({
      recordingId: clipRecording,
      protocolVersion: 2,
      backendInstanceId: randomUUID(),
      admissionHash: "h",
      kind: "clip",
      clipId: 9001,
      objectPrefix: `recordings/${clipRecording}/segments`,
    });
    const rows = await testDb.query.recordingUpload.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("clip");
  });

  it("reserves a segment once and replays identical content", async () => {
    const { upload } = await admitMaster();
    const input = {
      recordingId: upload.recordingId,
      segmentIndex: 0,
      checksum: "aa".repeat(32),
      sizeBytes: 1024,
      objectKey: `recordings/${upload.recordingId}/segments/0000000000.ts`,
    };

    const first = await reserveRecordingSegment(input, testDb);
    expect(first.outcome).toBe("reserved");
    expect(first.segment.receiptState).toBe("reserved");

    const replay = await reserveRecordingSegment(input, testDb);
    expect(replay.outcome).toBe("reserved");
    expect(replay.segment.recordingId).toBe(upload.recordingId);

    const rows = await testDb.query.recordingSegment.findMany();
    expect(rows.length).toBe(1);
  });

  it("commits a receipt once, then replays without bumping the revision", async () => {
    const { upload } = await admitMaster();
    await reserveRecordingSegment(
      {
        recordingId: upload.recordingId,
        segmentIndex: 0,
        checksum: "bb".repeat(32),
        sizeBytes: 2048,
        objectKey: `recordings/${upload.recordingId}/segments/0000000000.ts`,
      },
      testDb
    );

    const commit = await commitRecordingSegmentReceipt(upload.recordingId, 0, testDb);
    expect(commit.revisionBumped).toBe(true);
    expect(commit.segment.receiptState).toBe("stored");
    expect(commit.segment.storedAt).not.toBeNull();

    const replay = await commitRecordingSegmentReceipt(upload.recordingId, 0, testDb);
    expect(replay.revisionBumped).toBe(false);

    const after = await testDb.query.recordingUpload.findFirst();
    expect(after!.segmentRevision).toBe(1);
  });

  it("rejects a stored index reserved with different content (409)", async () => {
    const { upload } = await admitMaster();
    await reserveRecordingSegment(
      {
        recordingId: upload.recordingId,
        segmentIndex: 3,
        checksum: "cc".repeat(32),
        sizeBytes: 4096,
        objectKey: `recordings/${upload.recordingId}/segments/0000000003.ts`,
      },
      testDb
    );
    await expect(
      reserveRecordingSegment(
        {
          recordingId: upload.recordingId,
          segmentIndex: 3,
          checksum: "dd".repeat(32),
          sizeBytes: 4096,
          objectKey: `recordings/${upload.recordingId}/segments/0000000003.ts`,
        },
        testDb
      )
    ).rejects.toMatchObject({ status: 409, code: "segment_conflict" });
  });

  it("rejects a reservation for an unadmitted recording", async () => {
    await expect(
      reserveRecordingSegment(
        {
          recordingId: randomUUID(),
          segmentIndex: 0,
          checksum: "ee".repeat(32),
          sizeBytes: 1,
          objectKey: "recordings/x/segments/0000000000.ts",
        },
        testDb
      )
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("keeps upload rows when the domain chain is deleted (no cascade)", async () => {
    const { upload } = await admitMaster();

    // project delete cascades session > masterVideo; the upload FK blocks it
    const blocked = await rejectionOf(testDb.delete(schema.project));
    expect(blocked).toBeDefined();

    const survivor = await testDb.query.recordingUpload.findFirst({
      where: (t, { eq }) => eq(t.recordingId, upload.recordingId),
    });
    expect(survivor?.recordingId).toBe(upload.recordingId);
  });

  it("enqueues one finalize job per recording revision", async () => {
    const { upload } = await admitMaster();

    const first = await enqueueRecordingFinalizeJob(upload.recordingId, 1, testDb);
    expect(first?.targetRevision).toBe(1);

    const replay = await enqueueRecordingFinalizeJob(upload.recordingId, 1, testDb);
    expect(replay).toBeNull();

    const next = await enqueueRecordingFinalizeJob(upload.recordingId, 2, testDb);
    expect(next?.targetRevision).toBe(2);

    const rows = await testDb.query.recordingFinalizeJob.findMany();
    expect(rows.length).toBe(2);
    expect(rows[0]!.state).toBe("pending");
  });

  it("audits a discard once per request and recording", async () => {
    const backend = await bootstrapBackendIdentity(testDb);
    const requestId = randomUUID();
    const unknownId = randomUUID();

    const first = await recordRecordingDiscard(
      {
        requestId,
        recordingId: unknownId,
        backendInstanceId: backend.instanceId,
        reason: "unknown_recording",
      },
      testDb
    );
    expect(first?.reason).toBe("unknown_recording");

    const replay = await recordRecordingDiscard(
      {
        requestId,
        recordingId: unknownId,
        backendInstanceId: backend.instanceId,
        reason: "unknown_recording",
      },
      testDb
    );
    expect(replay).toBeNull();

    const rows = await testDb.query.recordingDiscardAudit.findMany();
    expect(rows.length).toBe(1);
  });
});
