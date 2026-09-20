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
  createMasterVideo,
  createVideoClip,
  deleteMasterVideo,
  deleteVideoClip,
  getMasterVideoPlaybackData,
  getMasterVideoById,
  getVideoClipById,
  getVideoClipPlaybackById,
  listMasterVideos,
  listMasterVideosByProjectId,
  listMasterVideosBySessionId,
  listVideoClips,
  listVideoClipsByMasterVideoId,
  listVideoClipsByResultId,
  replaceMasterVideoTimelineThumbnails,
  updateMasterVideo,
  updateVideoClip,
} from "../../src/db/services/video.service";

const seedVideoContext = async () => {
  await testDb.insert(schema.project).values({
    projectId: 1,
    title: "Project Alpha",
  });

  await testDb.insert(schema.session).values([
    {
      sessionId: 101,
      projectId: 1,
      name: "Run 1",
    },
    {
      sessionId: 102,
      projectId: 1,
      name: "Run 2",
    },
  ]);

  await testDb.insert(schema.asset).values({
    assetId: 1,
    projectId: 1,
    name: "Platform A",
  });

  await testDb.insert(schema.component).values({
    componentId: 10,
    assetId: 1,
    projectId: 1,
    name: "Jacket Leg",
  });

  await testDb.insert(schema.item).values({
    itemId: 100,
    componentId: 10,
    projectId: 1,
    assetId: 1,
    itemLabel: "JL-01",
    status: "pending",
  });

  await testDb.insert(schema.sessionItem).values({
    sessionItemId: 1000,
    sessionId: 101,
    itemId: 100,
  });

  await testDb.insert(schema.result).values([
    {
      resultId: 5001,
      sessionItemId: 1000,
      inspectionTypeCode: "GVI",
      projectId: 1,
      assetId: 1,
      componentId: 10,
      itemId: 100,
      sessionId: 101,
    },
    {
      resultId: 5002,
      sessionItemId: 1000,
      inspectionTypeCode: "GVI",
      projectId: 1,
      assetId: 1,
      componentId: 10,
      itemId: 100,
      sessionId: 101,
    },
    {
      resultId: 5003,
      sessionItemId: 1000,
      inspectionTypeCode: "GVI",
      projectId: 1,
      assetId: 1,
      componentId: 10,
      itemId: 100,
      sessionId: 101,
    },
  ]);
};

const seedProjectRecordingContext = async () => {
  await testDb.insert(schema.project).values([
    {
      projectId: 1,
      title: "Project Alpha",
    },
    {
      projectId: 2,
      title: "Project Beta",
    },
  ]);

  await testDb.insert(schema.session).values([
    {
      sessionId: 101,
      projectId: 1,
      name: "session-001",
    },
    {
      sessionId: 102,
      projectId: 1,
      name: "session-002",
    },
    {
      sessionId: 201,
      projectId: 2,
      name: "session-001",
    },
  ]);
};

