import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import * as schema from "../../../src/db/schema";
import { env } from "../../../src/config/env";
import { buildMinioClient, minio } from "../../../src/lib/minio_storage/clients";
import { recordingV2Routes } from "../../../src/features/recordings-v2/routes";
import { onError } from "../../../src/lib/error";

// domain parents for admission: project > session > ... > result > masterVideo
const seedDomainChain = async () => {
  await testDb.insert(schema.project).values({ projectId: 9001, title: "P" });
  await testDb
    .insert(schema.session)
    .values({ sessionId: 9001, projectId: 9001, name: "S" });
  await testDb.insert(schema.asset).values({ assetId: 9001, projectId: 9001, name: "A" });
  await testDb
    .insert(schema.component)
    .values({ componentId: 9001, assetId: 9001, projectId: 9001, name: "C" });
  await testDb.insert(schema.item).values({
    itemId: 9001,
    componentId: 9001,
    projectId: 9001,
    assetId: 9001,
    itemLabel: "I",
  });
  await testDb
    .insert(schema.sessionItem)
    .values({ sessionItemId: 9001, sessionId: 9001, itemId: 9001 });
  await testDb.insert(schema.result).values({
    resultId: 9001,
    sessionItemId: 9001,
    inspectionTypeCode: "GVI",
    projectId: 9001,
    assetId: 9001,
    componentId: 9001,
    itemId: 9001,
    sessionId: 9001,
  });
  await testDb.insert(schema.masterVideo).values({
    masterVideoId: 9001,
    sessionId: 9001,
    startEpoch: 1000,
  });
};

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

const encode = (text: string) => new TextEncoder().encode(text);

type PostResult = { status: number; body: Record<string, unknown> };

