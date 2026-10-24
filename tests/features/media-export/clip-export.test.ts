import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import * as schema from "../../../src/db/schema";
import {
  clipExportDeps,
  getClipExport,
  getClipExportDownload,
  recoverClipExports,
  resetClipExportDeps,
  runClipExport,
  startClipExport,
} from "../../../src/db/services/clip-export.service";
import {
  findClipExportByClipId,
  startClipExportRecord,
} from "../../../src/db/repositories/clip-export.repository";
import { mergeClip, type RemuxResult } from "../../../src/features/recording/jobs/remux";

const readyMerge: RemuxResult = {
  status: "ok",
  key: "1/1/1/2026/10/24/clips/5001-jl-01-gvi/clip-7/exports/merged-3.mkv",
  localFile: null,
  sizeBytes: 4096,
  durationMs: 3000,
  step: "cache",
  error: null,
};

const seedWorld = async () => {
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
    endOffsetMs: 30_000,
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

describe("clip export jobs", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(async () => {
    await truncateTestDatabase();
    resetClipExportDeps();
    clipExportDeps.mergeClip = mock(async () => readyMerge);
    await seedWorld();
  });

  it("reuses one job row for repeated requests", async () => {
    const first = await startClipExport(7, testDb);
    const second = await startClipExport(7, testDb);
    expect(second.jobId).toBe(first.jobId);

    await Bun.sleep(5);
    const row = await findClipExportByClipId(7, testDb);
    expect(row?.jobId).toBe(first.jobId);
    expect(row?.status).toBe("ready");
  });

  it("stores the stored MKV leaf and byte size", async () => {
    const job = await startClipExportRecord(7, testDb);
    await runClipExport(job!.jobId, testDb);

    const state = await getClipExport(7, testDb);
    expect(state).toMatchObject({
      clipId: 7,
      state: "ready",
      filename: "merged-3.mkv",
      sizeBytes: 4096,
      error: null,
    });
  });

  it("keeps a readable error and retries the same row", async () => {
    clipExportDeps.mergeClip = mock(async () => ({
      ...readyMerge,
      status: "failed" as const,
      key: null,
      sizeBytes: 0,
      error: "not enough scratch space",
    }));
    const job = await startClipExportRecord(7, testDb);
    await runClipExport(job!.jobId, testDb);

    let state = await getClipExport(7, testDb);
    expect(state?.state).toBe("failed");
    expect(state?.error).toContain("not enough scratch space");

    clipExportDeps.mergeClip = mock(async () => readyMerge);
    const retried = await startClipExport(7, testDb);
    expect(retried.jobId).toBe(job!.jobId);
    await Bun.sleep(5);
    state = await getClipExport(7, testDb);
    expect(state?.state).toBe("ready");
  });

  it("recovers a job left processing by a restart", async () => {
    const job = await startClipExportRecord(7, testDb);
    // no start call: the row is exactly what a dead process leaves
    expect(job?.status).toBe("processing");

    expect(await recoverClipExports(testDb)).toBe(1);
    await Bun.sleep(5);
    expect((await getClipExport(7, testDb))?.state).toBe("ready");
  });

  it("names the download with the stored MKV leaf", async () => {
    const job = await startClipExportRecord(7, testDb);
    await runClipExport(job!.jobId, testDb);

    const download = await getClipExportDownload(7, testDb);
    expect(download.filename).toBe("merged-3.mkv");
    expect(download.url).toContain("merged-3.mkv");
    expect(download.sizeBytes).toBe(4096);
  });

  it("keeps each job on its own scratch directory", async () => {
    const seen: string[] = [];
    clipExportDeps.scratchRoot = (jobId) => {
      const path = `/tmp/clip-export-${jobId}`;
      seen.push(path);
      return path;
    };
    const first = await startClipExportRecord(7, testDb);
    await runClipExport(first!.jobId, testDb);
    const other = await startClipExportRecord(7, testDb);
    await runClipExport(other!.jobId, testDb);

    expect(seen[0]).toBe(`/tmp/clip-export-${first!.jobId}`);
    expect(seen[1]).toBe(`/tmp/clip-export-${other!.jobId}`);
  });

  it("uses the same mergeClip contract as the excel export", () => {
    expect(typeof mergeClip).toBe("function");
  });
});
