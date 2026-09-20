import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import * as schema from "../../../src/db/schema";
import { env } from "../../../src/config/env";
import { onError } from "../../../src/lib/error";
import { ingestRoutes } from "../../../src/features/recordings-v2/ingest-routes";
import { SEGMENT_MAX_BYTES, type SegmentStorage } from "../../../src/features/recordings-v2/ingest-service";

const PROJECT_ID = 9400;

const seedDomain = async () => {
  await testDb.insert(schema.project).values({ projectId: PROJECT_ID, title: "P" });
  await testDb
    .insert(schema.session)
    .values({ sessionId: PROJECT_ID, projectId: PROJECT_ID, name: "S" });
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
  await testDb.insert(schema.result).values({
    resultId: PROJECT_ID,
    sessionItemId: PROJECT_ID,
    inspectionTypeCode: "GVI",
    projectId: PROJECT_ID,
    assetId: PROJECT_ID,
    componentId: PROJECT_ID,
    itemId: PROJECT_ID,
    sessionId: PROJECT_ID,
  });
};

const segmentBody = (label: string) => {
  const body = new Uint8Array(1024);
  for (let i = 0; i < body.length; i++) body[i] = (label.charCodeAt(0) + i) & 0xff;
  return body;
};

type Json = { status: number; body: Record<string, unknown> };

const read = async (res: Response): Promise<Json> => {
  const json = (await res.json()) as { ok?: boolean; data?: Record<string, unknown> };
  return { status: res.status, body: (json.ok ? json.data : json) as Record<string, unknown> };
};