describe("video.service", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  it("supports CRUD for master videos and lists them by session id", async () => {
    await seedVideoContext();

    const createdMasterVideo = await createMasterVideo(
      {
        sessionId: 101,
        startEpoch: 1_760_000_000,
        endEpoch: 1_760_003_600
      },
      testDb,
    );

    const secondMasterVideo = await createMasterVideo(
      {
        sessionId: 101,
        startEpoch: 1_760_086_400,
        endEpoch: null
      },
      testDb,
    );

    const thirdMasterVideo = await createMasterVideo(
      {
        sessionId: 102,
        startEpoch: 1_760_172_800,
        endEpoch: null
      },
      testDb,
    );

    expect(createdMasterVideo).toMatchObject({
      sessionId: 101,
      startEpoch: 1_760_000_000,
      endEpoch: 1_760_003_600,
    });
    expect(createdMasterVideo?.masterVideoId).toBeTypeOf("number");
    expect(await listMasterVideos(testDb)).toHaveLength(3);
    expect(
      await getMasterVideoById(createdMasterVideo!.masterVideoId, testDb),
    ).toMatchObject({
      sessionId: 101,
      startEpoch: 1_760_000_000,
    });

    const sessionMasterVideos = await listMasterVideosBySessionId(101, testDb);

    expect(sessionMasterVideos).toEqual([
      expect.objectContaining({
        masterVideoId: createdMasterVideo!.masterVideoId,
        sessionId: 101,
      }),
      expect.objectContaining({
        masterVideoId: secondMasterVideo!.masterVideoId,
        sessionId: 101,
      }),
    ]);

    const updatedMasterVideo = await updateMasterVideo(
      secondMasterVideo!.masterVideoId,
      {
        endEpoch: 1_760_087_400,
      },
      testDb,
    );

    expect(updatedMasterVideo).toMatchObject({
      masterVideoId: secondMasterVideo!.masterVideoId,
      endEpoch: 1_760_087_400,
    });

    const deletedMasterVideo = await deleteMasterVideo(
      thirdMasterVideo!.masterVideoId,
      testDb,
    );

    expect(deletedMasterVideo).toMatchObject({
      masterVideoId: thirdMasterVideo!.masterVideoId,
      sessionId: 102,
    });
  });

  it("lists master videos by project id with session names and timing facts", async () => {
    await seedProjectRecordingContext();

    const firstProjectOldRecording = await createMasterVideo(
      {
        sessionId: 101,
        startEpoch: 1_768_000_000,
        endEpoch: 1_768_000_500
      },
      testDb,
    );

    const firstProjectNewRecording = await createMasterVideo(
      {
        sessionId: 102,
        startEpoch: 1_768_003_600,
        endEpoch: null
      },
      testDb,
    );

    await createMasterVideo(
      {
        sessionId: 201,
        startEpoch: 1_768_007_200,
        endEpoch: null
      },
      testDb,
    );

    await expect(listMasterVideosByProjectId(0, testDb)).rejects.toThrow(
      "Project id must be a positive integer",
    );

    expect(await listMasterVideosByProjectId(1, testDb)).toEqual([
      {
        masterVideoId: firstProjectOldRecording!.masterVideoId,
        sessionId: 101,
        sessionName: "session-001",
        startEpoch: 1_768_000_000,
        endEpoch: 1_768_000_500,
        durationMs: null,
        // no timeline still has run, so the card face is absent
        thumbnailUrl: null,
      },
      {
        masterVideoId: firstProjectNewRecording!.masterVideoId,
        sessionId: 102,
        sessionName: "session-002",
        startEpoch: 1_768_003_600,
        endEpoch: null,
        durationMs: null,
        thumbnailUrl: null,
      },
    ]);
  });

  it("master thumbnailUrl mints the earliest timeline still", async () => {
    await seedVideoContext();

    const still = await createMasterVideo(
      { sessionId: 101, startEpoch: 1_768_000_000 },
      testDb,
    );

    // the thumbnail job has not run: no still, so no card face
    const before = await listMasterVideosByProjectId(1, testDb);
    expect(before[0]!.thumbnailUrl).toBeNull();

    // two stills land out of order: the earliest one is the card face
    await replaceMasterVideoTimelineThumbnails(
      still!.masterVideoId,
      [
        { masterVideoId: still!.masterVideoId, timestampMs: 1_800, width: 640, height: 360, sizeBytes: 1_024, storageStem: "1/1/101/2026/05/08/master/50/timeline/0000001800.jpg" },
        { masterVideoId: still!.masterVideoId, timestampMs: 1_500, width: 640, height: 360, sizeBytes: 1_024, storageStem: "1/1/101/2026/05/08/master/50/timeline/0000001500.jpg" },
      ],
      testDb,
    );

    const after = await listMasterVideosByProjectId(1, testDb);
    expect(after[0]!.thumbnailUrl).toContain("travis-media");
    expect(after[0]!.thumbnailUrl).toContain("0000001500.jpg");
  });

  it("supports CRUD for video clips and exposes playback metadata", async () => {
    await seedVideoContext();

    const masterVideo = await createMasterVideo(
      {
        sessionId: 101,
        startEpoch: 1_760_000_000,
        endEpoch: 1_760_003_600
      },
      testDb,
    );

    const createdVideoClip = await createVideoClip(
      {
        resultId: 5001,
        masterVideoId: masterVideo!.masterVideoId,
        startOffsetMs: 320_000,
        endOffsetMs: 350_000,
      },
      testDb,
    );

    const secondVideoClip = await createVideoClip(
      {
        resultId: 5003,
        masterVideoId: masterVideo!.masterVideoId,
        startOffsetMs: 500_000,
        endOffsetMs: 510_000,
      },
      testDb,
    );

    const thirdVideoClip = await createVideoClip(
      {
        resultId: 5002,
        masterVideoId: masterVideo!.masterVideoId,
        startOffsetMs: 600_000,
        endOffsetMs: 620_000,
      },
      testDb,
    );

    expect(createdVideoClip).toMatchObject({
      resultId: 5001,
      masterVideoId: masterVideo!.masterVideoId,
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
          masterVideoId: masterVideo!.masterVideoId,
          startOffsetMs: 700_000,
          endOffsetMs: 710_000,
        },
        testDb,
      ),
    ).rejects.toThrow();
    expect(
      await listVideoClipsByMasterVideoId(masterVideo!.masterVideoId, testDb),
    ).toHaveLength(3);

    const playback = await getVideoClipPlaybackById(createdVideoClip!.clipId, testDb);

    expect(playback).toEqual({
      clipId: createdVideoClip!.clipId,
      resultId: 5001,
      masterVideoId: masterVideo!.masterVideoId,
      masterVideoStartEpoch: 1_760_000_000,
      masterVideoEndEpoch: 1_760_003_600,
      masterVideoDurationMs: 3_600_000,
      startOffsetMs: 320_000,
      endOffsetMs: 350_000,
      durationMs: 30_000,
      startEpochMs: 1_760_000_320_000,
      endEpochMs: 1_760_000_350_000,
    });

    const updatedVideoClip = await updateVideoClip(
      createdVideoClip!.clipId,
      {
        startOffsetMs: 321_000,
        endOffsetMs: 351_000,
        storageStem: "clips/clip-5001-gvi-updated.mp4",
      },
      testDb,
    );

    expect(updatedVideoClip).toMatchObject({
      clipId: createdVideoClip!.clipId,
      startOffsetMs: 321_000,
      endOffsetMs: 351_000,
      storageStem: "clips/clip-5001-gvi-updated.mp4",
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

    const masterVideo = await createMasterVideo(
      {
        sessionId: 101,
        startEpoch: 1_760_000_000,
        endEpoch: 1_760_003_600
      },
      testDb,
    );

    // open clip: endOffsetMs null until completion flips it
    const activeVideoClip = await createVideoClip(
      {
        resultId: 5001,
        masterVideoId: masterVideo!.masterVideoId,
        startOffsetMs: 120_000,
        endOffsetMs: null,
      },
      testDb,
    );

    expect(activeVideoClip).toMatchObject({
      resultId: 5001,
      masterVideoId: masterVideo!.masterVideoId,
      startOffsetMs: 120_000,
      endOffsetMs: null,
    });

    expect(await getVideoClipPlaybackById(activeVideoClip!.clipId, testDb)).toEqual({
      clipId: activeVideoClip!.clipId,
      resultId: 5001,
      masterVideoId: masterVideo!.masterVideoId,
      masterVideoStartEpoch: 1_760_000_000,
      masterVideoEndEpoch: 1_760_003_600,
      masterVideoDurationMs: 3_600_000,
      startOffsetMs: 120_000,
      endOffsetMs: null,
      durationMs: null,
      startEpochMs: 1_760_000_120_000,
      endEpochMs: null,
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

  it("includes structured payloads in master video playback events", async () => {
    await seedVideoContext();

    const masterVideo = await createMasterVideo(
      {
        sessionId: 101,
        startEpoch: 1_760_000_000,
        endEpoch: 1_760_003_600
      },
      testDb,
    );

    const clip = await createVideoClip(
      {
        resultId: 5001,
        masterVideoId: masterVideo!.masterVideoId,
        startOffsetMs: 320_000,
        endOffsetMs: 350_000,
      },
      testDb,
    );

    await expect(
      getMasterVideoPlaybackData(1, masterVideo!.masterVideoId, testDb),
    ).resolves.toMatchObject({
      masterVideoId: masterVideo!.masterVideoId,
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

    await expect(
      createMasterVideo(
        {
          sessionId: 101,
          startEpoch: 1_760_000_000,
          endEpoch: 1_759_999_999
        },
        testDb,
      ),
    ).rejects.toThrow("Master video endEpoch must be greater than startEpoch");

    const masterVideo = await createMasterVideo(
      {
        sessionId: 101,
        startEpoch: 1_760_000_000,
        endEpoch: 1_760_000_100
      },
      testDb,
    );

    await expect(
      createVideoClip(
        {
          resultId: 5001,
          masterVideoId: masterVideo!.masterVideoId,
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
          masterVideoId: masterVideo!.masterVideoId,
          startOffsetMs: 90_000,
          endOffsetMs: 101_000,
        },
        testDb,
      ),
    ).rejects.toThrow("Video clip endOffsetMs exceeds master video duration");
  });

  it("two timeline stills 300ms apart both persist and list in time order", async () => {
    await seedVideoContext();

    const masterVideo = await createMasterVideo(
      {
        sessionId: 101,
        startEpoch: 1_760_000_000,
        endEpoch: 1_760_003_600
      },
      testDb,
    );

    // ms granularity: same-second stills are distinct rows, never overwrites
    await replaceMasterVideoTimelineThumbnails(
      masterVideo!.masterVideoId,
      [
        { masterVideoId: masterVideo!.masterVideoId, timestampMs: 1_800, width: 1_280, height: 720, sizeBytes: 2_048, storageStem: "p1/s101/master_1" },
        { masterVideoId: masterVideo!.masterVideoId, timestampMs: 1_500, width: 1_280, height: 720, sizeBytes: 2_048, storageStem: "p1/s101/master_1" },
      ],
      testDb,
    );

    const playback = await getMasterVideoPlaybackData(1, masterVideo!.masterVideoId, testDb);
    expect(playback!.thumbnails.map((t) => t.timestampMs)).toEqual([1_500, 1_800]);
    expect(playback!.thumbnails.every((t) => t.storageStem === "p1/s101/master_1")).toBe(true);
  });

  it("playback answers for a master with no outcome facts at all", async () => {
    await seedVideoContext();

    const masterVideo = await createMasterVideo(
      { sessionId: 101, startEpoch: 1_760_000_000 },
      testDb,
    );

    const playback = await getMasterVideoPlaybackData(1, masterVideo!.masterVideoId, testDb);
    expect(playback!.masterVideoId).toBe(masterVideo!.masterVideoId);
    expect(playback!.events).toEqual([]);
    expect(playback!.thumbnails).toEqual([]);
  });
});
