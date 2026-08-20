import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";
import {
  cancelInspectionClip,
  getActiveInspectionClip,
  startInspectionClip,
  startInspectionClipFromRecording,
  stopInspectionClip,
} from "../../src/db/services/inspection-clip.service";
import {
  createMasterVideo,
  updateVideoClip,
} from "../../src/db/services/video.service";

const seedInspectionClipContext = async () => {
  const project = await testDb
    .insert(schema.project)
    .values({
      title: "Project Alpha",
    })
    .returning()
    .then((rows) => rows[0]!);

  const session = await testDb
    .insert(schema.session)
    .values({
      projectId: project.projectId,
      name: "Run 1",
      startedAt: new Date(),
    })
    .returning()
    .then((rows) => rows[0]!);

  const asset = await testDb
    .insert(schema.asset)
    .values({
      projectId: project.projectId,
      name: "Platform A",
      assetType: "Structure",
    })
    .returning()
    .then((rows) => rows[0]!);

  const component = await testDb
    .insert(schema.component)
    .values({
      assetId: asset.assetId,
      projectId: project.projectId,
      name: "Jacket Leg",
    })
    .returning()
    .then((rows) => rows[0]!);

  const item = await testDb
    .insert(schema.item)
    .values({
      componentId: component.componentId,
      projectId: project.projectId,
      assetId: asset.assetId,
      itemLabel: "JL-01",
      position: "POS-001",
      status: "pending",
    })
    .returning()
    .then((rows) => rows[0]!);

  const sessionItem = await testDb
    .insert(schema.sessionItem)
    .values({
      sessionId: session.sessionId,
      itemId: item.itemId,
    })
    .returning()
    .then((rows) => rows[0]!);

  const masterVideo = await createMasterVideo(
    {
      sessionId: session.sessionId,
      fileUrl: "file://inspection-videos/session-001.mkv",
      startEpoch: 1_760_000_000,
      endEpoch: 1_760_003_600,
    },
    testDb,
  );

  return { project, session, asset, component, item, sessionItem, masterVideo };
};