describe("direct ingest routes", () => {
  const puts: string[] = [];
  const storage: SegmentStorage = {
    put: async (_bucket, key) => {
      puts.push(key);
    },
  };

  // only the direct ingest transport is mounted here
  const app = new Hono();
  app.onError(onError);
  app.route("/", ingestRoutes(testDb, storage));

  beforeAll(async () => {
    await ensureTestDatabase();
  });

  afterAll(() => {
    env.RECORDING_V2_TOKEN = undefined;
    closeTestDatabase();
  });

  beforeEach(async () => {
    puts.length = 0;
    await truncateTestDatabase();
    await seedDomain();
  });

  const admit = async (body: Record<string, unknown> = { kind: "master", projectId: PROJECT_ID, startEpoch: 1_760_000_000 }) =>
    read(
      await app.request("/api/v2/ingests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const postSegment = (ingestId: number, ticket: string | null, body: Uint8Array, sequence = 0, durationMs = 2000) => {
    const headers: Record<string, string> = {
      "x-segment-sequence": String(sequence),
      "x-segment-duration-ms": String(durationMs),
      "x-segment-checksum-sha256": createHash("sha256").update(body).digest("hex"),
      "content-length": String(body.byteLength),
    };
    if (ticket !== null) headers.authorization = `Bearer ${ticket}`;
    return app.request(`/api/v2/ingests/${ingestId}/segments`, { method: "POST", headers, body });
  };

  test("admission returns identity and the segment target", async () => {
    const res = await admit();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      segmentTargetMs: 2000,
      domain: { kind: "master", projectId: PROJECT_ID },
    });
    expect(typeof res.body.ingestId).toBe("number");
    expect(typeof res.body.ticket).toBe("string");
  });

  test("admission rejects a wrong deployment token; a recording route stays open", async () => {
    env.RECORDING_V2_TOKEN = "deployment-secret";
    const blocked = await admit();
    env.RECORDING_V2_TOKEN = undefined;

    expect(blocked.status).toBe(401);

    // a recording route stays open: the ticket is its gate
    const admission = await admit();
    const res = await postSegment(admission.body.ingestId as number, admission.body.ticket as string, segmentBody("a"));
    expect(res.status).toBe(201);
  });

  test("admission rejects a body outside the contract", async () => {
    expect((await admit({ kind: "master", startEpoch: 1 })).status).toBe(400);
    expect((await admit({ kind: "clip", resultId: PROJECT_ID })).status).toBe(400);
    // no client identity is part of the contract
    const withHandle = await admit({
      kind: "master",
      projectId: PROJECT_ID,
      startEpoch: 1_760_000_000,
      captureHandle: "8b6f1c2e-0000-4000-8000-000000000000",
    });
    expect(withHandle.status).toBe(201);
    expect(JSON.stringify(withHandle.body)).not.toMatch(/captureHandle/i);
  });

  test("a segment stores once, replays as 200, and reports the prefix", async () => {
    const admission = await admit();
    const ingestId = admission.body.ingestId as number;
    const ticket = admission.body.ticket as string;
    const body = segmentBody("a");

    const first = await read(await postSegment(ingestId, ticket, body));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ replayed: false, sequence: 0, contiguousSequence: 0 });
    expect(puts).toHaveLength(1);

    const replay = await read(await postSegment(ingestId, ticket, body));
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(puts).toHaveLength(1);
  });

  test("missing and wrong tickets fail", async () => {
    const admission = await admit();
    const other = await admit();
    const ingestId = admission.body.ingestId as number;

    const missing = await read(await postSegment(ingestId, null, segmentBody("a")));
    expect(missing.status).toBe(401);

    const wrong = await read(
      await postSegment(ingestId, other.body.ticket as string, segmentBody("a")),
    );
    expect(wrong.status).toBe(401);

    const status = await app.request(`/api/v2/ingests/${ingestId}`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(status.status).toBe(401);
    expect(puts).toHaveLength(0);
  });

  test("bad segment headers fail before the body is read", async () => {
    const admission = await admit();
    const ingestId = admission.body.ingestId as number;
    const ticket = admission.body.ticket as string;
    const body = segmentBody("a");

    const short = await app.request(`/api/v2/ingests/${ingestId}/segments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ticket}`,
        "x-segment-sequence": "0",
        "x-segment-duration-ms": "50",
        "x-segment-checksum-sha256": "a".repeat(64),
        "content-length": String(body.byteLength),
      },
      body,
    });
    expect(short.status).toBe(400);

    const noLength = await app.request(`/api/v2/ingests/${ingestId}/segments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ticket}`,
        "x-segment-sequence": "0",
        "x-segment-duration-ms": "2000",
        "x-segment-checksum-sha256": "a".repeat(64),
      },
      body,
    });
    expect(noLength.status).toBe(411);
    expect(puts).toHaveLength(0);
  });

  test("an oversized segment is refused at the cap", async () => {
    const admission = await admit();
    const over = await app.request(`/api/v2/ingests/${admission.body.ingestId}/segments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${admission.body.ticket as string}`,
        "x-segment-sequence": "0",
        "x-segment-duration-ms": "2000",
        "x-segment-checksum-sha256": "a".repeat(64),
        "content-length": String(SEGMENT_MAX_BYTES + 1),
      },
      body: new Uint8Array(64),
    });

    expect(over.status).toBe(413);
    expect(puts).toHaveLength(0);
  });

  test("close then status report the frozen range", async () => {
    const admission = await admit();
    const ingestId = admission.body.ingestId as number;
    const ticket = admission.body.ticket as string;
    await postSegment(ingestId, ticket, segmentBody("a"), 0, 2000);
    await postSegment(ingestId, ticket, segmentBody("b"), 1, 2500);

    const closed = await read(
      await app.request(`/api/v2/ingests/${ingestId}/close`, {
        method: "POST",
        headers: { authorization: `Bearer ${ticket}` },
      }),
    );
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ finalSequence: 1, durationMs: 4500, replayed: false });

    const status = await read(
      await app.request(`/api/v2/ingests/${ingestId}`, {
        headers: { authorization: `Bearer ${ticket}` },
      }),
    );
    expect(status.body).toMatchObject({
      open: false,
      contiguousSequence: 1,
      finalSequence: 1,
      segmentCount: 2,
      domain: { kind: "master", masterVideoId: expect.any(Number) },
    });
  });

  test("the ticket never lands in a response body of a recording route", async () => {
    const admission = await admit();
    const ticket = admission.body.ticket as string;
    const ingestId = admission.body.ingestId as number;

    const status = await read(
      await app.request(`/api/v2/ingests/${ingestId}`, {
        headers: { authorization: `Bearer ${ticket}` },
      }),
    );
    expect(JSON.stringify(status.body)).not.toContain(ticket);
    expect(JSON.stringify(puts)).not.toContain(ticket);
  });

  test("unknown ingest is 404 on every recording route", async () => {
    expect((await app.request("/api/v2/ingests/999999", { headers: { authorization: "Bearer x" } })).status).toBe(404);
    expect(
      (
        await app.request("/api/v2/ingests/999999/close", {
          method: "POST",
          headers: { authorization: "Bearer x" },
        })
      ).status,
    ).toBe(404);
  });

  test("both the old v2 surface and the legacy handler are gone", async () => {
    // old v2 admission is deleted: a plain router miss, not a handled 400
    const removed = await app.request("/api/v2/recordings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "master" }),
    });
    expect(removed.status).toBe(404);

    // legacy handler is unmounted: a router miss, not its own bad_index 400
    const legacy = await app.request("/api/minio_handler/sessions/unknown-id/segments", {
      method: "POST",
    });
    expect(legacy.status).toBe(404);
  });
});
