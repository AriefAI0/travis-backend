import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

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
import { exportRoutes } from "../../../src/features/media-export/routes";
import { clipExportDeps, resetClipExportDeps } from "../../../src/db/services/clip-export.service";
import {
  markClipExportReady,
  startClipExportRecord,
} from "../../../src/db/repositories/clip-export.repository";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, exportRoutes);
let token = "";

const seedClip = async (open = false) => {
  await testDb.insert(schema.project).values({
    organizationId: testOrgId,
    displayNumber: 1,
    projectId: 1,
    title: "Alpha",
  });
  await testDb.insert(schema.session).values({
    displayNumber: 1,
    sessionId: 101,
    projectId: 1,
  });
  await testDb.insert(schema.taskGroup).values({
    taskGroupId: 10,
    projectId: 1,
    code: "100",
  });
  await testDb.insert(schema.taskCode).values({
    taskCodeId: 20,
    taskGroupId: 10,
    code: "101",
  });
  await testDb.insert(schema.description).values({
    descriptionId: 100,
    taskCodeId: 20,
    label: "Row A",
  });
  await testDb.insert(schema.result).values({
    resultId: 5001,
    displayNumber: 1,
    inspectionTypeCode: "GVI",
    projectId: 1,
    sessionId: 101,
    descriptionId: 100,
    layer: 1,
    masterStartMs: 0,
    masterEndMs: 4000,
  });
  await testDb.insert(schema.videoClip).values({
    clipId: 7,
    resultId: 5001,
    sessionId: 101,
    startOffsetMs: 0,
    endOffsetMs: open ? null : 30_000,
  });
  await testDb.insert(schema.recordingIngest).values({
    kind: "clip",
    clipId: 7,
    ticketHash: "a".repeat(64),
    keyDate: "2026-10-24",
    keyPrefix: "1/1/1/2026/10/24/clips/5001-jl-01-gvi/clip-7",
    closedAt: new Date(),
    finalSequence: 2,
  });
};

const request = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });

describe("clip export routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(async () => {
    await truncateTestDatabase();
    resetClipExportDeps();
    clipExportDeps.mergeClip = mock(async () => ({
      status: "failed" as const,
      key: null,
      localFile: null,
      sizeBytes: 0,
      durationMs: 0,
      step: null,
      error: "test merge",
    }));
    token = (await createTestUser({ preset: "Operator" })).token;
  });

  it("requires a token and read Recording", async () => {
    await seedClip();
    const res = await app.request("/api/v1/clips/7/export", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("refuses an open clip before starting work", async () => {
    await seedClip(true);
    const res = await request("/api/v1/clips/7/export", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("clip_open");
  });

  it("refuses a closed clip with no playable ingest", async () => {
    await seedClip();
    await testDb.delete(schema.recordingIngest);

    const res = await request("/api/v1/clips/7/export", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("no_playable_ingest");
  });

  it("answers 404 for a clip export that was never started", async () => {
    await seedClip();
    const res = await request("/api/v1/clips/7/export");
    expect(res.status).toBe(404);
  });

  it("returns a ready state and the stored leaf download", async () => {
    await seedClip();
    const job = await startClipExportRecord(7, testDb);
    await markClipExportReady(
      job!.jobId,
      {
        objectKey: "1/1/1/2026/10/24/clips/5001-jl-01-gvi/clip-7/exports/merged-3.mkv",
        filename: "merged-3.mkv",
        sizeBytes: 4096,
      },
      testDb,
    );

    const status = await request("/api/v1/clips/7/export");
    expect(status.status).toBe(200);
    expect((await json(status)).data).toMatchObject({
      clipId: 7,
      state: "ready",
      filename: "merged-3.mkv",
      sizeBytes: 4096,
    });

    const download = await request("/api/v1/clips/7/export/download-url");
    expect(download.status).toBe(200);
    const body = (await json(download)).data as Record<string, unknown>;
    expect(body.filename).toBe("merged-3.mkv");
    expect(String(body.url)).toContain("merged-3.mkv");
  });

  it("refuses a download before the merge is ready", async () => {
    await seedClip();
    const job = await startClipExportRecord(7, testDb);
    await testDb
      .update(schema.clipExportJob)
      .set({ status: "failed", error: "boom" })
      .where(eq(schema.clipExportJob.jobId, job!.jobId));

    const res = await request("/api/v1/clips/7/export/download-url");
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("export_not_ready");
  });

  it("reads a clip in another org as absent", async () => {
    await seedClip();
    const [otherOrg] = await testDb
      .insert(schema.organization)
      .values({ name: `Other org ${Date.now()}` })
      .returning();
    await testDb
      .update(schema.project)
      .set({ organizationId: otherOrg!.organizationId })
      .where(eq(schema.project.projectId, 1));

    const res = await request("/api/v1/clips/7/export", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
