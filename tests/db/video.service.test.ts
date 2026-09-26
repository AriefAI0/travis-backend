import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";
import {
  createVideoClip,
  deleteVideoClip,
  getSessionPlaybackData,
  getVideoClipById,
  getVideoClipPlaybackById,
  listSessionRecordingsByProjectId,
  listVideoClips,
  listVideoClipsBySessionId,
  listVideoClipsByResultId,
  replaceSessionTimelineThumbnails,
  stampSessionRecordingEnd,
  stampSessionRecordingStart,
  updateVideoClip,
} from "../../src/db/services/video.service";

const seedVideoContext = async () => {
  await testDb.insert(schema.project).values({
    displayNumber: 1,
    projectId: 1,
    title: "Project Alpha",
  });

  await testDb.insert(schema.session).values([
    {
      displayNumber: 1,
      sessionId: 101,
      projectId: 1,
      name: "Run 1",
    },
    {
      displayNumber: 2,
      sessionId: 102,
      projectId: 1,
      name: "Run 2",
    },
  ]);

  // target chain: group > code > description (+ type + part code)
  await testDb.insert(schema.taskGroup).values({
    taskGroupId: 1,
    projectId: 1,
    code: "100",
    label: "Rows",
  });

  await testDb.insert(schema.taskCode).values({
    taskCodeId: 10,
    taskGroupId: 1,
    code: "101",
    label: "Row A",
  });

  await testDb.insert(schema.description).values({
    descriptionId: 100,
    taskCodeId: 10,
    label: "JL-01",
  });

  await testDb.insert(schema.type).values({
    typeId: 1,
    descriptionId: 100,
    code: "VDM",
    label: "VDM",
  });

  await testDb.insert(schema.inspectionForm).values({
    inspectionFormId: 1,
    projectId: 1,
    inspectionTypeCode: "GVI",
    version: 1,
  });

  await testDb.insert(schema.result).values([
    {
      displayNumber: 1,
      resultId: 5001,
      inspectionTypeCode: "GVI",
      projectId: 1,
      descriptionId: 100,
      layer: 1,
      masterStartMs: 0,
      inspectionFormId: 1,
      sessionId: 101,
    },
    {
      displayNumber: 2,
      resultId: 5002,
      inspectionTypeCode: "GVI",
      projectId: 1,
      descriptionId: 100,
      layer: 1,
      masterStartMs: 0,
      inspectionFormId: 1,
      sessionId: 101,
    },
    {
      displayNumber: 3,
      resultId: 5003,
      inspectionTypeCode: "GVI",
      projectId: 1,
      descriptionId: 100,
      layer: 1,
      masterStartMs: 0,
      inspectionFormId: 1,
      sessionId: 101,
    },
  ]);
};

const seedProjectRecordingContext = async () => {
  await testDb.insert(schema.project).values([
    {
      displayNumber: 1,
      projectId: 1,
      title: "Project Alpha",
    },
    {
      displayNumber: 2,
      projectId: 2,
      title: "Project Beta",
    },
  ]);

  await testDb.insert(schema.session).values([
    {
      sessionId: 101,
      projectId: 1,
      displayNumber: 1,
      name: "session-001",
    },
    {
      sessionId: 102,
      projectId: 1,
      displayNumber: 2,
      name: "session-002",
    },
    {
      sessionId: 201,
      projectId: 2,
      displayNumber: 1,
      name: "session-001",
    },
  ]);
};

// fixture: stamp recording anchors straight onto the session row
const stampRecording = async (
  sessionId: number,
  startEpoch: number,
  endEpoch?: number | null,
) => {
  await testDb
    .update(schema.session)
    .set({ startEpoch, endEpoch: endEpoch ?? null })
    .where(eq(schema.session.sessionId, sessionId));
};

