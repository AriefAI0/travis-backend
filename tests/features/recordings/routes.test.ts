import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { recordingRoutes } from "../../../src/features/recordings/routes";
import * as schema from "../../../src/db/schema";
import {
  createMasterVideo,
  createVideoClip,
  markMasterVideoFinalized,
  updateVideoClip,
} from "../../../src/db/services/video.service";

const app = appFor(testDb, recordingRoutes);

// json request shorthand
const req = (path: string, method: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// denorm chain: project > session > asset > component > item > sessionItem
const seedContext = async (p: {
  project: number;
  session: number;
  asset: number;
  component: number;
  item: number;
  sessionItem: number;
}) => {
  await testDb.insert(schema.project).values({ projectId: p.project, title: `P${p.project}` });
  await testDb.insert(schema.session).values({
    sessionId: p.session,
    projectId: p.project,
    name: "Run 1",
  });
  await testDb.insert(schema.asset).values({
    assetId: p.asset,
    projectId: p.project,
    name: "Platform A",
  });
  await testDb.insert(schema.component).values({
    componentId: p.component,
    assetId: p.asset,
    projectId: p.project,
    name: "Jacket Leg",
  });
  await testDb.insert(schema.item).values({
    itemId: p.item,
    componentId: p.component,
    projectId: p.project,
    assetId: p.asset,
    itemLabel: "JL-01",
  });
  await testDb.insert(schema.sessionItem).values({
    sessionItemId: p.sessionItem,
    sessionId: p.session,
    itemId: p.item,
  });
  await testDb.insert(schema.result).values({
    resultId: p.sessionItem + 1, // unique per context
    sessionItemId: p.sessionItem,
    inspectionTypeCode: "GVI",
    projectId: p.project,
    assetId: p.asset,
    componentId: p.component,
    itemId: p.item,
    sessionId: p.session,
  });
};

const baseContext = {
  project: 1,
  session: 101,
  asset: 1,
  component: 10,
  item: 100,
  sessionItem: 1000,
};

// read surface only: recording lifecycle lives on the ingest transport.
// flow: seed rows via services > assert visibility reads respond with stems
describe("recordings routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("master visibility: unfinished lists recording, playback opens after finalize", async () => {
    await seedContext(baseContext);

    const master = await createMasterVideo(
      {
        sessionId: 101,
        storageStem: "p1/s101/master_1",
        startEpoch: 1_755_684_000,
        recordingStatus: "recording",
      },
      testDb,
    );
    const masterVideoId = master!.masterVideoId;

    // open master shows in the recovery sweep
    const unfinished = await app.request("/api/v1/recordings/unfinished");
    expect((await json(unfinished)).data).toHaveLength(1);

    // playback opens before finalize; an empty master has no HLS URL yet
    const empty = await app.request(
      `/api/v1/recordings/${masterVideoId}/playback?projectId=1`,
    );
    expect(empty.status).toBe(200);
    expect((await json(empty)).data.hlsUrl).toBeNull();

    // the finalize bridge path flips the row; playback then serves the stem
    await markMasterVideoFinalized(
      masterVideoId,
      {
        durationMs: 300_000,
        fileSize: null,
        endEpoch: 1_755_684_300,
      },
      testDb,
    );

    const playback = await app.request(
      `/api/v1/recordings/${masterVideoId}/playback?projectId=1`,
    );
    expect(playback.status).toBe(200);
    expect((await json(playback)).data.storageStem).toBe("p1/s101/master_1");

    const sweep = await app.request("/api/v1/recordings/unfinished");
    expect((await json(sweep)).data).toHaveLength(0);
  });

  it("playback returns a scoped HLS URL as soon as segment zero is committed", async () => {
    await seedContext(baseContext);
    const master = await createMasterVideo(
      { sessionId: 101, startEpoch: 1_755_684_000, recordingStatus: "recording" },
      testDb,
    );
    const masterVideoId = master!.masterVideoId;

    // one open ingest with one contiguous segment: playable mid-capture
    const [ingest] = await testDb
      .insert(schema.recordingIngest)
      .values({
        kind: "master",
        masterVideoId,
        ticketHash: "a".repeat(64),
        keyDate: "2026-09-20",
        contiguousSequence: 0,
      })
      .returning({ ingestId: schema.recordingIngest.ingestId });
    await testDb.insert(schema.recordingIngestSegment).values({
      ingestId: ingest!.ingestId,
      sequence: 0,
      checksumSha256: "b".repeat(64),
      sizeBytes: 1024,
      durationMs: 2000,
      objectKey: `1/1/101/2026/09/20/master/${masterVideoId}/segments/0000000000.ts`,
    });

    const open = await json<{ data: { hlsUrl: string } }>(
      await app.request(`/api/v1/recordings/${masterVideoId}/playback?projectId=1`),
    );
    expect(open.data.hlsUrl).toMatch(
      new RegExp(`^/api/v2/hls/master/${masterVideoId}/index[.]m3u8[?]t=[^&]+$`),
    );
    expect(open.data.hlsUrl).toContain("t=v1.");

    // closing it keeps the same URL playable
    await testDb
      .update(schema.recordingIngest)
      .set({ closedAt: new Date(), finalSequence: 0 })
      .where(eq(schema.recordingIngest.ingestId, ingest!.ingestId));

    const closed = await json<{ data: { hlsUrl: string } }>(
      await app.request(`/api/v1/recordings/${masterVideoId}/playback?projectId=1`),
    );
    expect(closed.data.hlsUrl).toContain(`/api/v2/hls/master/${masterVideoId}/index.m3u8`);
  });

  it("playback stays unplayable for a closed master with no segments", async () => {
    await seedContext(baseContext);
    const master = await createMasterVideo(
      { sessionId: 101, startEpoch: 1_755_684_000, recordingStatus: "recording" },
      testDb,
    );
    await testDb.insert(schema.recordingIngest).values({
      kind: "master",
      masterVideoId: master!.masterVideoId,
      ticketHash: "c".repeat(64),
      keyDate: "2026-09-20",
      closedAt: new Date(),
      finalSequence: -1,
    });

    const res = await json<{ data: { hlsUrl: string | null } }>(
      await app.request(`/api/v1/recordings/${master!.masterVideoId}/playback?projectId=1`),
    );
    expect(res.data.hlsUrl).toBeNull();
  });

  it("unfinished respects optional projectId filter", async () => {
    await seedContext(baseContext);
    await seedContext({
      project: 2,
      session: 202,
      asset: 2,
      component: 20,
      item: 200,
      sessionItem: 2000,
    });

    for (const sessionId of [101, 202]) {
      await createMasterVideo(
        {
          sessionId,
          storageStem: `p1/s${sessionId}/master_1`,
          startEpoch: 1_755_684_000,
          recordingStatus: "recording",
        },
        testDb,
      );
    }

    const all = await app.request("/api/v1/recordings/unfinished");
    expect((await json(all)).data).toHaveLength(2);

    const scoped = await app.request("/api/v1/recordings/unfinished?projectId=2");
    const rows = (await json(scoped)).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe(202);
  });

  it("missing master is 404 for get and playback", async () => {
    const get = await app.request("/api/v1/recordings/99999");
    expect(get.status).toBe(404);
    const playback = await app.request("/api/v1/recordings/99999/playback?projectId=1");
    expect(playback.status).toBe(404);
  });

  it("clip reads: active sweep and batch by-result-ids", async () => {
    await seedContext(baseContext);

    // clip range validation needs an existing master video
    const master = await createMasterVideo(
      {
        sessionId: 101,
        storageStem: "p1/s101/master_1",
        startEpoch: 1_755_684_000,
        endEpoch: 1_755_684_300,
        recordingStatus: "finalized",
      },
      testDb,
    );
    const resultId = baseContext.sessionItem + 1;
    const clip = await createVideoClip(
      {
        resultId,
        masterVideoId: master!.masterVideoId,
        startOffsetMs: 0,
        endOffsetMs: null, // open clip
        storageStem: "p1/s101/clip_1",
        recordingStatus: "recording",
      },
      testDb,
    );
    const clipId = clip!.clipId;

    // active sweeps see it, project- and session-scoped
    const activeProject = await app.request("/api/v1/clips/active?projectId=1");
    expect((await json(activeProject)).data).toHaveLength(1);
    const activeSession = await app.request("/api/v1/clips/active?sessionId=101");
    expect((await json(activeSession)).data).toHaveLength(1);
    const activeOther = await app.request("/api/v1/clips/active?projectId=2");
    expect((await json(activeOther)).data).toHaveLength(0);

    // batch read keyed by resultId (stringified in JSON), stem carried
    const batch = await req("/api/v1/clips/by-result-ids", "POST", { resultIds: [resultId] });
    expect(batch.status).toBe(200);
    const byResult = (await json(batch)).data;
    expect(byResult[String(resultId)]).toHaveLength(1);
    expect(byResult[String(resultId)][0].storageStem).toBe("p1/s101/clip_1");

    // closing the clip empties the active sweep
    await updateVideoClip(clipId, { endOffsetMs: 5_000 }, testDb);
    const activeAfter = await app.request("/api/v1/clips/active?projectId=1");
    expect((await json(activeAfter)).data).toHaveLength(0);
  });
});
