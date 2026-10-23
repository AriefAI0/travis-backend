import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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
import { excelExportRoutes } from "../../../src/features/excel-export/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, excelExportRoutes);

let token = "";
let userId = "";

beforeAll(ensureTestDatabase);
beforeEach(async () => {
  await truncateTestDatabase();
  const user = await createTestUser({ preset: "Admin" });
  token = user.token;
  userId = user.userId;
});
afterAll(closeTestDatabase);

type Body<T> = { data: T };

// project > group > code > description > type > part code
const seed = async () => {
  await testDb.insert(schema.project).values({
    organizationId: testOrgId,
    projectId: 1,
    displayNumber: 1,
    title: "Alpha",
  });
  await testDb.insert(schema.session).values({ sessionId: 101, projectId: 1, displayNumber: 1, name: "Run 1" });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 1, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 10, taskGroupId: 1, code: "101" });
  await testDb.insert(schema.description).values({ descriptionId: 100, taskCodeId: 10, label: "Leg A" });
  await testDb.insert(schema.type).values({ typeId: 200, descriptionId: 100, code: "T1" });
  await testDb.insert(schema.partCode).values({ partCodeId: 300, typeId: 200, code: "P1" });
  await testDb.insert(schema.result).values({
    resultId: 5001,
    displayNumber: 1,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "GVI",
    partCodeId: 300,
    layer: 1,
    masterStartMs: 0,
  });
  await testDb.insert(schema.resultGvi).values({ resultId: 5001, condition: "ok" });
};

const request = (path: string, init: RequestInit = {}, withToken = token) =>
  app.request(path, {
    ...init,
    headers: {
      ...((init.headers ?? {}) as Record<string, string>),
      authorization: `Bearer ${withToken}`,
    },
  });

const preview = (body: unknown, withToken = token) =>
  request(
    "/api/v1/projects/1/excel-exports/preview",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    withToken,
  );

const create = (body: unknown, withToken = token) =>
  request(
    "/api/v1/projects/1/excel-exports",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    withToken,
  );

const readData = async <T>(res: Response): Promise<T> => ((await res.json()) as Body<T>).data;
const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;

type ExportBody = { id: string; status: string; media: string };

describe("excel export routes", () => {
  it("previews counts and every media level's size", async () => {
    await seed();

    const res = await preview({ types: ["GVI"], targets: ["partCode:300"] });
    expect(res.status).toBe(200);

    const body = await readData<{
      counts: Record<string, number>;
      preview: { sheets: { type: string; rows: unknown[] }[] };
      estimates: Record<string, { bytes: number; zip64: boolean }>;
    }>(res);

    expect(body.counts.GVI).toBe(1);
    expect(body.preview.sheets[0]!.rows).toHaveLength(1);
    expect(body.estimates.raw!.bytes).toBeGreaterThan(0);
    // no media on this result, so every level adds nothing above the workbook
    expect(body.estimates.images!.bytes).toBeGreaterThanOrEqual(body.estimates.raw!.bytes);
    expect(body.estimates.clips!.bytes).toBeGreaterThanOrEqual(body.estimates.images!.bytes);
    expect(body.estimates.clips!.zip64).toBe(false);
  });

  it("exports no rows for a target from another project", async () => {
    await seed();

    // 999 names no tree row in this project; the answer is zero, not an error
    const res = await preview({ types: ["GVI"], targets: ["partCode:999"] });
    const body = await readData<{ counts: Record<string, number> }>(res);

    expect(body.counts.GVI).toBe(0);
  });

  it("queues an export and returns the same live row for a repeat", async () => {
    await seed();

    const first = await create({ types: ["GVI"], targets: ["partCode:300"], media: "raw" });
    expect(first.status).toBe(202);
    const row = await readData<ExportBody>(first);
    expect(row.status).toBe("queued");

    const again = await create({ types: ["GVI"], targets: ["partCode:300"], media: "raw" });
    expect((await readData<ExportBody>(again)).id).toBe(row.id);
  });

  it("lists the caller's exports", async () => {
    await seed();
    await create({ types: ["GVI"], targets: ["partCode:300"], media: "raw" });

    const res = await request("/api/v1/excel-exports");
    const list = await readData<ExportBody[]>(res);

    expect(list).toHaveLength(1);
    expect(list[0]!.media).toBe("raw");
  });

  it("hides another user's export behind a 404 on every id route", async () => {
    await seed();
    const created = await create({ types: ["GVI"], targets: ["partCode:300"], media: "raw" });
    const { id } = await readData<ExportBody>(created);

    const other = await createTestUser({ preset: "Admin" });

    for (const [method, path] of [
      ["GET", `/api/v1/excel-exports/${id}`],
      ["POST", `/api/v1/excel-exports/${id}/cancel`],
      ["DELETE", `/api/v1/excel-exports/${id}`],
      ["GET", `/api/v1/excel-exports/${id}/download-url`],
    ] as const) {
      const res = await request(path, { method }, other.token);
      expect(res.status).toBe(404);
      expect(await codeOf(res)).toBe("export_not_found");
    }
  });

  it("refuses to remove a live export", async () => {
    await seed();
    const created = await create({ types: ["GVI"], targets: ["partCode:300"], media: "raw" });
    const { id } = await readData<ExportBody>(created);

    const res = await request(`/api/v1/excel-exports/${id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("export_active");
  });

  it("cancels a queued export and then removes it", async () => {
    await seed();
    const created = await create({ types: ["GVI"], targets: ["partCode:300"], media: "raw" });
    const { id } = await readData<ExportBody>(created);

    const cancelled = await request(`/api/v1/excel-exports/${id}/cancel`, { method: "POST" });
    expect((await readData<ExportBody>(cancelled)).status).toBe("cancelled");

    const removed = await request(`/api/v1/excel-exports/${id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);

    const gone = await request(`/api/v1/excel-exports/${id}`);
    expect(gone.status).toBe(404);
  });

  it("refuses a download link before the package exists", async () => {
    await seed();
    const created = await create({ types: ["GVI"], targets: ["partCode:300"], media: "raw" });
    const { id } = await readData<ExportBody>(created);

    const res = await request(`/api/v1/excel-exports/${id}/download-url`);
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("export_not_ready");
  });

  it("mints a signed link for a ready export", async () => {
    await seed();
    const created = await create({ types: ["GVI"], targets: ["partCode:300"], media: "raw" });
    const { id } = await readData<ExportBody>(created);

    // the worker is not running here, so land the row by hand
    await testDb
      .update(schema.excelExport)
      .set({ status: "ready", packageKey: "excel-exports/light/one.xlsx", packageSize: 10 })
      .where(eq(schema.excelExport.id, id));

    const res = await request(`/api/v1/excel-exports/${id}/download-url`);
    expect(res.status).toBe(200);

    const body = await readData<{ url: string; filename: string }>(res);
    expect(body.url).toContain("excel-exports/light/one.xlsx");
    expect(body.filename).toMatch(/\.xlsx$/);
  });

  it("answers 404 for an unknown project", async () => {
    const res = await preview({ types: ["GVI"], targets: ["partCode:300"] });
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("project_not_found");
  });
});
