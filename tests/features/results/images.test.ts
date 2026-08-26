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
import { resultRoutes } from "../../../src/features/results/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, resultRoutes);

// project > session > asset > component > item > sessionItem > result (GVI)
const seedResultContext = async () => {
  await testDb.insert(schema.project).values({ projectId: 1, title: "Alpha" });
  await testDb.insert(schema.session).values({
    sessionId: 101,
    projectId: 1,
    name: "Run 1",
  });
  await testDb.insert(schema.asset).values({ assetId: 1, projectId: 1, name: "Platform A" });
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
  });
  await testDb.insert(schema.sessionItem).values({
    sessionItemId: 1000,
    sessionId: 101,
    itemId: 100,
  });
  await testDb.insert(schema.result).values({
    resultId: 5001,
    sessionItemId: 1000,
    inspectionTypeCode: "GVI",
    projectId: 1,
    assetId: 1,
    componentId: 10,
    itemId: 100,
    sessionId: 101,
  });
};

type Ticket = {
  imageId: number;
  storageStem: string;
  contentType: string;
  variant: string;
  url: string;
  expiresInSeconds: number;
};

const createImage = async (body: unknown) =>
  app.request("/api/v1/results/5001/images", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("evidence image routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("create mints the row and a presigned PUT, no clip involved", async () => {
    await seedResultContext();

    const res = await createImage({ contentType: "image/png" });
    expect(res.status).toBe(201);
    const { data } = await json<{ data: Ticket }>(res);
    expect(data.imageId).toBeGreaterThan(0);
    expect(data.variant).toBe("raw");
    expect(data.contentType).toBe("image/png");
    // stem derives from the result row alone, GVI prefix from its type
    expect(data.storageStem).toBe("p1/s101/GVI/result_5001");
    expect(data.url).toContain("travis-images");
    expect(data.url).toContain(`p1/s101/GVI/result_5001/img_${data.imageId}_raw.png`);
    expect(data.expiresInSeconds).toBe(900);

    // row persists the format and the un-annotated flag
    const row = (
      await testDb.select().from(schema.resultImage)
    )[0]!;
    expect(row).toMatchObject({
      resultId: 5001,
      storageStem: "p1/s101/GVI/result_5001",
      contentType: "image/png",
      hasAnnotated: false,
    });
  });

  it("create rejects an unsupported contentType with 400", async () => {
    await seedResultContext();

    const res = await createImage({ contentType: "image/gif" });
    expect(res.status).toBe(400);
    expect(await testDb.select().from(schema.resultImage)).toHaveLength(0);
  });

  it("create rejects an unknown field with 400 (strict body)", async () => {
    await seedResultContext();

    const res = await createImage({ contentType: "image/png", clipId: 9 });
    expect(res.status).toBe(400);
    expect(await testDb.select().from(schema.resultImage)).toHaveLength(0);
  });

  it("create on a missing result is 404", async () => {
    await seedResultContext();

    const res = await app.request("/api/v1/results/9999/images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentType: "image/png" }),
    });
    expect(res.status).toBe(404);
  });

  it("annotated re-addresses the same imageId and flips the flag", async () => {
    await seedResultContext();
    const { data } = await json<{ data: Ticket }>(await createImage({ contentType: "image/png" }));

    const res = await app.request(`/api/v1/images/${data.imageId}/annotated`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = await json<{ data: Ticket }>(res);
    expect(body.data.imageId).toBe(data.imageId);
    expect(body.data.variant).toBe("annotated");
    expect(body.data.url).toContain(`img_${data.imageId}_annotated.png`);

    const row = (await testDb.select().from(schema.resultImage))[0]!;
    expect(row.hasAnnotated).toBe(true);
  });

  it("annotated on a missing image is 404", async () => {
    await seedResultContext();

    const res = await app.request("/api/v1/images/9999/annotated", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("delete removes the row and 404s on repeat", async () => {
    await seedResultContext();
    const { data } = await json<{ data: Ticket }>(await createImage({ contentType: "image/png" }));

    const gone = await app.request(`/api/v1/images/${data.imageId}`, { method: "DELETE" });
    expect(gone.status).toBe(200);
    expect(await testDb.select().from(schema.resultImage)).toHaveLength(0);

    const again = await app.request(`/api/v1/images/${data.imageId}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("sidebar images carry minted URLs and the poster is the first snip", async () => {
    await seedResultContext();
    const first = await json<{ data: Ticket }>(await createImage({ contentType: "image/png" }));
    await createImage({ contentType: "image/jpeg" });

    const res = await app.request("/api/v1/items/100/results");
    expect(res.status).toBe(200);
    const { data } = await json(res);
    const entry = data.sessions[0].results[0];

    expect(entry.images).toHaveLength(2);
    // first image is png raw; second is jpeg raw (no annotated twin yet)
    expect(entry.images[0].url).toContain(`img_${first.data.imageId}_raw.png`);
    expect(entry.images[1].url).toContain("_raw.jpg");
    // poster = lowest imageId = the first snip taken
    expect(entry.posterUrl).toBe(entry.images[0].url);

    // after annotating the FIRST image, its url AND the poster flip leaves
    await app.request(`/api/v1/images/${first.data.imageId}/annotated`, { method: "POST" });
    const after = await json(await app.request("/api/v1/items/100/results"));
    const entryAfter = after.data.sessions[0].results[0];
    expect(entryAfter.images[0].url).toContain("_annotated.png");
    expect(entryAfter.images[1].url).toContain("_raw.jpg");
    expect(entryAfter.posterUrl).toBe(entryAfter.images[0].url);
  });

  it("sidebar clip videoUrl gates on finalized status", async () => {
    await seedResultContext();
    await createImage({ contentType: "image/png" });

    // clip still recording: stem present, url must be null
    await testDb.insert(schema.masterVideo).values({
      masterVideoId: 1,
      sessionId: 101,
      startEpoch: 1000,
      recordingStatus: "finalized",
    });
    await testDb.insert(schema.videoClip).values({
      clipId: 7,
      resultId: 5001,
      masterVideoId: 1,
      startOffsetMs: 10_000,
      endOffsetMs: 40_000,
      recordingStatus: "recording",
      storageStem: "p1/s101/master_1/GVI/clip_7",
    });

    const open = await json(await app.request("/api/v1/items/100/results"));
    const openClip = open.data.sessions[0].results[0].clips[0];
    expect(openClip.recordingStatus).toBe("recording");
    expect(openClip.videoUrl).toBeNull();
    // the still is written by the same finalize run, so it gates identically
    expect(openClip.thumbnailUrl).toBeNull();

    // finalized: url mints against the mkv leaf of the stem
    await testDb
      .update(schema.videoClip)
      .set({ recordingStatus: "finalized" })
      .where(eq(schema.videoClip.clipId, 7));
    const closed = await json(await app.request("/api/v1/items/100/results"));
    const closedClip = closed.data.sessions[0].results[0].clips[0];
    expect(closedClip.videoUrl).toContain("p1/s101/master_1/GVI/clip_7/video.mkv");
    // sibling of the mkv, thumbs bucket, same stem
    expect(closedClip.thumbnailUrl).toContain("travis-thumbs");
    expect(closedClip.thumbnailUrl).toContain("p1/s101/master_1/GVI/clip_7/poster.jpg");
  });

  it("clip thumbnailUrl is null when a finalized clip has no stem", async () => {
    await seedResultContext();
    await testDb.insert(schema.masterVideo).values({
      masterVideoId: 1,
      sessionId: 101,
      startEpoch: 1000,
      recordingStatus: "finalized",
    });
    // finalized but stem-less: nothing was ever written, so nothing mints
    await testDb.insert(schema.videoClip).values({
      clipId: 8,
      resultId: 5001,
      masterVideoId: 1,
      startOffsetMs: 0,
      endOffsetMs: 5_000,
      recordingStatus: "finalized",
      storageStem: null,
    });

    const res = await json(await app.request("/api/v1/results/5001/evidence"));
    expect(res.data.clips[0].videoUrl).toBeNull();
    expect(res.data.clips[0].thumbnailUrl).toBeNull();
  });

  it("evidence clips carry thumbnailUrl on the same gate as the sidebar", async () => {
    await seedResultContext();
    await testDb.insert(schema.masterVideo).values({
      masterVideoId: 1,
      sessionId: 101,
      startEpoch: 1000,
      recordingStatus: "finalized",
    });
    await testDb.insert(schema.videoClip).values({
      clipId: 9,
      resultId: 5001,
      masterVideoId: 1,
      startOffsetMs: 0,
      endOffsetMs: 5_000,
      recordingStatus: "finalized",
      storageStem: "p1/s101/master_1/GVI/clip_9",
    });

    const res = await json(await app.request("/api/v1/results/5001/evidence"));
    expect(res.data.clips[0].thumbnailUrl).toContain(
      "p1/s101/master_1/GVI/clip_9/poster.jpg",
    );
  });

  it("evidence read mirrors the sidebar media fields", async () => {
    await seedResultContext();
    await createImage({ contentType: "image/png" });

    const res = await app.request("/api/v1/results/5001/evidence");
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data.images[0].url).toContain("travis-images");
    expect(data.clips).toEqual([]);
  });
});
