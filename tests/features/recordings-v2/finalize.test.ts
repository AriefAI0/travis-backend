import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { eq } from "drizzle-orm";

import {
  ensureTestDatabase,
  testDatabaseUrl,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { generateSegments } from "../../helpers/fixtures";
import * as schema from "../../../src/db/schema";
import { env } from "../../../src/config/env";
import { minio } from "../../../src/lib/minio_storage/clients";
import { v2PlaybackPrefix, v2SegmentLeaf } from "../../../src/lib/minio_storage/paths";
import {
  admitRecording,
  completeSegment,
  getRecordingStatus,
  recoveryCompleteRecording,
  stopRecording,
} from "../../../src/db/services/recording-v2.service";
import {
  reserveRecordingSegment,
} from "../../../src/db/services/recording-upload.service";
import {
  claimNextRecordingFinalizeJob,
  completeRecordingFinalizeJob,
  scheduleRecordingFinalize,
} from "../../../src/db/services/recording-finalize.service";
import { bootstrapBackendIdentity } from "../../../src/db/services/recording-upload.service";
import { processNextRecordingFinalizeJob } from "../../../src/features/recordings-v2/jobs/finalize";

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

// reserved + PUT + completed segment in one step (service level)
const sealSegment = async (recordingId: string, index: number, bytes: Uint8Array) => {
  const leaf = v2SegmentLeaf(recordingId, index);
  await reserveRecordingSegment(
    {
      recordingId,
      segmentIndex: index,
      checksum: sha256Hex(bytes),
      sizeBytes: bytes.length,
      objectKey: leaf.key,
    },
    testDb
  );
  const url = await minio.presignedUrl("PUT", leaf.bucket, leaf.key, 300);
  const put = await fetch(url, {
    method: "PUT",
    body: bytes,
    headers: { "x-amz-checksum-sha256": Buffer.from(sha256Hex(bytes), "hex").toString("base64") },
  });
  expect(put.status).toBe(200);
  await completeSegment(recordingId, index, minio, testDb);
};

// one processed job with a fixed test owner
const runOnce = () =>
  processNextRecordingFinalizeJob({ database: testDb, storage: minio, ownerId: "test-worker" });

const artifactExists = async (recordingId: string, revision: number, leaf: string) => {
  const prefix = v2PlaybackPrefix(recordingId, revision);
  await minio.statObject(prefix.bucket, `${prefix.key}/${leaf}`);
};

describe("recording v2 finalize jobs", () => {
  beforeAll(async () => {
    await ensureTestDatabase();
    env.RECORDING_V2_ENABLED = true;
  });

  afterAll(() => {
    env.RECORDING_V2_ENABLED = false;
    void (async () => {
      for (const bucket of [env.BUCKET_RAW, env.BUCKET_MEDIA]) {
        const objects: string[] = [];
        for await (const item of minio.listObjectsV2(bucket, "recordings/")) {
          if (item.name) objects.push(item.name);
        }
        if (objects.length > 0) await minio.removeObjects(bucket, objects);
      }
    })();
  });

  beforeEach(async () => {
    await truncateTestDatabase();
    await testDb.insert(schema.project).values({ projectId: 9001, title: "P" });
    await testDb.insert(schema.session).values({ sessionId: 9001, projectId: 9001 });
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
    await testDb
      .insert(schema.masterVideo)
      .values({ masterVideoId: 9001, sessionId: 9001, startEpoch: 1000 });
    // no seeded videoClip: admission creates the clip row (uq_video_clip_result_id)
  });

  const identity = async () => bootstrapBackendIdentity(testDb);

  const admitMaster = async () => {
    const backend = await identity();
    const recordingId = randomUUID();
    await admitRecording(
      { recordingId, kind: "master", sessionId: 9001, startEpoch: 1000 },
      backend.instanceId,
      testDb
    );
    return recordingId;
  };

  const fixtureSegments = async (count: number) => {
    const dir = `/tmp/v2-fixtures-${randomUUID()}`;
    const paths = await generateSegments(dir, count);
    const bytes = await Promise.all(paths.map((p) => Bun.file(p).arrayBuffer()));
    return bytes.map((b) => new Uint8Array(b));
  };

  it("claims distinct jobs under a held row lock (SKIP LOCKED)", async () => {
    const first = await admitMaster();
    const second = await admitMaster();
    await scheduleRecordingFinalize(first, 1, undefined, testDb);
    await scheduleRecordingFinalize(second, 1, undefined, testDb);

    // hold job one's row on a separate connection
    const holder = new pg.Client({ connectionString: testDatabaseUrl });
    await holder.connect();
    await holder.query("BEGIN");
    const held = await holder.query(
      "SELECT job_id FROM recording_finalize_job WHERE recording_id = $1 FOR UPDATE",
      [first]
    );
    expect(held.rowCount).toBe(1);

    const claimed = await claimNextRecordingFinalizeJob("worker-a", testDb);
    expect(claimed!.recordingId).toBe(second);

    await holder.query("ROLLBACK");
    await holder.end();
  });

  it("reclaims a job whose lease has expired", async () => {
    const recordingId = await admitMaster();
    await scheduleRecordingFinalize(recordingId, 1, undefined, testDb);

    const first = await claimNextRecordingFinalizeJob("worker-a", testDb);
    expect(first!.leaseOwnerId).toBe("worker-a");

    await testDb
      .update(schema.recordingFinalizeJob)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.recordingFinalizeJob.jobId, first!.jobId));

    const reclaimed = await claimNextRecordingFinalizeJob("worker-b", testDb);
    expect(reclaimed!.jobId).toBe(first!.jobId);
    expect(reclaimed!.leaseOwnerId).toBe("worker-b");
  });

  it("completes an empty capture without publishing", async () => {
    const recordingId = await admitMaster();
    await stopRecording(recordingId, -1, testDb);

    const result = await runOnce();
    expect(result.status).toBe("completed");
    expect(result.detail).toBe("empty capture");

    const row = await testDb.query.recordingUpload.findFirst();
    expect(row!.publishedRevision).toBeNull();
    const job = await testDb.query.recordingFinalizeJob.findFirst();
    expect(job!.state).toBe("completed");
  });

  it("finalizes the whole declared range after a normal stop", async () => {
    const segments = await fixtureSegments(4);
    const recordingId = await admitMaster();
    // fixture slice 0 is a degenerate stub; real slices start at 1
    for (const [index, bytes] of segments.entries()) {
      if (index === 0) continue;
      await sealSegment(recordingId, index - 1, bytes);
    }
    const stopped = await stopRecording(recordingId, 2, testDb);
    expect(stopped.captureState).toBe("stopped");

    const result = await runOnce();
    expect(result.status).toBe("completed");

    const row = await testDb.query.recordingUpload.findFirst();
    const revision = row!.segmentRevision;
    expect(row!.publishedRevision).toBe(revision);

    for (const leaf of ["video.mkv", "hls/index.m3u8", "hls/media.ts", "poster.jpg"]) {
      await artifactExists(recordingId, revision, leaf);
    }
    await artifactExists(recordingId, revision, "timeline/000000000.jpg"); // masters get a filmstrip
  });

  it("defers until the declared range is complete, then finalizes", async () => {
    const segments = await fixtureSegments(4);
    const recordingId = await admitMaster();
    await sealSegment(recordingId, 0, segments[1]!);
    await sealSegment(recordingId, 1, segments[2]!);
    await stopRecording(recordingId, 2, testDb);

    const deferred = await runOnce();
    expect(deferred.status).toBe("deferred");

    await sealSegment(recordingId, 2, segments[3]!); // late drain of segment 2
    const done = await runOnce();
    expect(done.status).toBe("completed");

    const row = await testDb.query.recordingUpload.findFirst();
    expect(row!.publishedRevision).toBe(row!.segmentRevision);
  });

  it("publishes the contiguous prefix when a capture goes interrupted", async () => {
    const segments = await fixtureSegments(5);
    const recordingId = await admitMaster();
    await sealSegment(recordingId, 0, segments[1]!);
    await sealSegment(recordingId, 1, segments[2]!);
    await sealSegment(recordingId, 3, segments[4]!); // segment 2 never arrives

    // capture went silent: stale heartbeat, receipts older than the debounce
    await testDb
      .update(schema.recordingUpload)
      .set({ lastHeartbeatAt: new Date(Date.now() - 20_000) })
      .where(eq(schema.recordingUpload.recordingId, recordingId));
    await testDb.update(schema.recordingSegment).set({ storedAt: new Date(Date.now() - 10_000) });

    const result = await runOnce();
    expect(result.status).toBe("completed");

    const row = await testDb.query.recordingUpload.findFirst();
    expect(row!.captureState).toBe("interrupted");
    expect(row!.publishedRevision).not.toBeNull();

    const status = await getRecordingStatus(recordingId, testDb);
    expect(status.contiguousStoredThrough).toBe(1);
    expect(status.missingRanges).toEqual([[2, 2]]);
    await artifactExists(recordingId, row!.publishedRevision!, "video.mkv");
  });

  it("recovers late segments into a newer revision under the same uuid", async () => {
    const segments = await fixtureSegments(5);
    const recordingId = await admitMaster();
    await sealSegment(recordingId, 0, segments[1]!);
    await sealSegment(recordingId, 1, segments[2]!);
    await testDb
      .update(schema.recordingUpload)
      .set({ lastHeartbeatAt: new Date(Date.now() - 20_000) })
      .where(eq(schema.recordingUpload.recordingId, recordingId));
    await testDb.update(schema.recordingSegment).set({ storedAt: new Date(Date.now() - 10_000) });
    await runOnce(); // publishes revision for the prefix

    // late recovery: the rest arrives, then recovery-complete declares the end
    await sealSegment(recordingId, 2, segments[3]!);
    await sealSegment(recordingId, 3, segments[4]!);
    await recoveryCompleteRecording(recordingId, 3, testDb);
    // drain: revision 3 publishes first, then the receipts-changed job for 4
    for (let i = 0; i < 5; i++) {
      const done = await runOnce();
      if (done.status === "idle") break;
      expect(done.status).toBe("completed");
    }

    const row = await testDb.query.recordingUpload.findFirst();
    expect(row!.publishedRevision).toBe(row!.segmentRevision);
    expect(row!.publishedRevision!).toBeGreaterThan(0);
  });

  it("never lets a stale revision replace a newer published one", async () => {
    const recordingId = await admitMaster();
    await stopRecording(recordingId, -1, testDb);
    await testDb
      .update(schema.recordingUpload)
      .set({ publishedRevision: 99 })
      .where(eq(schema.recordingUpload.recordingId, recordingId));

    const job = await claimNextRecordingFinalizeJob("test-worker", testDb);
    const done = await completeRecordingFinalizeJob(
      job!.jobId,
      "test-worker",
      { recordingId, revision: job!.targetRevision },
      testDb
    );
    expect(done.completed).toBe(true);
    expect(done.published).toBe(true);

    const row = await testDb.query.recordingUpload.findFirst();
    expect(row!.publishedRevision).toBe(99);
  });

  it("backs off on failures and exhausts into a failed verdict", async () => {
    const segments = await fixtureSegments(2);
    const recordingId = await admitMaster();
    await sealSegment(recordingId, 0, segments[1]!);
    await stopRecording(recordingId, 0, testDb);

    // storage incident: the acknowledged object disappears under the receipt
    const leaf = v2SegmentLeaf(recordingId, 0);
    await minio.removeObject(leaf.bucket, leaf.key);

    for (let attempt = 1; attempt <= 4; attempt++) {
      const result = await runOnce();
      expect(result.status).toBe("failed");
      const job = await testDb.query.recordingFinalizeJob.findFirst();
      expect(job!.state).toBe("pending");
      expect(job!.attempts).toBe(attempt);
      expect(job!.lastError).toContain("Not Found");
      await testDb
        .update(schema.recordingFinalizeJob)
        .set({ nextAttemptAt: new Date() })
        .where(eq(schema.recordingFinalizeJob.jobId, job!.jobId));
    }

    const exhausted = await runOnce();
    expect(exhausted.status).toBe("failed");
    const job = await testDb.query.recordingFinalizeJob.findFirst();
    expect(job!.state).toBe("failed");
    expect(job!.attempts).toBe(5);
  });

  it("finalizes a clip independently of any master", async () => {
    const segments = await fixtureSegments(3);
    const backend = await identity();
    const clipRecording = randomUUID();
    await admitRecording(
      { recordingId: clipRecording, kind: "clip", resultId: 9001, masterVideoId: 9001, startOffsetMs: 500 },
      backend.instanceId,
      testDb
    );
    // index 0 of the clip carries a real (non-degenerate) fixture slice
    await sealSegment(clipRecording, 0, segments[1]!);
    await stopRecording(clipRecording, 0, testDb);

    const result = await runOnce();
    expect(result.status).toBe("completed");

    const row = await testDb.query.recordingUpload.findFirst();
    expect(row!.kind).toBe("clip");
    expect(row!.publishedRevision).toBe(row!.segmentRevision);
    await artifactExists(clipRecording, row!.publishedRevision!, "video.mkv");
    // clips carry no timeline filmstrip
    const prefix = v2PlaybackPrefix(clipRecording, row!.publishedRevision!);
    await expect(
      minio.statObject(prefix.bucket, `${prefix.key}/timeline/000000000.jpg`)
    ).rejects.toThrow();
  });
});
