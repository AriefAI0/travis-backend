import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import * as schema from "../../../src/db/schema";
import { onError } from "../../../src/lib/error";
import { hlsRoutes } from "../../../src/features/playback-stream/hls-routes";
import {
  mintPlaybackToken,
  playbackTokenExpiry,
  PLAYBACK_TOKEN_TTL_SECONDS,
} from "../../../src/lib/playback_token";

const PROJECT_ID = 9600;

// frozen key prefix every ingest fixture carries; playlist reads use object_key
const KEY_PREFIX = "1/9600/9600/2026/09/20/master/9600";

describe("hls routes", () => {
  const app = new Hono();
  app.onError(onError);
  app.route("/", hlsRoutes(testDb));

  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
    await testDb.insert(schema.project).values({ displayNumber: PROJECT_ID, projectId: PROJECT_ID, title: "P" });
    await testDb
      .insert(schema.session)
      .values({ displayNumber: 1, sessionId: PROJECT_ID, projectId: PROJECT_ID, name: "S" });
  });

  // one master with a closed ingest holding `count` contiguous segments
  const seedMaster = async (options: { count: number; closed: boolean; finalSequence?: number }) => {
    const [master] = await testDb
      .insert(schema.masterVideo)
      .values({ sessionId: PROJECT_ID, startEpoch: 1_760_000_000 })
      .returning({ masterVideoId: schema.masterVideo.masterVideoId });
    const [ingest] = await testDb
      .insert(schema.recordingIngest)
      .values({
        kind: "master",
        masterVideoId: master!.masterVideoId,
        ticketHash: "a".repeat(64),
        keyDate: "2026-09-20",
        keyPrefix: KEY_PREFIX,
        closedAt: options.closed ? new Date() : null,
        finalSequence: options.finalSequence ?? (options.closed ? options.count - 1 : null),
        contiguousSequence: options.closed ? -1 : options.count - 1,
      })
      .returning({ ingestId: schema.recordingIngest.ingestId });

    for (let sequence = 0; sequence < options.count; sequence++) {
      await testDb.insert(schema.recordingIngestSegment).values({
        ingestId: ingest!.ingestId,
        sequence,
        checksumSha256: "b".repeat(64),
        sizeBytes: 1024,
        durationMs: 2000,
        objectKey: `1/1/${PROJECT_ID}/2026/09/20/master/${master!.masterVideoId}/segments/000000000${sequence}.ts`,
      });
    }
    return { masterVideoId: master!.masterVideoId, ingestId: ingest!.ingestId };
  };

  const seedClip = async (count: number) => {
    const [master] = await testDb
      .insert(schema.masterVideo)
      .values({ sessionId: PROJECT_ID, startEpoch: 1_760_000_000 })
      .returning({ masterVideoId: schema.masterVideo.masterVideoId });
    const [clip] = await testDb
      .insert(schema.videoClip)
      .values({
        resultId: await seedResult(),
        masterVideoId: master!.masterVideoId,
        startOffsetMs: 0,
        endOffsetMs: 4000,
      })
      .returning({ clipId: schema.videoClip.clipId });
    const [ingest] = await testDb
      .insert(schema.recordingIngest)
      .values({
        kind: "clip",
        clipId: clip!.clipId,
        ticketHash: "c".repeat(64),
        keyDate: "2026-09-20",
        keyPrefix: KEY_PREFIX,
        closedAt: new Date(),
        finalSequence: count - 1,
      })
      .returning({ ingestId: schema.recordingIngest.ingestId });

    for (let sequence = 0; sequence < count; sequence++) {
      await testDb.insert(schema.recordingIngestSegment).values({
        ingestId: ingest!.ingestId,
        sequence,
        checksumSha256: "d".repeat(64),
        sizeBytes: 1024,
        durationMs: 2000,
        objectKey: `1/1/${PROJECT_ID}/2026/09/20/clips/${clip!.clipId}/segments/000000000${sequence}.ts`,
      });
    }
    return clip!.clipId;
  };

  const seedResult = async () => {
    await testDb.insert(schema.asset).values({ assetId: PROJECT_ID, projectId: PROJECT_ID, name: "A" });
    await testDb
      .insert(schema.component)
      .values({ componentId: PROJECT_ID, assetId: PROJECT_ID, projectId: PROJECT_ID, name: "C" });
    await testDb.insert(schema.item).values({
      itemId: PROJECT_ID,
      componentId: PROJECT_ID,
      projectId: PROJECT_ID,
      assetId: PROJECT_ID,
      itemLabel: "I",
    });
    await testDb
      .insert(schema.sessionItem)
      .values({ sessionItemId: PROJECT_ID, sessionId: PROJECT_ID, itemId: PROJECT_ID });
    const [result] = await testDb
      .insert(schema.result)
      .values({
        displayNumber: PROJECT_ID,
        resultId: PROJECT_ID,
        sessionItemId: PROJECT_ID,
        inspectionTypeCode: "GVI",
        projectId: PROJECT_ID,
        assetId: PROJECT_ID,
        componentId: PROJECT_ID,
        itemId: PROJECT_ID,
        sessionId: PROJECT_ID,
      })
      .returning({ resultId: schema.result.resultId });
    return result!.resultId;
  };

  test("a closed master playlist is a VOD range whose children carry the token", async () => {
    const { masterVideoId } = await seedMaster({ count: 3, closed: true });
    const token = mintPlaybackToken({ kind: "master", id: masterVideoId });

    const res = await app.request(`/api/v2/hls/master/${masterVideoId}/index.m3u8?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("mpegurl");

    const body = await res.text();
    expect(body).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(body).toContain("#EXT-X-ENDLIST");
    expect(body).toContain("#EXT-X-TARGETDURATION:2");

    const children = body.split("\n").filter((line) => line.startsWith("./"));
    expect(children).toEqual([
      `./0000000000.ts?t=${encodeURIComponent(token)}`,
      `./0000000001.ts?t=${encodeURIComponent(token)}`,
      `./0000000002.ts?t=${encodeURIComponent(token)}`,
    ]);
  });

  test("an open master playlist is live and unbounded by the frozen range", async () => {
    const { masterVideoId } = await seedMaster({ count: 2, closed: false });
    const token = mintPlaybackToken({ kind: "master", id: masterVideoId });

    const body = await (
      await app.request(`/api/v2/hls/master/${masterVideoId}/index.m3u8?t=${token}`)
    ).text();

    expect(body).not.toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(body).not.toContain("#EXT-X-ENDLIST");
    expect(body).toContain("./0000000001.ts");
  });

  test("a clip playlist serves under the clip scope", async () => {
    const clipId = await seedClip(2);
    const token = mintPlaybackToken({ kind: "clip", id: clipId });

    const res = await app.request(`/api/v2/hls/clip/${clipId}/index.m3u8?t=${token}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("./0000000000.ts");
    expect(body).toContain("#EXT-X-ENDLIST");
  });

  test("missing, expired, and cross-recording tokens fail", async () => {
    const first = await seedMaster({ count: 1, closed: true });
    await testDb.update(schema.masterVideo).set({ sessionId: PROJECT_ID });
    const second = await seedMaster({ count: 1, closed: true });

    const noToken = await app.request(`/api/v2/hls/master/${first.masterVideoId}/index.m3u8`);
    expect(noToken.status).toBe(401);

    const expired = mintPlaybackToken(
      { kind: "master", id: first.masterVideoId },
      Math.floor(Date.now() / 1000) - 1,
    );
    expect(
      (await app.request(`/api/v2/hls/master/${first.masterVideoId}/index.m3u8?t=${expired}`))
        .status,
    ).toBe(401);

    const foreign = mintPlaybackToken({ kind: "master", id: second.masterVideoId });
    expect(
      (await app.request(`/api/v2/hls/master/${first.masterVideoId}/index.m3u8?t=${foreign}`))
        .status,
    ).toBe(401);

    // a clip token never opens a master route
    const clipToken = mintPlaybackToken({ kind: "clip", id: first.masterVideoId });
    expect(
      (await app.request(`/api/v2/hls/master/${first.masterVideoId}/index.m3u8?t=${clipToken}`))
        .status,
    ).toBe(401);
  });

  test("a segment request redirects to that segment's object", async () => {
    const { masterVideoId } = await seedMaster({ count: 3, closed: true });
    const token = mintPlaybackToken({ kind: "master", id: masterVideoId });

    const res = await app.request(`/api/v2/hls/master/${masterVideoId}/0000000001.ts?t=${token}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("travis-media");
    expect(location).toContain(`master/${masterVideoId}/segments/0000000001.ts`);
    expect(location).not.toContain(token);
  });

  test("a segment outside the visible range is 404", async () => {
    const { masterVideoId } = await seedMaster({ count: 3, closed: true, finalSequence: 1 });
    const token = mintPlaybackToken({ kind: "master", id: masterVideoId });

    // stored, but past the frozen range
    expect(
      (await app.request(`/api/v2/hls/master/${masterVideoId}/0000000002.ts?t=${token}`)).status,
    ).toBe(404);
    // never stored
    expect(
      (await app.request(`/api/v2/hls/master/${masterVideoId}/0000000009.ts?t=${token}`)).status,
    ).toBe(404);
    // still inside the range
    expect(
      (await app.request(`/api/v2/hls/master/${masterVideoId}/0000000001.ts?t=${token}`)).status,
    ).toBe(302);
  });

  test("a segment request without a valid token is refused", async () => {
    const { masterVideoId } = await seedMaster({ count: 1, closed: true });
    const foreign = await seedMaster({ count: 1, closed: true });
    const token = mintPlaybackToken({ kind: "master", id: foreign.masterVideoId });

    expect(
      (await app.request(`/api/v2/hls/master/${masterVideoId}/0000000000.ts`)).status,
    ).toBe(401);
    expect(
      (await app.request(`/api/v2/hls/master/${masterVideoId}/0000000000.ts?t=${token}`)).status,
    ).toBe(401);
  });

  test("a playlist for a recording with no ingest is 404", async () => {
    const [master] = await testDb
      .insert(schema.masterVideo)
      .values({ sessionId: PROJECT_ID, startEpoch: 1_760_000_000 })
      .returning({ masterVideoId: schema.masterVideo.masterVideoId });
    const token = mintPlaybackToken({ kind: "master", id: master!.masterVideoId });

    expect(
      (await app.request(`/api/v2/hls/master/${master!.masterVideoId}/index.m3u8?t=${token}`))
        .status,
    ).toBe(404);
  });

  test("the token lifetime covers a playback session and stays bounded", () => {
    const token = mintPlaybackToken({ kind: "master", id: 1 });
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as {
      e: number;
    };
    const nowSeconds = Math.floor(Date.now() / 1000);

    expect(claims.e - nowSeconds).toBeGreaterThan(60 * 60);
    expect(claims.e - nowSeconds).toBeLessThanOrEqual(PLAYBACK_TOKEN_TTL_SECONDS);
    // expiry is epoch seconds, never milliseconds
    expect(playbackTokenExpiry()).toBeGreaterThan(nowSeconds);
  });

  test('a playlist request with a non-integer id is a handler 400, not a router miss', async () => {
    const notHls = await app.request("/api/v2/hls/master/abc/index.m3u8");
    expect(notHls.status).toBe(400); // id must be an integer, not a router miss
  });
});
