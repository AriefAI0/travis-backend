import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";

import { appFor } from "../../helpers/app";
import { createTestUser } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { resultRoutes } from "../../../src/features/results/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, resultRoutes);

// minted per test in beforeEach; every request below carries one of these
let adminToken = "";
let operatorToken = "";

// project > session > asset > component > item > sessionItem > result (GVI)
const seedResultContext = async () => {
  await testDb.insert(schema.project).values({ organizationId: testOrgId, displayNumber: 1, projectId: 1, title: "Alpha" });
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
  authRequest("/api/v1/results/5001/images", {
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
  // Every route is guarded now. An Operator preset is the one that carries
  // `create Result`, because an admin does not run an inspection. `remove
  // Result` comes from the Admin preset, so the delete test uses that token.
  beforeEach(async () => {
    await truncateTestDatabase();
    const operator = await createTestUser({ preset: "Operator" });
    operatorToken = operator.token;
    const admin = await createTestUser({ preset: "Admin" });
    adminToken = admin.token;
  });

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

    const res = await authRequest("/api/v1/results/9999/images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentType: "image/png" }),
    });
    expect(res.status).toBe(404);
  });

  it("annotated re-addresses the same imageId and flips the flag", async () => {
    await seedResultContext();
    const { data } = await json<{ data: Ticket }>(await createImage({ contentType: "image/png" }));

    const res = await authRequest(`/api/v1/images/${data.imageId}/annotated`, {
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

    const res = await authRequest("/api/v1/images/9999/annotated", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("admin upload stays pending, hidden, and needs a real object to finalize", async () => {
    await seedResultContext();
    await testDb
      .update(schema.result)
      .set({ masterEndMs: 4000 })
      .where(eq(schema.result.resultId, 5001));

    const res = await asAdminRequest("/api/v1/results/5001/images/admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentType: "image/png" }),
    });
    expect(res.status).toBe(201);
    const ticket = (await json<{ data: Ticket & { maxBytes: number } }>(res)).data;
    expect(ticket.maxBytes).toBe(20 * 1024 * 1024);
    expect(ticket.variant).toBe("raw");

    const row = (await testDb.select().from(schema.resultImage))[0]!;
    expect(row.status).toBe("pending");

    const sidebar = await json(await authRequest("/api/v1/descriptions/100/results"));
    expect(sidebar.data.sessions[0].results[0].images).toHaveLength(0);

    const download = await authRequest(`/api/v1/images/${ticket.imageId}/download-url`);
    expect(download.status).toBe(409);

    const finalize = await asAdminRequest(`/api/v1/images/${ticket.imageId}/finalize`, {
      method: "POST",
    });
    expect(finalize.status).toBe(409);
    expect((await json(finalize)).code).toBe("image_not_uploaded");
    expect((await testDb.select().from(schema.resultImage))[0]!.status).toBe("pending");
  });

  it("admin upload refuses an open result and a non-admin caller", async () => {
    await seedResultContext();

    const open = await asAdminRequest("/api/v1/results/5001/images/admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentType: "image/png" }),
    });
    expect(open.status).toBe(409);

    await testDb
      .update(schema.result)
      .set({ masterEndMs: 4000 })
      .where(eq(schema.result.resultId, 5001));
    const operator = await authRequest("/api/v1/results/5001/images/admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentType: "image/png" }),
    });
    expect(operator.status).toBe(403);
  });

  it("download-url names the stored image leaf", async () => {
    await seedResultContext();
    const { data } = await json<{ data: Ticket }>(await createImage({ contentType: "image/jpeg" }));

    const res = await authRequest(`/api/v1/images/${data.imageId}/download-url`);
    expect(res.status).toBe(200);
    const body = (await json(res)).data as Record<string, string>;
    expect(body.filename).toBe(`${data.imageId}.jpg`);
    expect(body.contentType).toBe("image/jpeg");
    expect(body.url).toContain(`/${data.imageId}.jpg`);
  });

  it("delete removes the row and 404s on repeat", async () => {
    await seedResultContext();
    const { data } = await json<{ data: Ticket }>(await createImage({ contentType: "image/png" }));

    const noConfirm = await asAdminRequest(`/api/v1/images/${data.imageId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noConfirm.status).toBe(400);

    const gone = await asAdminRequest(`/api/v1/images/${data.imageId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmPermanentRemove: true }),
    });
    expect(gone.status).toBe(200);
    expect(await testDb.select().from(schema.resultImage)).toHaveLength(0);

    const again = await asAdminRequest(`/api/v1/images/${data.imageId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmPermanentRemove: true }),
    });
    expect(again.status).toBe(404);
  });

  it("sidebar images carry minted URLs and the poster is the first snip", async () => {
    await seedResultContext();
    const first = await json<{ data: Ticket }>(await createImage({ contentType: "image/png" }));
    const second = await json<{ data: Ticket }>(await createImage({ contentType: "image/jpeg" }));

    const res = await authRequest("/api/v1/descriptions/100/results");
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
    await authRequest(`/api/v1/images/${first.data.imageId}/annotated`, { method: "POST" });
    const after = await json(await authRequest("/api/v1/descriptions/100/results"));
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

    const { data } = await json(await authRequest("/api/v1/descriptions/100/results"));
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

    const empty = await json(await authRequest("/api/v1/descriptions/100/results"));
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

    const open = await json(await authRequest("/api/v1/descriptions/100/results"));
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

    const res = await json(await authRequest("/api/v1/results/5001/evidence"));
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

    const res = await json(await authRequest("/api/v1/results/5001/evidence"));
    expect(res.data.clips[0].thumbnailUrl).toBeNull();
    expect(res.data.clips[0].endOffsetMs).toBe(5_000);
  });

  it("evidence read mirrors the sidebar media fields", async () => {
    await seedResultContext();
    await createImage({ contentType: "image/png" });

    const res = await authRequest("/api/v1/results/5001/evidence");
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data.images[0].url).toContain("travis-media");
    expect(data.clips).toEqual([]);
  });

  // An RA mark has no session and no clip, so its evidence hangs off the project
  // folder alone. The date is the mark's own row, which is why it is read back.
  it("an RA mark takes evidence under the project folder, with no session", async () => {
    await seedResultContext();
    await testDb.insert(schema.result).values({
      displayNumber: 0,
      resultId: 6001,
      inspectionTypeCode: "RA",
      isRa: true,
      descriptionId: 100,
      projectId: 1,
      sessionId: null,
    });

    const res = await authRequest("/api/v1/results/6001/images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentType: "image/png" }),
    });
    expect(res.status).toBe(201);

    const { data } = await json<{ data: Ticket }>(res);
    const mark = await testDb.query.result.findFirst({
      where: eq(schema.result.resultId, 6001),
    });
    const day = mark!.createdAt.toISOString().slice(0, 10);
    expect(data.storageStem).toBe(`1-alpha-${day}/ra/jl-01/evidence-img`);
    expect(data.url).toContain(`${data.storageStem}/${data.imageId}.png`);
  });

  /* ---------- permanent discard: lifecycle gate ---------- */

  // One row, no upload: the discard route is the only thing under test here.
  const seedImageRow = async (imageId: number, resultId: number) => {
    await testDb.insert(schema.resultImage).values({
      imageId,
      resultId,
      storageStem: `1-alpha-2026-10-24/session-1-2026-10-24-0016/results/${resultId}-jl-01/evidence-img`,
      contentType: "image/png",
    });
  };

  const discard = (imageId: number, token: string, confirmed = true) =>
    app.request(`/api/v1/images/${imageId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(confirmed ? { confirmPermanentRemove: true } : {}),
    });

  const imageRowCount = async () => (await testDb.select().from(schema.resultImage)).length;

  // A live result (4-2): an operator owns its capture until the form submits.
  const completeResult = async (resultId: number) => {
    await testDb
      .update(schema.result)
      .set({ masterEndMs: 4000 })
      .where(eq(schema.result.resultId, resultId));
  };

  // An RA mark: project-scoped, no session, no layer, no recording anchors.
  const seedRaResult = async (resultId: number) => {
    await testDb.insert(schema.result).values({
      displayNumber: 0,
      resultId,
      inspectionTypeCode: "RA",
      isRa: true,
      descriptionId: 100,
      projectId: 1,
      sessionId: null,
    });
  };

  // A second organization: every read there must be invisible, not forbidden.
  const seedOtherOrgResult = async (resultId: number) => {
    // 99, because the seeded default org occupies a low id and organization
    // is the one table the truncate order keeps
    await testDb
      .insert(schema.organization)
      .values({ organizationId: 99, name: "Beta-99" })
      .onConflictDoNothing();
    await testDb.insert(schema.project).values({
      organizationId: 99,
      displayNumber: 1,
      projectId: 2,
      title: "Beta",
    });
    await testDb.insert(schema.result).values({
      displayNumber: 1,
      resultId,
      inspectionTypeCode: "GVI",
      descriptionId: 100,
      projectId: 2,
      sessionId: null,
      layer: 1,
    });
  };

  it("an operator with create Result discards an image from an open inspection", async () => {
    await seedResultContext();
    await seedImageRow(9101, 5001);

    const res = await discard(9101, operatorToken);

    expect(res.status).toBe(200);
    expect(await imageRowCount()).toBe(0);
  });

  it("an operator with modify Result discards an image from an RA mark", async () => {
    await seedResultContext();
    await seedRaResult(6001);
    await seedImageRow(9102, 6001);

    const res = await discard(9102, operatorToken);

    expect(res.status).toBe(200);
    expect(await imageRowCount()).toBe(0);
  });

  it("an operator cannot discard an image from a completed result", async () => {
    await seedResultContext();
    await completeResult(5001);
    await seedImageRow(9103, 5001);

    const res = await discard(9103, operatorToken);

    expect(res.status).toBe(403);
    expect(await imageRowCount()).toBe(1);
  });

  it("an operator cannot discard an image from an archived result", async () => {
    await seedResultContext();
    await testDb
      .update(schema.result)
      .set({ archivedAt: new Date() })
      .where(eq(schema.result.resultId, 5001));
    await seedImageRow(9104, 5001);

    const res = await discard(9104, operatorToken);

    expect(res.status).toBe(403);
    expect(await imageRowCount()).toBe(1);
  });

  it("an operator cannot discard an image from a legacy sessionless row", async () => {
    await seedResultContext();
    await testDb.insert(schema.result).values({
      displayNumber: 0,
      resultId: 6002,
      inspectionTypeCode: "GVI",
      descriptionId: 100,
      projectId: 1,
      sessionId: null,
    });
    await seedImageRow(9105, 6002);

    const res = await discard(9105, operatorToken);

    expect(res.status).toBe(403);
    expect(await imageRowCount()).toBe(1);
  });

  it("an administrator still discards a completed-result image", async () => {
    await seedResultContext();
    await completeResult(5001);
    await seedImageRow(9106, 5001);

    const res = await discard(9106, adminToken);

    expect(res.status).toBe(200);
    expect(await imageRowCount()).toBe(0);
  });

  it("an image in another organization is not found before any 403", async () => {
    await seedResultContext();
    await seedOtherOrgResult(7001);
    await seedImageRow(9107, 7001);

    const asOperator = await discard(9107, operatorToken);
    const asAdmin = await discard(9107, adminToken);

    expect(asOperator.status).toBe(404);
    expect(asAdmin.status).toBe(404);
    expect(await imageRowCount()).toBe(1);
  });

  it("a discard without explicit confirmation keeps the row", async () => {
    await seedResultContext();
    await seedImageRow(9108, 5001);

    const res = await discard(9108, operatorToken, false);

    expect(res.status).toBe(400);
    expect(await imageRowCount()).toBe(1);
  });

  // The RA branch must not open the door for every sessionless row.
  it("a sessionless non-RA result still refuses an evidence image", async () => {
    await seedResultContext();
    await testDb.insert(schema.result).values({
      displayNumber: 0,
      resultId: 6002,
      inspectionTypeCode: "GVI",
      descriptionId: 100,
      projectId: 1,
      sessionId: null,
    });

    const res = await authRequest("/api/v1/results/6002/images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentType: "image/png" }),
    });
    expect(res.status).toBe(409);
  });
});

// Most calls are evidence writes, which need `create Result` — the Operator
// preset. A call that needs `remove Result` passes the Admin token instead.
const authRequest = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...((init.headers ?? {}) as Record<string, string>),
      authorization: `Bearer ${operatorToken}`,
    },
  });

const asAdminRequest = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...((init.headers ?? {}) as Record<string, string>),
      authorization: `Bearer ${adminToken}`,
    },
  });
