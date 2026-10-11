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
import { resultRoutes } from "../../../src/features/results/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, resultRoutes);

// full chain: project > session > asset > component > item > sessionItem > result
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
    label: "I",
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

// read-only views; "no data" is data:null or empty arrays, never 404
describe("results routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);



  it("evidence always carries clips + images arrays", async () => {
    await seedResultContext();

    const res = await app.request("/api/v1/results/5001/evidence");
    expect(res.status).toBe(200);
    expect(await json<unknown>(res)).toEqual({
      ok: true,
      data: { clips: [], images: [] },
    });
  });

  it("typed detail with no row is 200 + data null", async () => {
    await seedResultContext();

    const res = await app.request("/api/v1/results/5001/gvi");
    expect(res.status).toBe(200);
    expect(await json<unknown>(res)).toEqual({ ok: true, data: null });
  });

  it("form-state reads the row itself, and is null for a row that is gone", async () => {
    await seedResultContext();

    const open = await app.request("/api/v1/results/5001/form-state");
    expect(open.status).toBe(200);
    expect((await json(open)).data).toEqual({
      resultId: 5001,
      remarks: null,
      customValues: null,
      layer: 1,
      inspectionTypeCode: "GVI",
      sessionId: 101,
      masterEndMs: null,
      // an open row has not been submitted, so there is nothing to prefill from
      submittedPayload: null,
      // the class is chosen at submit; an open row sits on the column default
      resultClass: "normal",
    });

    const missing = await app.request("/api/v1/results/99999/form-state");
    expect(missing.status).toBe(200);
    expect(await json<unknown>(missing)).toEqual({ ok: true, data: null });
  });

  it("form-state echoes a stopped row's payload and custom values", async () => {
    await seedResultContext();
    const payload = { kind: "gvi", version: 1, condition: "ok", gviCP: [] };
    await testDb
      .update(schema.result)
      .set({
        masterEndMs: 4000,
        customValues: { 7: "note" },
        submittedPayload: payload,
        remarks: "deck",
      })
      .where(eq(schema.result.resultId, 5001));

    const res = await app.request("/api/v1/results/5001/form-state");
    const data = (await json(res)).data as Record<string, unknown>;
    expect(data.masterEndMs).toBe(4000);
    expect(data.submittedPayload).toEqual(payload);
    expect(data.customValues).toEqual({ 7: "note" });
    expect(data.remarks).toBe("deck");
  });

  it("project recordings + summary for a seeded project", async () => {
    await seedResultContext();

    const recordings = await app.request("/api/v1/projects/1/recordings");
    expect(recordings.status).toBe(200);
    expect((await json(recordings)).data).toEqual([]);

    const summary = await app.request("/api/v1/projects/1/results/summary");
    expect(summary.status).toBe(200);
    expect(Array.isArray((await json(summary)).data)).toBe(true);
  });

  it("image batch read returns empty map for unknown ids", async () => {
    const res = await app.request("/api/v1/images/by-result-ids", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resultIds: [99999] }),
    });
    expect(res.status).toBe(200);
    expect(await json<unknown>(res)).toEqual({ ok: true, data: {} });
  });

  it("image batch read rejects non-positive ids as validation_error", async () => {
    const res = await app.request("/api/v1/images/by-result-ids", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resultIds: [-1] }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("validation_error");
  });
});
