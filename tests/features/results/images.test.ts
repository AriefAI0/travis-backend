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
  await testDb.insert(schema.project).values({ displayNumber: 1, projectId: 1, title: "Alpha" });
  await testDb.insert(schema.session).values({
    displayNumber: 1,
    sessionId: 101,
    projectId: 1,
    name: "Run 1",
  });
  await testDb.insert(schema.taskGroup).values({
    taskGroupId: 1,
    projectId: 1,
    code: "100",
  });
  await testDb.insert(schema.taskCode).values({
    taskCodeId: 10,
    taskGroupId: 1,
    code: "101",
  });
  await testDb.insert(schema.description).values({
    descriptionId: 100,
    taskCodeId: 10,
    label: "JL-01",
  });
  // session_item is gone: v2 results carry their own target
  await testDb.insert(schema.result).values({
    displayNumber: 5001,
    resultId: 5001,
    inspectionTypeCode: "GVI",
        descriptionId: 100,
        layer: 1,
        masterStartMs: 0,
    projectId: 1,
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

// The seeded session has no master, so the stem dates from the session row.
// Reading it back keeps the assertion off the wall clock.
const sessionStem = async (resultId: number, label: string) => {
  const [row] = await testDb.select().from(schema.session);
  const iso = row!.createdAt.toISOString();
  const day = iso.slice(0, 10);
  const clock = iso.slice(11, 16).replace(":", "");
  return `1-alpha-${day}/session-1-${day}-${clock}/results/${resultId}-${label}/evidence-img`;
};

// One master and one clip on the seeded result: the home an evidence image
// takes once the clip exists.
const seedMasterAndClip = async (startEpoch: number) => {
  await testDb
    .update(schema.session)
    .set({ startEpoch })
    .where(eq(schema.session.sessionId, 101));
  await testDb.insert(schema.videoClip).values({
    clipId: 7,
    resultId: 5001,
    sessionId: 101,
    startOffsetMs: 0,
  });
};

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
    // a result with no clip lands under results/<resultId>-<itemSlug>
    const stem = await sessionStem(5001, "jl-01");
    expect(data.storageStem).toBe(stem);
    expect(data.url).toContain("travis-media");
    expect(data.url).toContain(`${stem}/${data.imageId}.png`);
    expect(data.expiresInSeconds).toBe(900);

    // row persists the format and the un-annotated flag
    const row = (
      await testDb.select().from(schema.resultImage)
    )[0]!;
    expect(row).toMatchObject({
      resultId: 5001,
      storageStem: data.storageStem,
      contentType: "image/png",
      hasAnnotated: false,
    });
  });

  // With a clip the image sits beside it, and the date comes from the master.
  // The folder leads with the RESULT's ordinal (5001 here), not the clip id.
  it("create nests under the clip folder once a clip exists", async () => {
    await seedResultContext();
    await seedMasterAndClip(1000);

    const { data } = await json<{ data: Ticket }>(await createImage({ contentType: "image/png" }));

    const stem = "1-alpha-1970-01-01/session-1-1970-01-01-0016/clips/5001-jl-01-gvi/evidence-img";
    expect(data.storageStem).toBe(stem);
    expect(data.url).toContain(`${stem}/${data.imageId}.png`);
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
    expect(body.data.url).toContain(`${data.storageStem}/${data.imageId}-annotated.png`);

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
    const second = await json<{ data: Ticket }>(await createImage({ contentType: "image/jpeg" }));

    const res = await app.request("/api/v1/descriptions/100/results");
    expect(res.status).toBe(200);
    const { data } = await json(res);
    const entry = data.sessions[0].results[0];

    expect(entry.images).toHaveLength(2);
    // first image is png raw; second is jpeg raw (no annotated twin yet)
    expect(entry.images[0].url).toContain(`/${first.data.imageId}.png`);
    expect(entry.images[1].url).toContain(`/${second.data.imageId}.jpg`);
    // poster = lowest imageId = the first snip taken
    expect(entry.posterUrl).toBe(entry.images[0].url);

    // after annotating the FIRST image, its url AND the poster flip leaves
    await app.request(`/api/v1/images/${first.data.imageId}/annotated`, { method: "POST" });
    const after = await json(await app.request("/api/v1/descriptions/100/results"));
    const entryAfter = after.data.sessions[0].results[0];
    expect(entryAfter.images[0].url).toContain(`/${first.data.imageId}-annotated.png`);
    expect(entryAfter.images[1].url).toContain(`/${second.data.imageId}.jpg`);
    expect(entryAfter.posterUrl).toBe(entryAfter.images[0].url);
  });

  // Images uploaded before the readable layout keep resolving: a legacy stem
  // still mints the names already on disk.
  it("a legacy numeric stem still mints its legacy leaf names", async () => {
    await seedResultContext();
    await testDb.insert(schema.resultImage).values({
      imageId: 61,
      resultId: 5001,
      storageStem: "1/1/101/2026/09/20/results/5001",
      contentType: "image/png",
      hasAnnotated: true,
    });

    const { data } = await json(await app.request("/api/v1/descriptions/100/results"));
    const entry = data.sessions[0].results[0];

    expect(entry.images[0].url).toContain("img_61_annotated.png");
    expect(entry.images[0].url).not.toContain("evidence-img");
  });

  it("sidebar clip videoUrl follows stored segments, never the outcome status", async () => {
    await seedResultContext();
    await createImage({ contentType: "image/png" });

    await testDb
      .update(schema.session)
      .set({ startEpoch: 1000 })
      .where(eq(schema.session.sessionId, 101));
    // status and stem say nothing about playability any more
    await testDb.insert(schema.videoClip).values({
      clipId: 7,
      resultId: 5001,
      sessionId: 101,
      startOffsetMs: 10_000,
      endOffsetMs: 40_000,
    });

    const empty = await json(await app.request("/api/v1/descriptions/100/results"));
    const emptyClip = empty.data.sessions[0].results[0].clips[0];
    expect(emptyClip.videoUrl).toBeNull();
    // the still still follows the finalize run, so it stays null here
    expect(emptyClip.thumbnailUrl).toBeNull();

    // one stored segment: the clip plays, mid-capture, with a clip-scoped token
    const [ingest] = await testDb
      .insert(schema.recordingIngest)
      .values({
        kind: "clip",
        clipId: 7,
        ticketHash: "a".repeat(64),
        keyDate: "2026-09-20",
        // the legacy numeric directory a backfilled row carries
        keyPrefix: "1/1/101/2026/09/20/clips/7",
        contiguousSequence: 0,
      })
      .returning({ ingestId: schema.recordingIngest.ingestId });
    await testDb.insert(schema.recordingIngestSegment).values({
      ingestId: ingest!.ingestId,
      sequence: 0,
      checksumSha256: "b".repeat(64),
      sizeBytes: 1024,
      durationMs: 2000,
      objectKey: "1/1/101/2026/09/20/clips/7/segments/0000000000.ts",
    });

    const open = await json(await app.request("/api/v1/descriptions/100/results"));
    const openClip = open.data.sessions[0].results[0].clips[0];
    expect(openClip.videoUrl).toMatch(/^\/api\/v2\/hls\/clip\/7\/index[.]m3u8[?]t=v1[.]/);
    // no clip still producer: the card face stays absent
    expect(openClip.thumbnailUrl).toBeNull();

    // the clip half of the token never opens a master route
    const token = new URL(`http://x${openClip.videoUrl}`).searchParams.get("t")!;
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as {
      k: string;
      i: number;
    };
    expect(claims).toMatchObject({ k: "clip", i: 7 });
  });

  it("clip thumbnailUrl is null when a finalized clip has no stem", async () => {
    await seedResultContext();
    await testDb
      .update(schema.session)
      .set({ startEpoch: 1000 })
      .where(eq(schema.session.sessionId, 101));
    // finalized but stem-less: nothing was ever written, so nothing mints
    await testDb.insert(schema.videoClip).values({
      clipId: 8,
      resultId: 5001,
      sessionId: 101,
      startOffsetMs: 0,
      endOffsetMs: 5_000,
    });
    // no segments either, so the clip has no playback URL

    const res = await json(await app.request("/api/v1/results/5001/evidence"));
    expect(res.data.clips[0].videoUrl).toBeNull();
    expect(res.data.clips[0].thumbnailUrl).toBeNull();
  });

  it("evidence clips carry no still until a clip thumbnail producer exists", async () => {
    await seedResultContext();
    await testDb
      .update(schema.session)
      .set({ startEpoch: 1000 })
      .where(eq(schema.session.sessionId, 101));
    await testDb.insert(schema.videoClip).values({
      clipId: 9,
      resultId: 5001,
      sessionId: 101,
      startOffsetMs: 0,
      endOffsetMs: 5_000,
    });

    const res = await json(await app.request("/api/v1/results/5001/evidence"));
    expect(res.data.clips[0].thumbnailUrl).toBeNull();
    expect(res.data.clips[0].endOffsetMs).toBe(5_000);
  });

  it("evidence read mirrors the sidebar media fields", async () => {
    await seedResultContext();
    await createImage({ contentType: "image/png" });

    const res = await app.request("/api/v1/results/5001/evidence");
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data.images[0].url).toContain("travis-media");
    expect(data.clips).toEqual([]);
  });
});