describe("inspection-clip.service", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  const markClipFileUrl = async (clipId: number) => {
    const clipFileUrl =
      "travis-media/project-1/evidence/items/item-100/clips/gvi/clip-1/JL-01_gvi_20260514-120530.mp4";
    const updatedClip = await updateVideoClip(clipId, { clipFileUrl }, testDb);

    expect(updatedClip).toMatchObject({ clipId, clipFileUrl });

    return clipFileUrl;
  };

  it("starts an inspection clip by creating a result and active video clip", async () => {
    const ctx = await seedInspectionClipContext();

    const lifecycle = await startInspectionClip(
      {
        sessionItemId: ctx.sessionItem.sessionItemId,
        inspectionTypeCode: "GVI",
        projectId: ctx.project.projectId,
        assetId: ctx.asset.assetId,
        componentId: ctx.component.componentId,
        itemId: ctx.item.itemId,
        sessionId: ctx.session.sessionId,
        masterVideoId: ctx.masterVideo!.masterVideoId,
        startOffsetMs: 120_000,
        remarks: "Initial GVI sweep",
      },
      testDb,
    );

    expect(lifecycle.result).toMatchObject({
      sessionItemId: ctx.sessionItem.sessionItemId,
      inspectionTypeCode: "GVI",
      remarks: "Initial GVI sweep",
    });
    expect(lifecycle.clip).toMatchObject({
      resultId: lifecycle.result!.resultId,
      masterVideoId: ctx.masterVideo!.masterVideoId,
      startOffsetMs: 120_000,
      endOffsetMs: null,
      clipFileUrl: null,
      thumbnailUrl: null,
    });

    await expect(
      getActiveInspectionClip(
        {
          sessionItemId: ctx.sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
        },
        testDb,
      ),
    ).resolves.toMatchObject({
      result: {
        resultId: lifecycle.result!.resultId,
      },
      clip: {
        clipId: lifecycle.clip!.clipId,
      },
    });
  });

  it("rejects starting a duplicate active clip for the same session item and inspection type", async () => {
    const ctx = await seedInspectionClipContext();

    await startInspectionClip(
      {
        sessionItemId: ctx.sessionItem.sessionItemId,
        inspectionTypeCode: "GVI",
        projectId: ctx.project.projectId,
        assetId: ctx.asset.assetId,
        componentId: ctx.component.componentId,
        itemId: ctx.item.itemId,
        sessionId: ctx.session.sessionId,
        masterVideoId: ctx.masterVideo!.masterVideoId,
        startOffsetMs: 120_000,
      },
      testDb,
    );

    await expect(
      startInspectionClip(
        {
          sessionItemId: ctx.sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: ctx.project.projectId,
          assetId: ctx.asset.assetId,
          componentId: ctx.component.componentId,
          itemId: ctx.item.itemId,
          sessionId: ctx.session.sessionId,
          masterVideoId: ctx.masterVideo!.masterVideoId,
          startOffsetMs: 180_000,
        },
        testDb,
      ),
    ).rejects.toThrow(
      "An inspection clip is already in progress for this session item and inspection type",
    );

    await expect(
      startInspectionClip(
        {
          sessionItemId: ctx.sessionItem.sessionItemId,
          inspectionTypeCode: "CVI",
          projectId: ctx.project.projectId,
          assetId: ctx.asset.assetId,
          componentId: ctx.component.componentId,
          itemId: ctx.item.itemId,
          sessionId: ctx.session.sessionId,
          masterVideoId: ctx.masterVideo!.masterVideoId,
          startOffsetMs: 180_000,
        },
        testDb,
      ),
    ).resolves.toBeDefined();
  });

  it("starts an inspection clip from recording context by resolving session item and denorm IDs", async () => {
    const ctx = await seedInspectionClipContext();

    const item2 = await testDb
      .insert(schema.item)
      .values({
        itemId: 101,
        componentId: ctx.component.componentId,
        projectId: ctx.project.projectId,
        assetId: ctx.asset.assetId,
        itemLabel: "JL-02",
        position: "POS-002",
        status: "pending",
      })
      .returning()
      .then((rows) => rows[0]!);

    const lifecycle = await startInspectionClipFromRecording(
      {
        sessionId: ctx.session.sessionId,
        itemId: item2.itemId,
        inspectionTypeCode: "CVI",
        masterVideoId: ctx.masterVideo!.masterVideoId,
        startOffsetMs: 240_000,
        remarks: "Close visual pass",
      },
      testDb,
    );

    const createdSessionItem = await testDb.query.sessionItem.findFirst({
      where: (sessionItem, { and, eq }) =>
        and(eq(sessionItem.sessionId, ctx.session.sessionId), eq(sessionItem.itemId, item2.itemId)),
    });

    expect(createdSessionItem).toBeDefined();
    expect(lifecycle.result).toMatchObject({
      sessionItemId: createdSessionItem!.sessionItemId,
      inspectionTypeCode: "CVI",
      remarks: "Close visual pass",
    });
    expect(lifecycle.clip).toMatchObject({
      masterVideoId: ctx.masterVideo!.masterVideoId,
      startOffsetMs: 240_000,
      endOffsetMs: null,
    });
  });

  it("stops an active inspection clip and completes the linked result", async () => {
    const ctx = await seedInspectionClipContext();
    const lifecycle = await startInspectionClip(
      {
        sessionItemId: ctx.sessionItem.sessionItemId,
        inspectionTypeCode: "GVI",
        projectId: ctx.project.projectId,
        assetId: ctx.asset.assetId,
        componentId: ctx.component.componentId,
        itemId: ctx.item.itemId,
        sessionId: ctx.session.sessionId,
        masterVideoId: ctx.masterVideo!.masterVideoId,
        startOffsetMs: 120_000,
      },
      testDb,
    );
    const clipFileUrl = await markClipFileUrl(lifecycle.clip!.clipId);

    const completedLifecycle = await stopInspectionClip(
      {
        clipId: lifecycle.clip!.clipId,
        endOffsetMs: 180_000,
        thumbnailUrl: " thumbnails/session-001-gvi.jpg ",
      },
      testDb,
    );

    expect(completedLifecycle).toMatchObject({
      result: {
        resultId: lifecycle.result!.resultId,
      },
      clip: {
        clipId: lifecycle.clip!.clipId,
        startOffsetMs: 120_000,
        endOffsetMs: 180_000,
        clipFileUrl,
        // Thumbnails are disabled (generation commented out), so an explicit
        // thumbnailUrl is ignored and null is stored.
        thumbnailUrl: null,
      },
    });

    await expect(
      getActiveInspectionClip(
        {
          sessionItemId: ctx.sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
        },
        testDb,
      ),
    ).resolves.toBeNull();

    await expect(
      stopInspectionClip(
        {
          clipId: lifecycle.clip!.clipId,
          endOffsetMs: 190_000,
        },
        testDb,
      ),
    ).rejects.toThrow(`Video clip ${lifecycle.clip!.clipId} has already been completed`);
  });

  it("stops an active inspection clip and saves a structured payload", async () => {
    const ctx = await seedInspectionClipContext();
    const lifecycle = await startInspectionClip(
      {
        sessionItemId: ctx.sessionItem.sessionItemId,
        inspectionTypeCode: "MGI",
        projectId: ctx.project.projectId,
        assetId: ctx.asset.assetId,
        componentId: ctx.component.componentId,
        itemId: ctx.item.itemId,
        sessionId: ctx.session.sessionId,
        masterVideoId: ctx.masterVideo!.masterVideoId,
        startOffsetMs: 120_000,
      },
      testDb,
    );
    await markClipFileUrl(lifecycle.clip!.clipId);

    await expect(
      stopInspectionClip(
        {
          clipId: lifecycle.clip!.clipId,
          endOffsetMs: 180_000,
          thumbnailUrl: "thumbnails/session-001-mgi.jpg",
          payload: {
            kind: "mgi",
            version: 1,
            findings: [
              {
                id: "finding-1",
                growthType: "hard",
                species: "Barnacles",
                coverageBand: "moderate",
                thicknessMm: 12,
              },
            ],
            criteria: { hardGrowthLimitMm: 10 },
            noMgObserved: false,
          },
        },
        testDb,
      ),
    ).resolves.toMatchObject({
      result: {
        resultId: lifecycle.result!.resultId,
      },
      clip: {
        clipId: lifecycle.clip!.clipId,
        endOffsetMs: 180_000,
      },
    });
  });

  it("stores a null thumbnail when stopping a clip (generation disabled)", async () => {
    const ctx = await seedInspectionClipContext();
    const lifecycle = await startInspectionClip(
      {
        sessionItemId: ctx.sessionItem.sessionItemId,
        inspectionTypeCode: "GVI",
        projectId: ctx.project.projectId,
        assetId: ctx.asset.assetId,
        componentId: ctx.component.componentId,
        itemId: ctx.item.itemId,
        sessionId: ctx.session.sessionId,
        masterVideoId: ctx.masterVideo!.masterVideoId,
        startOffsetMs: 120_000,
      },
      testDb,
    );
    const clipFileUrl = await markClipFileUrl(lifecycle.clip!.clipId);
    const thumbnailGeneratorCalls: unknown[] = [];
    const thumbnailGenerator = {
      generateClipVideoThumbnail: async (input: unknown) => {
        thumbnailGeneratorCalls.push(input);
        return "travis-media/project-1/evidence/items/item-100/clips/gvi/clip-1/JL-01_gvi_20260514-120530.jpg";
      },
    };

    const completedLifecycle = await stopInspectionClip(
      {
        clipId: lifecycle.clip!.clipId,
        endOffsetMs: 180_000,
      },
      testDb,
      {
        thumbnailGenerator,
      },
    );

    expect(thumbnailGeneratorCalls).toEqual([]);
    expect(completedLifecycle).toMatchObject({
      clip: {
        clipId: lifecycle.clip!.clipId,
        thumbnailUrl: null,
        clipFileUrl,
      },
    });
  });

  it("ignores an explicit thumbnailUrl when stopping (generation disabled)", async () => {
    const ctx = await seedInspectionClipContext();
    const lifecycle = await startInspectionClip(
      {
        sessionItemId: ctx.sessionItem.sessionItemId,
        inspectionTypeCode: "GVI",
        projectId: ctx.project.projectId,
        assetId: ctx.asset.assetId,
        componentId: ctx.component.componentId,
        itemId: ctx.item.itemId,
        sessionId: ctx.session.sessionId,
        masterVideoId: ctx.masterVideo!.masterVideoId,
        startOffsetMs: 120_000,
      },
      testDb,
    );
    await markClipFileUrl(lifecycle.clip!.clipId);
    const thumbnailGenerator = {
      generateClipVideoThumbnail: async () => {
        throw new Error("Thumbnail generator should not be called");
      },
    };

    await expect(
      stopInspectionClip(
        {
          clipId: lifecycle.clip!.clipId,
          endOffsetMs: 180_000,
          thumbnailUrl: " thumbnails/session-001-gvi.jpg ",
        },
        testDb,
        {
          thumbnailGenerator,
        },
      ),
    ).resolves.toMatchObject({
      clip: {
        clipId: lifecycle.clip!.clipId,
        thumbnailUrl: null,
      },
    });
  });

  it("completes the clip even when the thumbnail generator would fail (generation disabled)", async () => {
    const ctx = await seedInspectionClipContext();
    const lifecycle = await startInspectionClip(
      {
        sessionItemId: ctx.sessionItem.sessionItemId,
        inspectionTypeCode: "GVI",
        projectId: ctx.project.projectId,
        assetId: ctx.asset.assetId,
        componentId: ctx.component.componentId,
        itemId: ctx.item.itemId,
        sessionId: ctx.session.sessionId,
        masterVideoId: ctx.masterVideo!.masterVideoId,
        startOffsetMs: 120_000,
      },
      testDb,
    );
    const clipFileUrl = await markClipFileUrl(lifecycle.clip!.clipId);
    const thumbnailGenerator = {
      generateClipVideoThumbnail: async () => {
        throw new Error("Thumbnail generation failed");
      },
    };

    await expect(
      stopInspectionClip(
        {
          clipId: lifecycle.clip!.clipId,
          endOffsetMs: 180_000,
        },
        testDb,
        {
          thumbnailGenerator,
        },
      ),
    ).resolves.toMatchObject({
      clip: {
        clipId: lifecycle.clip!.clipId,
        endOffsetMs: 180_000,
        clipFileUrl,
        thumbnailUrl: null,
      },
    });
  });

  it("cancels an active inspection clip by removing the clip and result", async () => {
    const ctx = await seedInspectionClipContext();
    const lifecycle = await startInspectionClip(
      {
        sessionItemId: ctx.sessionItem.sessionItemId,
        inspectionTypeCode: "GVI",
        projectId: ctx.project.projectId,
        assetId: ctx.asset.assetId,
        componentId: ctx.component.componentId,
        itemId: ctx.item.itemId,
        sessionId: ctx.session.sessionId,
        masterVideoId: ctx.masterVideo!.masterVideoId,
        startOffsetMs: 120_000,
      },
      testDb,
    );

    await expect(
      cancelInspectionClip(
        {
          clipId: lifecycle.clip!.clipId,
        },
        testDb,
      ),
    ).resolves.toMatchObject({
      result: {
        resultId: lifecycle.result!.resultId,
      },
      clip: {
        clipId: lifecycle.clip!.clipId,
        endOffsetMs: null,
        clipFileUrl: null,
      },
    });

    await expect(
      getActiveInspectionClip(
        {
          sessionItemId: ctx.sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
        },
        testDb,
      ),
    ).resolves.toBeNull();

    await expect(
      cancelInspectionClip(
        {
          clipId: lifecycle.clip!.clipId,
        },
        testDb,
      ),
    ).resolves.toBeNull();
  });
});