describe("video.service", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  it("stamps the session recording start and end anchors", async () => {
    await seedVideoContext();

    await stampSessionRecordingStart(
      { sessionId: 101, startEpoch: 1_760_000_000 },
      testDb,
    );

    expect(
      await testDb.query.session.findFirst({
        where: eq(schema.session.sessionId, 101),
      }),
    ).toMatchObject({
      sessionId: 101,
      startEpoch: 1_760_000_000,
      endEpoch: null,
    });

    const closed = await stampSessionRecordingEnd(
      101,
      { endEpoch: 1_760_003_600, durationMs: 3_600_000 },
      testDb,
    );

    expect(closed).toMatchObject({
      sessionId: 101,
      endEpoch: 1_760_003_600,
      durationMs: 3_600_000,
    });
  });

  it("lists session recordings by project id with names and timing facts", async () => {
    await seedProjectRecordingContext();

    // sessions become recordings once the start anchor is stamped
    await stampRecording(101, 1_768_000_000, 1_768_000_500);
    await stampRecording(102, 1_768_003_600, null);
    // session 201 never recorded: excluded from the recording list

    await expect(listSessionRecordingsByProjectId(0, testDb)).rejects.toThrow(
      "Project id must be a positive integer",
    );

    expect(await listSessionRecordingsByProjectId(1, testDb)).toEqual([
      {
        sessionId: 101,
        sessionName: "session-001",
        // the card labels itself with this, not with sessionId
        sessionDisplayNumber: 1,
        startEpoch: 1_768_000_000,
        endEpoch: 1_768_000_500,
        durationMs: null,
        // no timeline still has run, so the card face is absent
        thumbnailUrl: null,
      },
      {
        sessionId: 102,
        sessionName: "session-002",
        sessionDisplayNumber: 2,
        startEpoch: 1_768_003_600,
        endEpoch: null,
        durationMs: null,
        thumbnailUrl: null,
      },
    ]);
  });

  it("master thumbnailUrl mints the earliest timeline still", async () => {
    await seedVideoContext();

    await stampRecording(101, 1_768_000_000);

    // the thumbnail job has not run: no still, so no card face
    const before = await listSessionRecordingsByProjectId(1, testDb);
    expect(before[0]!.thumbnailUrl).toBeNull();

    // two stills land out of order: the earliest one is the card face
    await replaceSessionTimelineThumbnails(
      101,
      [
        { sessionId: 101, timestampMs: 1_800, width: 640, height: 360, sizeBytes: 1_024, storageStem: "1/1/101/2026/05/08/master/50/timeline/0000001800.jpg" },
        { sessionId: 101, timestampMs: 1_500, width: 640, height: 360, sizeBytes: 1_024, storageStem: "1/1/101/2026/05/08/master/50/timeline/0000001500.jpg" },
      ],
      testDb,
    );

    const after = await listSessionRecordingsByProjectId(1, testDb);
    expect(after[0]!.thumbnailUrl).toContain("travis-media");
    expect(after[0]!.thumbnailUrl).toContain("0000001500.jpg");
  });

  it("supports CRUD for video clips and exposes playback metadata", async () => {
    await seedVideoContext();

    await stampRecording(101, 1_760_000_000, 1_760_003_600);

    const createdVideoClip = await createVideoClip(
      {
        resultId: 5001,
        sessionId: 101,
        startOffsetMs: 320_000,
        endOffsetMs: 350_000,
      },
      testDb,
    );

    const secondVideoClip = await createVideoClip(
      {
        resultId: 5003,
        sessionId: 101,
        startOffsetMs: 500_000,
        endOffsetMs: 510_000,
      },
      testDb,
    );

    const thirdVideoClip = await createVideoClip(
      {
        resultId: 5002,
        sessionId: 101,
        startOffsetMs: 600_000,
        endOffsetMs: 620_000,
      },
      testDb,
    );

    expect(createdVideoClip).toMatchObject({
      resultId: 5001,
      sessionId: 101,
      startOffsetMs: 320_000,
      endOffsetMs: 350_000,
    });
    expect(createdVideoClip?.clipId).toBeTypeOf("number");
    expect(await listVideoClips(testDb)).toHaveLength(3);
    expect(await getVideoClipById(createdVideoClip!.clipId, testDb)).toMatchObject({
      resultId: 5001,
    });
    // one clip per result (uq_video_clip_result_id): each list returns its clip
    expect(await listVideoClipsByResultId(5001, testDb)).toEqual([
      expect.objectContaining({ clipId: createdVideoClip!.clipId }),
    ]);
    expect(await listVideoClipsByResultId(5003, testDb)).toEqual([
      expect.objectContaining({ clipId: secondVideoClip!.clipId }),
    ]);
    // a second clip on the same result is rejected by the unique index
    await expect(
      createVideoClip(
        {
          resultId: 5001,
          sessionId: 101,
          startOffsetMs: 700_000,
          endOffsetMs: 710_000,
        },
        testDb,
      ),
    ).rejects.toThrow();
    expect(await listVideoClipsBySessionId(101, testDb)).toHaveLength(3);

    const playback = await getVideoClipPlaybackById(createdVideoClip!.clipId, testDb);

    expect(playback).toEqual({
      clipId: createdVideoClip!.clipId,
      resultId: 5001,
      sessionId: 101,
      sessionStartEpoch: 1_760_000_000,
      sessionEndEpoch: 1_760_003_600,
      masterDurationMs: 3_600_000,
      startOffsetMs: 320_000,
      endOffsetMs: 350_000,
      durationMs: 30_000,
      startEpochMs: 1_760_000_320_000,
      endEpochMs: 1_760_000_350_000,
      thumbnailKey: null,
    });

    const updatedVideoClip = await updateVideoClip(
      createdVideoClip!.clipId,
      {
        startOffsetMs: 321_000,
        endOffsetMs: 351_000,
      },
      testDb,
    );

    expect(updatedVideoClip).toMatchObject({
      clipId: createdVideoClip!.clipId,
      startOffsetMs: 321_000,
      endOffsetMs: 351_000,
    });

    const deletedVideoClip = await deleteVideoClip(thirdVideoClip!.clipId, testDb);

    expect(deletedVideoClip).toMatchObject({
      clipId: thirdVideoClip!.clipId,
      resultId: 5002,
    });

    const remainingVideoClip = await testDb.query.videoClip.findFirst({
      where: eq(schema.videoClip.clipId, thirdVideoClip!.clipId),
    });

    expect(remainingVideoClip).toBeUndefined();
  });

  it("supports open video clip lifecycle before and after completion", async () => {
    await seedVideoContext();

    await stampRecording(101, 1_760_000_000, 1_760_003_600);

    // open clip: endOffsetMs null until completion flips it
    const activeVideoClip = await createVideoClip(
      {
        resultId: 5001,
        sessionId: 101,
        startOffsetMs: 120_000,
        endOffsetMs: null,
      },
      testDb,
    );

    expect(activeVideoClip).toMatchObject({
      resultId: 5001,
      sessionId: 101,
      startOffsetMs: 120_000,
      endOffsetMs: null,
    });

    expect(await getVideoClipPlaybackById(activeVideoClip!.clipId, testDb)).toEqual({
      clipId: activeVideoClip!.clipId,
      resultId: 5001,
      sessionId: 101,
      sessionStartEpoch: 1_760_000_000,
      sessionEndEpoch: 1_760_003_600,
      masterDurationMs: 3_600_000,
      startOffsetMs: 120_000,
      endOffsetMs: null,
      durationMs: null,
      startEpochMs: 1_760_000_120_000,
      endEpochMs: null,
      thumbnailKey: null,
    });

    const completedVideoClip = await updateVideoClip(
      activeVideoClip!.clipId,
      { endOffsetMs: 180_000 },
      testDb,
    );

    expect(completedVideoClip).toMatchObject({
      clipId: activeVideoClip!.clipId,
      startOffsetMs: 120_000,
      endOffsetMs: 180_000,
    });
  });

  it("includes structured payloads in session playback events", async () => {
    await seedVideoContext();

    await stampRecording(101, 1_760_000_000, 1_760_003_600);

    const clip = await createVideoClip(
      {
        resultId: 5001,
        sessionId: 101,
        startOffsetMs: 320_000,
        endOffsetMs: 350_000,
      },
      testDb,
    );

    await expect(getSessionPlaybackData(1, 101, testDb)).resolves.toMatchObject({
      sessionId: 101,
      events: [
        {
          eventId: `clip-${clip!.clipId}`,
          resultId: 5001,
          clipId: clip!.clipId,
          inspectionTypeCode: "GVI",
        },
      ],
    });
  });

  it("rejects invalid video time ranges", async () => {
    await seedVideoContext();

    await stampSessionRecordingStart(
      { sessionId: 101, startEpoch: 1_760_000_000 },
      testDb,
    );

    await expect(
      stampSessionRecordingEnd(
        101,
        { endEpoch: 1_759_999_999 },
        testDb,
      ),
    ).rejects.toThrow("Recording endEpoch must be greater than startEpoch");

    await stampRecording(101, 1_760_000_000, 1_760_000_100);

    await expect(
      createVideoClip(
        {
          resultId: 5001,
          sessionId: 101,
          startOffsetMs: 10_000,
          endOffsetMs: 10_000,
        },
        testDb,
      ),
    ).rejects.toThrow("Video clip endOffsetMs must be greater than startOffsetMs");

    await expect(
      createVideoClip(
        {
          resultId: 5001,
          sessionId: 101,
          startOffsetMs: 90_000,
          endOffsetMs: 101_000,
        },
        testDb,
      ),
    ).rejects.toThrow("Video clip endOffsetMs exceeds the session recording duration");
  });

  it("two timeline stills 300ms apart both persist and list in time order", async () => {
    await seedVideoContext();

    await stampRecording(101, 1_760_000_000, 1_760_003_600);

    // ms granularity: same-second stills are distinct rows, never overwrites
    await replaceSessionTimelineThumbnails(
      101,
      [
        { sessionId: 101, timestampMs: 1_800, width: 1_280, height: 720, sizeBytes: 2_048, storageStem: "p1/s101/master_1" },
        { sessionId: 101, timestampMs: 1_500, width: 1_280, height: 720, sizeBytes: 2_048, storageStem: "p1/s101/master_1" },
      ],
      testDb,
    );

    const rows = await testDb.query.timelineThumbnail.findMany({
      where: eq(schema.timelineThumbnail.sessionId, 101),
      orderBy: schema.timelineThumbnail.timestampMs,
    });

    expect(rows.map((row) => row.timestampMs)).toEqual([1_500, 1_800]);
  });
});
