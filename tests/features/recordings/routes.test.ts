import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
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
};

const baseContext = {
  project: 1,
  session: 101,
  asset: 1,
  component: 10,
  item: 100,
  sessionItem: 1000,
};

// flow: register > unfinished > playback blocked > fail > finalize > playback
describe("recordings routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("master lifecycle: create, fail, finalize, playback", async () => {
    await seedContext(baseContext);

    const post = await req("/api/v1/recordings", "POST", {
      sessionId: 101,
      fileUrl: "projects/1/sessions/101/master.ts",
      startEpoch: 1755684000,
      recordingStatus: "recording",
      startedAt: "2026-08-20T10:00:00.000Z",
    });
    expect(post.status).toBe(201);
    const { data } = await json(post);
    expect(data.recordingStatus).toBe("recording");
    const masterVideoId = data.masterVideoId as number;

    // open master shows in the recovery sweep
    const unfinished = await app.request("/api/v1/recordings/unfinished");
    expect((await json(unfinished)).data).toHaveLength(1);

    // playback before finalize is wrong_state, not 404
    const blocked = await app.request(
      `/api/v1/recordings/${masterVideoId}/playback?projectId=1`,
    );
    expect(blocked.status).toBe(409);
    expect(await json<unknown>(blocked)).toEqual({
      status: 409,
      code: "wrong_state",
      title: "Only finalized master videos can be opened for playback",
    });

    // engine-side encode failure still keeps it in the sweep
    const failed = await req(`/api/v1/recordings/${masterVideoId}/fail`, "POST", {
      error: "ffmpeg exited 1",
    });
    expect(failed.status).toBe(200);
    expect((await json(failed)).data.recordingStatus).toBe("finalization_failed");

    const finalized = await req(`/api/v1/recordings/${masterVideoId}/finalize`, "POST", {
      stoppedAt: "2026-08-20T10:05:00.000Z",
      durationMs: 300000,
      fileSize: null,
      endEpoch: 1755684300,
    });
    expect(finalized.status).toBe(200);
    expect((await json(finalized)).data.recordingStatus).toBe("finalized");

    const playback = await app.request(
      `/api/v1/recordings/${masterVideoId}/playback?projectId=1`,
    );
    expect(playback.status).toBe(200);
    expect((await json(playback)).data.fileUrl).toBe("projects/1/sessions/101/master.ts");

    const sweep = await app.request("/api/v1/recordings/unfinished");
    expect((await json(sweep)).data).toHaveLength(0);
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
      const res = await req("/api/v1/recordings", "POST", {
        sessionId,
        fileUrl: `projects/x/sessions/${sessionId}/master.ts`,
        startEpoch: 1755684000,
        recordingStatus: "recording",
      });
      expect(res.status).toBe(201);
    }

    const all = await app.request("/api/v1/recordings/unfinished");
    expect((await json(all)).data).toHaveLength(2);

    const scoped = await app.request("/api/v1/recordings/unfinished?projectId=2");
    const rows = (await json(scoped)).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe(202);
  });

  it("missing master is 404 for get, finalize, fail, interrupt", async () => {
    const finalize = await req("/api/v1/recordings/99999/finalize", "POST", {
      stoppedAt: "2026-08-20T10:05:00.000Z",
      durationMs: 1,
      fileSize: null,
      endEpoch: 1755684300,
    });
    expect(finalize.status).toBe(404);
    expect((await json(finalize)).code).toBe("not_found");

    const get = await app.request("/api/v1/recordings/99999");
    expect(get.status).toBe(404);
    const fail = await req("/api/v1/recordings/99999/fail", "POST", { error: "x" });
    expect(fail.status).toBe(404);
    const interrupt = await req("/api/v1/recordings/99999/interrupt", "POST", {
      recoveryStatus: "recoverable",
      fileSize: null,
    });
    expect(interrupt.status).toBe(404);
  });

  it("clip lifecycle: start, duplicate 409, active, stop, batch read", async () => {
    await seedContext(baseContext);

    // clip range validation needs an existing master video
    const master = await req("/api/v1/recordings", "POST", {
      sessionId: 101,
      fileUrl: "projects/1/sessions/101/master.ts",
      startEpoch: 1755684000,
      recordingStatus: "finalized",
    });
    const masterVideoId = (await json(master)).data.masterVideoId as number;

    const start = await req("/api/v1/clips", "POST", {
      sessionItemId: 1000,
      inspectionTypeCode: "GVI",
      projectId: 1,
      assetId: 1,
      componentId: 10,
      itemId: 100,
      sessionId: 101,
      masterVideoId,
      startOffsetMs: 0,
    });
    expect(start.status).toBe(201);
    const { data } = await json(start);
    expect(data.clip.endOffsetMs).toBeNull();
    const resultId = data.result.resultId as number;
    const clipId = data.clip.clipId as number;

    // same session item + code while open is wrong_state
    const duplicate = await req("/api/v1/clips", "POST", {
      sessionItemId: 1000,
      inspectionTypeCode: "GVI",
      projectId: 1,
      assetId: 1,
      componentId: 10,
      itemId: 100,
      sessionId: 101,
      masterVideoId,
      startOffsetMs: 10,
    });
    expect(duplicate.status).toBe(409);
    expect((await json(duplicate)).code).toBe("wrong_state");

    // active sweeps see it, project- and session-scoped
    const activeProject = await app.request("/api/v1/clips/active?projectId=1");
    expect((await json(activeProject)).data).toHaveLength(1);
    const activeSession = await app.request("/api/v1/clips/active?sessionId=101");
    expect((await json(activeSession)).data).toHaveLength(1);
    const activeOther = await app.request("/api/v1/clips/active?projectId=2");
    expect((await json(activeOther)).data).toHaveLength(0);

    // stop requires a clip file path; the engine sets it mid-recording
    // (markVideoClipRecordingStarted wiring lands with phase-3 ingest work)
    await testDb
      .update(schema.videoClip)
      .set({ clipFileUrl: "travis-media/evidence/clips/1.mp4" })
      .where(eq(schema.videoClip.clipId, clipId));

    // stop completes clip + result in one tx
    const stop = await req(`/api/v1/clips/${clipId}/stop`, "POST", { endOffsetMs: 5000 });
    expect(stop.status).toBe(200);
    const stopped = (await json(stop)).data;
    expect(stopped.clip.endOffsetMs).toBe(5000);

    // stopped clip leaves the active sweep
    const activeAfter = await app.request("/api/v1/clips/active?projectId=1");
    expect((await json(activeAfter)).data).toHaveLength(0);

    // batch read keyed by resultId (stringified in JSON)
    const batch = await req("/api/v1/clips/by-result-ids", "POST", { resultIds: [resultId] });
    expect(batch.status).toBe(200);
    const byResult = (await json(batch)).data;
    expect(byResult[String(resultId)]).toHaveLength(1);
  });

  it("from-recording starts a clip; cancel removes clip + result", async () => {
    await seedContext(baseContext);

    const master = await req("/api/v1/recordings", "POST", {
      sessionId: 101,
      fileUrl: "projects/1/sessions/101/master.ts",
      startEpoch: 1755684000,
      recordingStatus: "finalized",
    });
    const masterVideoId = (await json(master)).data.masterVideoId as number;

    const start = await req("/api/v1/clips/from-recording", "POST", {
      sessionId: 101,
      itemId: 100,
      inspectionTypeCode: "CP",
      masterVideoId,
      startOffsetMs: 250,
    });
    expect(start.status).toBe(201);
    const clipId = (await json(start)).data.clip.clipId as number;

    const cancel = await req(`/api/v1/clips/${clipId}/cancel`, "POST");
    expect(cancel.status).toBe(200);
    const cancelled = (await json(cancel)).data;
    expect(cancelled.clip.clipId).toBe(clipId);

    // already deleted -> not_found, not a second cancel
    const again = await req(`/api/v1/clips/${clipId}/cancel`, "POST");
    expect(again.status).toBe(404);
    expect((await json(again)).code).toBe("not_found");

    // stop on a missing clip is also not_found
    const stop = await req("/api/v1/clips/99999/stop", "POST", { endOffsetMs: 1 });
    expect(stop.status).toBe(404);
  });
});