const post = async (app: Hono, path: string, body?: unknown): Promise<PostResult> => {
  const res = await app.request(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // success responses wrap in {ok,data}; error bodies (problem+json) do not
  const json = (await res.json()) as { ok?: boolean; data?: Record<string, unknown> };
  return { status: res.status, body: (json.ok ? json.data : json) as Record<string, unknown> };
};

const get = async (app: Hono, path: string): Promise<PostResult> => {
  const res = await app.request(path);
  // success responses wrap in {ok,data}; error bodies (problem+json) do not
  const json = (await res.json()) as { ok?: boolean; data?: Record<string, unknown> };
  return { status: res.status, body: (json.ok ? json.data : json) as Record<string, unknown> };
};

describe("recording v2 routes", () => {
  // every instance needs the production error mapper for AppError statuses
  const mount = (storage = minio) => {
    const h = new Hono();
    h.onError(onError);
    h.route("/", recordingV2Routes(testDb, storage));
    return h;
  };

  beforeAll(async () => {
    await ensureTestDatabase();
    env.RECORDING_V2_ENABLED = true;
  });

  afterAll(async () => {
    env.RECORDING_V2_ENABLED = false;
    // sweep the objects these tests PUT into the raw bucket
    const objects: string[] = [];
    for await (const item of minio.listObjectsV2(env.BUCKET_RAW, "recordings/")) {
      if (item.name) objects.push(item.name);
    }
    if (objects.length > 0) await minio.removeObjects(env.BUCKET_RAW, objects);
    closeTestDatabase();
  });

  beforeEach(async () => {
    await truncateTestDatabase();
    await seedDomainChain();
  });

  const masterBody = (recordingId = randomUUID()) => ({
    recordingId,
    kind: "master",
    sessionId: 9001,
    startEpoch: 1000,
  });

  // drive ticket > PUT > complete for one segment against real MinIO
  const sealSegment = async (app: Hono, recordingId: string, index: number, bytes?: Uint8Array) => {
    const payload = bytes ?? encode(`segment-${index}-payload`);
    const checksum = sha256Hex(payload);
    const ticket = await post(app, `/api/v2/recordings/${recordingId}/segments/${index}/ticket`, {
      checksum,
      sizeBytes: payload.length,
    });
    expect(ticket.status).toBe(200);
    expect(ticket.body.action).toBe("upload");
    const put = await fetch(ticket.body.url as string, {
      method: "PUT",
      body: payload,
      headers: ticket.body.headers as Record<string, string>,
    });
    expect(put.status).toBe(200);
    const completion = await post(app, `/api/v2/recordings/${recordingId}/segments/${index}/complete`);
    return { ticket, completion };
  };

  it("is disabled behind the feature gate", async () => {
    env.RECORDING_V2_ENABLED = false;
    const gated = mount();
    const res = await post(gated, "/api/v2/recordings", masterBody());
    env.RECORDING_V2_ENABLED = true;
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "feature_disabled" });
  });

  it("requires the deployment token when one is configured", async () => {
    env.RECORDING_V2_TOKEN = "sekrit";
    const gated = mount();
    try {
      const denied = await post(gated, "/api/v2/recordings", masterBody());
      expect(denied.status).toBe(401);
      expect(denied.body).toMatchObject({ code: "deployment_unauthorized" });

      const withHeader = await gated.request("/api/v2/recordings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-travis-deployment-token": "sekrit" },
        body: JSON.stringify(masterBody()),
      });
      expect(withHeader.status).toBe(201);
    } finally {
      env.RECORDING_V2_TOKEN = undefined;
    }
  });

  it("admits once, replays the lost response, and conflicts on changed identity", async () => {
    const app = mount();
    const recordingId = randomUUID();

    const first = await post(app, "/api/v2/recordings", masterBody(recordingId));
    expect(first.status).toBe(201);
    expect(first.body.admitted).toBe(true);
    expect(first.body.protocolVersion).toBe(2);
    const domain = first.body.domain as { masterVideoId: number };
    expect(domain.masterVideoId).toBeGreaterThan(0);
    const backendInstanceId = first.body.backendInstanceId as string;
    expect(backendInstanceId).toMatch(/^[0-9a-f-]{36}$/);

    // lost-response retry: same body replays the same identity
    const replay = await post(app, "/api/v2/recordings", masterBody(recordingId));
    expect(replay.status).toBe(200);
    expect(replay.body.admitted).toBe(false);
    expect(replay.body.domain).toEqual(first.body.domain);

    // changed admission body on the same UUID is a hard conflict
    const changed = await post(app, "/api/v2/recordings", {
      ...masterBody(recordingId),
      startEpoch: 2000,
    });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: "identity_conflict" });
  });

  it("mints an auto session when a master admits without a sessionId", async () => {
    const app = mount();
    const res = await post(app, "/api/v2/recordings", {
      recordingId: randomUUID(),
      kind: "master",
      projectId: 9001,
      startEpoch: 1000,
    });
    expect(res.status).toBe(201);
    const domain = res.body.domain as { sessionId: number; masterVideoId: number };
    expect(domain.sessionId).toBeGreaterThan(0);
    expect(domain.masterVideoId).toBeGreaterThan(0);
  });

  it("stores a segment after an enforced PUT and replays the receipt", async () => {
    const app = mount();
    const recordingId = randomUUID();
    await post(app, "/api/v2/recordings", masterBody(recordingId));

    const bytes = encode("sealed-segment-0");
    const { ticket, completion } = await sealSegment(app, recordingId, 0, bytes);
    expect(ticket.body.headers).toMatchObject({
      "x-amz-checksum-sha256": Buffer.from(sha256Hex(bytes), "hex").toString("base64"),
    });
    expect(completion.status).toBe(200);
    expect(completion.body.action).toBe("stored");
    expect(completion.body.revisionBumped).toBe(true);
    const receipt = completion.body.receipt as { index: number; storedAt: string };
    expect(receipt.index).toBe(0);

    // repeated completion returns the same receipt without a revision bump
    const replay = await post(app, `/api/v2/recordings/${recordingId}/segments/0/complete`);
    expect(replay.body.revisionBumped).toBe(false);
    expect((replay.body.receipt as { storedAt: string }).storedAt).toBe(receipt.storedAt);

    // a ticket request for a stored segment short-circuits to the receipt
    const stored = await post(
      app,
      `/api/v2/recordings/${recordingId}/segments/0/ticket`,
      { checksum: sha256Hex(bytes), sizeBytes: bytes.length }
    );
    expect(stored.body.action).toBe("stored");
  });

  it("rejects mismatched bytes at PUT and acknowledges nothing", async () => {
    const app = mount();
    const recordingId = randomUUID();
    await post(app, "/api/v2/recordings", masterBody(recordingId));

    const bytes = encode("actual-bytes!");
    const tampered = encode("tampered-bytes");
    const ticket = await post(
      app,
      `/api/v2/recordings/${recordingId}/segments/3/ticket`,
      { checksum: sha256Hex(bytes), sizeBytes: bytes.length }
    );
    // same length, different bytes, ticket-bound checksum header -> MinIO refuses
    const put = await fetch(ticket.body.url as string, {
      method: "PUT",
      body: tampered,
      headers: ticket.body.headers as Record<string, string>,
    });
    expect(put.status).toBeGreaterThanOrEqual(400);

    const completion = await post(app, `/api/v2/recordings/${recordingId}/segments/3/complete`);
    expect(completion.status).toBe(409);
    expect(completion.body).toMatchObject({ code: "segment_not_stored" });

    const status = await get(app, `/api/v2/recordings/${recordingId}`);
    expect(status.body.segmentRevision).toBe(0);
  });

  it("catches same-size different-bytes objects at completion", async () => {
    const app = mount();
    const recordingId = randomUUID();
    await post(app, "/api/v2/recordings", masterBody(recordingId));

    const bytes = encode("legit-payload0");
    const forged = encode("forge-payload0");
    expect(forged.length).toBe(bytes.length);
    const ticket = await post(
      app,
      `/api/v2/recordings/${recordingId}/segments/0/ticket`,
      { checksum: sha256Hex(bytes), sizeBytes: bytes.length }
    );
    const objectKey = ticket.body.objectKey as string;
    // bypass enforcement with a plain presigned PUT: right size, wrong bytes
    const plainUrl = await minio.presignedUrl("PUT", env.BUCKET_RAW, objectKey, 300);
    expect((await fetch(plainUrl, { method: "PUT", body: forged })).status).toBe(200);

    const completion = await post(app, `/api/v2/recordings/${recordingId}/segments/0/complete`);
    expect(completion.status).toBe(409);
    expect(completion.body).toMatchObject({ code: "segment_conflict" });
  });

  it("reconciles descriptors into stored, upload, and conflict actions", async () => {
    const app = mount();
    const recordingId = randomUUID();
    const admitted = await post(app, "/api/v2/recordings", masterBody(recordingId));
    const backendInstanceId = admitted.body.backendInstanceId as string;

    const bytes0 = encode("seg-0");
    await sealSegment(app, recordingId, 0, bytes0);
    // segment 1: reserved only (ticket, no upload)
    const bytes1 = encode("seg-1");
    await post(app, `/api/v2/recordings/${recordingId}/segments/1/ticket`, {
      checksum: sha256Hex(bytes1),
      sizeBytes: bytes1.length,
    });

    const reconcile = await post(app, `/api/v2/recordings/${recordingId}/reconcile`, {
      backendInstanceId,
      descriptors: [
        { index: 0, checksum: sha256Hex(bytes0), sizeBytes: bytes0.length },
        { index: 1, checksum: sha256Hex(bytes1), sizeBytes: bytes1.length },
        { index: 2, checksum: sha256Hex(bytes1), sizeBytes: bytes1.length },
        { index: 1, checksum: sha256Hex(encode("other")), sizeBytes: 5 },
      ],
    });
    expect(reconcile.status).toBe(200);
    expect(reconcile.body.recording).toBe("resume");
    const segments = reconcile.body.segments as Array<{ index: number; action: string }>;
    expect(segments[0]).toMatchObject({ index: 0, action: "stored" });
    expect(segments[1]).toMatchObject({ index: 1, action: "upload" });
    expect(segments[2]).toMatchObject({ index: 2, action: "upload" });
    expect(segments[3]).toMatchObject({ index: 1, action: "conflict" });

    const foreign = await post(app, `/api/v2/recordings/${recordingId}/reconcile`, {
      backendInstanceId: randomUUID(),
      descriptors: [],
    });
    expect(foreign.status).toBe(409);

    const unknown = await post(app, `/api/v2/recordings/${randomUUID()}/reconcile`, {
      backendInstanceId,
      descriptors: [],
    });
    expect(unknown.status).toBe(404);
  });

  it("caps reconcile batches at 500 descriptors", async () => {
    const app = mount();
    const recordingId = randomUUID();
    const admitted = await post(app, "/api/v2/recordings", masterBody(recordingId));
    const backendInstanceId = admitted.body.backendInstanceId as string;

    const oversized = Array.from({ length: 501 }, (_, index) => ({
      index,
      checksum: sha256Hex(encode(`d-${index}`)),
      sizeBytes: index,
    }));
    const res = await post(app, `/api/v2/recordings/${recordingId}/reconcile`, {
      backendInstanceId,
      descriptors: oversized,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "validation_error" });
  });

  it("stops idempotently and lets recovery-complete move the final index", async () => {
    const app = mount();
    const recordingId = randomUUID();
    await post(app, "/api/v2/recordings", masterBody(recordingId));

    // recovery-complete during active capture is refused
    const early = await post(app, `/api/v2/recordings/${recordingId}/recovery-complete`, {
      finalSegmentIndex: 4,
    });
    expect(early.status).toBe(409);

    const stop = await post(app, `/api/v2/recordings/${recordingId}/stop`, {
      finalSegmentIndex: 5,
      reason: "user",
    });
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ captureState: "stopped", finalSegmentIndex: 5 });

    // idempotent replay ignores the new index
    const again = await post(app, `/api/v2/recordings/${recordingId}/stop`, {
      finalSegmentIndex: 9,
      reason: "user",
    });
    expect(again.body).toMatchObject({ captureState: "stopped", finalSegmentIndex: 5 });

    const recovery = await post(app, `/api/v2/recordings/${recordingId}/recovery-complete`, {
      finalSegmentIndex: 7,
    });
    expect(recovery.status).toBe(200);
    expect(recovery.body).toMatchObject({ captureState: "stopped", finalSegmentIndex: 7 });
  });

  it("refuses stop on an interrupted recording", async () => {
    const app = mount();
    const recordingId = randomUUID();
    await post(app, "/api/v2/recordings", masterBody(recordingId));
    await testDb
      .update(schema.recordingUpload)
      .set({ captureState: "interrupted" })
      .where(eq(schema.recordingUpload.recordingId, recordingId));

    const res = await post(app, `/api/v2/recordings/${recordingId}/stop`, {
      finalSegmentIndex: 2,
      reason: "user",
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "wrong_state" });
  });

  it("heartbeats liveness and reports storage readiness", async () => {
    const app = mount();
    const recordingId = randomUUID();
    await post(app, "/api/v2/recordings", masterBody(recordingId));

    const beat = await post(app, `/api/v2/recordings/${recordingId}/heartbeat`);
    expect(beat.status).toBe(200);
    expect(beat.body).toMatchObject({
      captureState: "recording",
      readiness: { postgres: true, minio: true },
    });
    const row = await testDb.query.recordingUpload.findFirst();
    expect(row!.lastHeartbeatAt).not.toBeNull();
  });

  it("reports contiguous range and missing ranges on status", async () => {
    const app = mount();
    const recordingId = randomUUID();
    await post(app, "/api/v2/recordings", masterBody(recordingId));

    await sealSegment(app, recordingId, 0);
    await sealSegment(app, recordingId, 1);
    await sealSegment(app, recordingId, 3);

    const status = await get(app, `/api/v2/recordings/${recordingId}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      captureState: "recording",
      contiguousStoredThrough: 1,
      missingRanges: [[2, 2]],
      storedCount: 3,
      segmentRevision: 3,
    });
  });

  it("surfaces a storage outage as 503 completion and false readiness", async () => {
    const dead = mount(buildMinioClient("http://127.0.0.1:9", "k", "s"));
    const recordingId = randomUUID();
    await post(dead, "/api/v2/recordings", masterBody(recordingId));

    const bytes = encode("offline-segment");
    const ticket = await post(dead, `/api/v2/recordings/${recordingId}/segments/0/ticket`, {
      checksum: sha256Hex(bytes),
      sizeBytes: bytes.length,
    });
    // presigning is offline, so the ticket mints even with MinIO unreachable
    expect(ticket.body.action).toBe("upload");

    const completion = await post(dead, `/api/v2/recordings/${recordingId}/segments/0/complete`);
    expect(completion.status).toBe(503);
    expect(completion.body).toMatchObject({ code: "storage_unavailable" });

    const beat = await post(dead, `/api/v2/recordings/${recordingId}/heartbeat`);
    expect(beat.status).toBe(200);
    expect(beat.body).toMatchObject({ readiness: { postgres: true, minio: false } });
  });
});
