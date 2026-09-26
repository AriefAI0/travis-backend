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
import { recordingRoutes } from "../../../src/features/recording/routes";
import * as schema from "../../../src/db/schema";
import { createVideoClip, updateVideoClip } from "../../../src/db/services/video.service";

const app = appFor(testDb, recordingRoutes);

// frozen key prefix every ingest fixture carries; these routes read object_key
const KEY_PREFIX = "1/1/214/2026/09/20/master/1";

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
  await testDb.insert(schema.project).values({ displayNumber: p.project, projectId: p.project, title: `P${p.project}` });
  await testDb.insert(schema.session).values({
    displayNumber: 1,
    sessionId: p.session,
    projectId: p.project,
    name: "Run 1",
  });
  await testDb.insert(schema.taskGroup).values({
    taskGroupId: p.asset,
    projectId: p.project,
    code: "100",
    label: "Rows",
  });
  await testDb.insert(schema.taskCode).values({
    taskCodeId: p.component,
    taskGroupId: p.asset,
    code: "101",
    label: "Row A",
  });
  await testDb.insert(schema.description).values({
    descriptionId: p.item,
    taskCodeId: p.component,
    label: "I",
  });
  // session_item is gone: v2 results carry their own target
  await testDb.insert(schema.result).values({
    displayNumber: p.sessionItem,
    resultId: p.sessionItem + 1, // unique per context
    inspectionTypeCode: "GVI",
        descriptionId: p.item,
        layer: 1,
        masterStartMs: 0,
    projectId: p.project,
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

  it("master visibility: unfinished follows the open ingest, not a status", async () => {
    await seedContext(baseContext);

    await testDb
      .update(schema.session)
      .set({ startEpoch: 1_755_684_000 })
      .where(eq(schema.session.sessionId, 101));
    const master = await testDb.query.session.findFirst({
      where: eq(schema.session.sessionId, 101),
    });
    const sessionId = master!.sessionId;

    // no ingest yet: nothing to sweep
    const idle = await app.request("/api/v1/recordings/unfinished");
    expect((await json(idle)).data).toHaveLength(0);

    // an open ingest makes the master unfinished, whatever its other columns say
    const [ingest] = await testDb
      .insert(schema.recordingIngest)
      .values({
        kind: "master",
        sessionId,
        ticketHash: "d".repeat(64),
        keyDate: "2026-09-20",
        keyPrefix: KEY_PREFIX,
      })
      .returning({ ingestId: schema.recordingIngest.ingestId });

    const unfinished = await app.request("/api/v1/recordings/unfinished");
    expect((await json(unfinished)).data).toHaveLength(1);

    // playback answers before any segment lands; an empty master has no HLS URL
    const empty = await app.request(
      `/api/v1/recordings/${sessionId}/playback?projectId=1`,
    );
    expect(empty.status).toBe(200);
    expect((await json(empty)).data.hlsUrl).toBeNull();

    // the idle sweep closes the ingest and the master leaves the list
    await testDb
      .update(schema.recordingIngest)
      .set({ closedAt: new Date(), finalSequence: -1 })
      .where(eq(schema.recordingIngest.ingestId, ingest!.ingestId));

    const sweep = await app.request("/api/v1/recordings/unfinished");
    expect((await json(sweep)).data).toHaveLength(0);
  });

  it("playback returns a scoped HLS URL as soon as segment zero is committed", async () => {
    await seedContext(baseContext);
    await testDb
      .update(schema.session)
      .set({ startEpoch: 1_755_684_000 })
      .where(eq(schema.session.sessionId, 101));
    const master = await testDb.query.session.findFirst({
      where: eq(schema.session.sessionId, 101),
    });
    const sessionId = master!.sessionId;

    // one open ingest with one contiguous segment: playable mid-capture
    const [ingest] = await testDb
      .insert(schema.recordingIngest)
      .values({
        kind: "master",
        sessionId,
        ticketHash: "a".repeat(64),
        keyDate: "2026-09-20",
        keyPrefix: KEY_PREFIX,
        contiguousSequence: 0,
      })
      .returning({ ingestId: schema.recordingIngest.ingestId });
    await testDb.insert(schema.recordingIngestSegment).values({
      ingestId: ingest!.ingestId,
      sequence: 0,
      checksumSha256: "b".repeat(64),
      sizeBytes: 1024,
      durationMs: 2000,
      objectKey: `1/1/101/2026/09/20/master/${sessionId}/segments/0000000000.ts`,
    });

    const open = await json<{ data: { hlsUrl: string } }>(
      await app.request(`/api/v1/recordings/${sessionId}/playback?projectId=1`),
    );
    expect(open.data.hlsUrl).toMatch(
      new RegExp(`^/api/v2/hls/master/${sessionId}/index[.]m3u8[?]t=[^&]+$`),
    );
    expect(open.data.hlsUrl).toContain("t=v1.");

    // closing it keeps the same URL playable
    await testDb
      .update(schema.recordingIngest)
      .set({ closedAt: new Date(), finalSequence: 0 })
      .where(eq(schema.recordingIngest.ingestId, ingest!.ingestId));

    const closed = await json<{ data: { hlsUrl: string } }>(
      await app.request(`/api/v1/recordings/${sessionId}/playback?projectId=1`),
    );
    expect(closed.data.hlsUrl).toContain(`/api/v2/hls/master/${sessionId}/index.m3u8`);
  });

  it("playback carries live status and duration plus minted media urls", async () => {
    await seedContext(baseContext);
    await testDb
      .update(schema.session)
      .set({ startEpoch: 1_755_684_000 })
      .where(eq(schema.session.sessionId, 101));
    const master = await testDb.query.session.findFirst({
      where: eq(schema.session.sessionId, 101),
    });
    const sessionId = master!.sessionId;

    // open ingest: two committed segments, 2 s each, live duration on the row
    const [ingest] = await testDb
      .insert(schema.recordingIngest)
      .values({
        kind: "master",
        sessionId,
        ticketHash: "f".repeat(64),
        keyDate: "2026-09-20",
        keyPrefix: KEY_PREFIX,
        contiguousSequence: 1,
        durationMs: 4000,
      })
      .returning({ ingestId: schema.recordingIngest.ingestId });
    for (const sequence of [0, 1]) {
      await testDb.insert(schema.recordingIngestSegment).values({
        ingestId: ingest!.ingestId,
        sequence,
        checksumSha256: "b".repeat(64),
        sizeBytes: 1024,
        durationMs: 2000,
        objectKey: `${KEY_PREFIX}/segments/000000000${sequence}.ts`,
      });
    }

    // one stored still, and one clip whose own ingest already holds segment zero
    await testDb.insert(schema.timelineThumbnail).values({
      sessionId,
      timestampMs: 0,
      storageStem: `${KEY_PREFIX}/timeline/000000000.jpg`,
      width: 320,
      height: 180,
      sizeBytes: 4096,
    });
    const clip = await createVideoClip(
      {
        resultId: baseContext.sessionItem + 1,
        sessionId,
        startOffsetMs: 0,
        endOffsetMs: 4000,
      },
      testDb,
    );
    const [clipIngest] = await testDb
      .insert(schema.recordingIngest)
      .values({
        kind: "clip",
        clipId: clip!.clipId,
        ticketHash: "c".repeat(64),
        keyDate: "2026-09-20",
        keyPrefix: KEY_PREFIX,
        contiguousSequence: 0,
      })
      .returning({ ingestId: schema.recordingIngest.ingestId });
    await testDb.insert(schema.recordingIngestSegment).values({
      ingestId: clipIngest!.ingestId,
      sequence: 0,
      checksumSha256: "d".repeat(64),
      sizeBytes: 1024,
      durationMs: 2000,
      objectKey: `${KEY_PREFIX}/segments/0000000000.ts`,
    });

    const { data } = await json<{
      data: {
        recordingStatus: string;
        durationMs: number | null;
        thumbnails: { timestampMs: number; url: string | null }[];
        events: { clipId: number; videoUrl: string | null; thumbnailUrl: string | null }[];
      };
    }>(await app.request(`/api/v1/recordings/${sessionId}/playback?projectId=1`));

    expect(data.recordingStatus).toBe("recording");
    // the master row has no duration until close: the open ingest supplies it
    expect(data.durationMs).toBe(4000);
    expect(data.thumbnails).toHaveLength(1);
    expect(data.thumbnails[0]!.url).toContain("travis-media");
    expect(data.events).toHaveLength(1);
    expect(data.events[0]!.videoUrl).toContain(`/api/v2/hls/clip/${clip!.clipId}/index.m3u8`);
    expect(data.events[0]!.thumbnailUrl).toBeNull();

    // closing flips the status; the same URL stays playable
    await testDb
      .update(schema.recordingIngest)
      .set({ closedAt: new Date(), finalSequence: 1 })
      .where(eq(schema.recordingIngest.ingestId, ingest!.ingestId));

    const closed = await json<{ data: { recordingStatus: string } }>(
      await app.request(`/api/v1/recordings/${sessionId}/playback?projectId=1`),
    );
    expect(closed.data.recordingStatus).toBe("finalized");
  });

  it("an event with no playable clip ingest gets a null videoUrl", async () => {
    await seedContext(baseContext);
    await testDb
      .update(schema.session)
      .set({ startEpoch: 1_755_684_000 , endEpoch: 1_755_684_300 })
      .where(eq(schema.session.sessionId, 101));
    const master = await testDb.query.session.findFirst({
      where: eq(schema.session.sessionId, 101),
    });
    const sessionId = master!.sessionId;

    // a clip with no ingest at all: nothing to play yet
    await createVideoClip(
      {
        resultId: baseContext.sessionItem + 1,
        sessionId,
        startOffsetMs: 0,
        endOffsetMs: 4000,
      },
      testDb,
    );

    const { data } = await json<{
      data: { recordingStatus: string; events: { videoUrl: string | null }[] };
    }>(await app.request(`/api/v1/recordings/${sessionId}/playback?projectId=1`));

    // no ingest at all reads as finalized, and the event stays unplayable
    expect(data.recordingStatus).toBe("finalized");
    expect(data.events).toHaveLength(1);
    expect(data.events[0]!.videoUrl).toBeNull();
  });

  it("playback stays unplayable for a closed master with no segments", async () => {
    await seedContext(baseContext);
    await testDb
      .update(schema.session)
      .set({ startEpoch: 1_755_684_000 })
      .where(eq(schema.session.sessionId, 101));
    const master = await testDb.query.session.findFirst({
      where: eq(schema.session.sessionId, 101),
    });
    await testDb.insert(schema.recordingIngest).values({
      kind: "master",
      sessionId: master!.sessionId,
      ticketHash: "c".repeat(64),
      keyDate: "2026-09-20",
      keyPrefix: KEY_PREFIX,
      closedAt: new Date(),
      finalSequence: -1,
    });

    const res = await json<{ data: { hlsUrl: string | null } }>(
      await app.request(`/api/v1/recordings/${master!.sessionId}/playback?projectId=1`),
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
      await testDb
        .update(schema.session)
        .set({ startEpoch: 1_755_684_000 })
        .where(eq(schema.session.sessionId, sessionId));
      await testDb.insert(schema.recordingIngest).values({
        kind: "master",
        sessionId,
        ticketHash: "e".repeat(64),
        keyDate: "2026-09-20",
        keyPrefix: KEY_PREFIX,
      });
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
    await testDb
      .update(schema.session)
      .set({ startEpoch: 1_755_684_000 , endEpoch: 1_755_684_300 })
      .where(eq(schema.session.sessionId, 101));
    const master = await testDb.query.session.findFirst({
      where: eq(schema.session.sessionId, 101),
    });
    const resultId = baseContext.sessionItem + 1;
    const clip = await createVideoClip(
      {
        resultId,
        sessionId: master!.sessionId,
        startOffsetMs: 0,
        endOffsetMs: null, // open clip
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

    // batch read keyed by resultId (stringified in JSON), timing facts carried
    const batch = await req("/api/v1/clips/by-result-ids", "POST", { resultIds: [resultId] });
    expect(batch.status).toBe(200);
    const byResult = (await json(batch)).data;
    expect(byResult[String(resultId)]).toHaveLength(1);
    expect(byResult[String(resultId)][0]).toMatchObject({
      clipId,
      resultId,
      startOffsetMs: 0,
      endOffsetMs: null,
    });

    // closing the clip empties the active sweep
    await updateVideoClip(clipId, { endOffsetMs: 5_000 }, testDb);
    const activeAfter = await app.request("/api/v1/clips/active?projectId=1");
    expect((await json(activeAfter)).data).toHaveLength(0);
  });
});
