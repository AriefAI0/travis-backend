import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import { createTestUser } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import { editorRoutes } from "../../../src/features/reports/editor-page";
import { reportRoutes } from "../../../src/features/reports/routes";
import { DOCX_MIME } from "../../../src/db/services/report.service";
import {
  REPORT_EDITOR_COOKIE,
  mintReportEditorToken,
} from "../../../src/lib/report_editor_token";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, reportRoutes, editorRoutes);

let adminToken = "";
let reportId = "";
let otherReportId = "";

// A report row is all the editor needs: the cookie supplies no org, so the row
// does. The project is the FK's price.
const seedReport = async (id: string) => {
  await testDb.insert(schema.report).values({
    reportId: id,
    organizationId: testOrgId,
    projectId: 1,
    name: "Alpha",
    scope: "all",
    minioKey: `reports/${id}.docx`,
  });
  return id;
};

// the cookie the page serve sets, as a browser would send it back
const cookieOf = (res: Response): string => {
  const header = res.headers.get("set-cookie") ?? "";
  const value = header.split(";")[0]!;
  expect(value.startsWith(`${REPORT_EDITOR_COOKIE}=`)).toBe(true);
  return value;
};

const asEditor = (path: string, cookie: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { ...((init.headers ?? {}) as Record<string, string>), cookie },
  });

const asAdmin = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...((init.headers ?? {}) as Record<string, string>),
      authorization: `Bearer ${adminToken}`,
    },
  });

describe("report editor page", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(async () => {
    await truncateTestDatabase();
    adminToken = (await createTestUser({ preset: "Admin" })).token;
    await testDb
      .insert(schema.project)
      .values({ organizationId: testOrgId, displayNumber: 1, projectId: 1, title: "Alpha" });
    reportId = await seedReport("11111111-1111-4111-8111-111111111111");
    otherReportId = await seedReport("22222222-2222-4222-8222-222222222222");
  });

  it("serves the page and sets a report-scoped cookie", async () => {
    const res = await app.request(`/editor/reports/${reportId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("/editor/assets/");

    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain(`${REPORT_EDITOR_COOKIE}=`);
    expect(header).toContain("HttpOnly");
    // scoped to this one report's own routes
    expect(header).toContain(`Path=/api/v1/reports/${reportId}`);
  });

  it("lets the cookie read and save its own report, with no bearer", async () => {
    const cookie = cookieOf(await app.request(`/editor/reports/${reportId}`));

    const read = await asEditor(`/api/v1/reports/${reportId}`, cookie);
    expect(read.status).toBe(200);
    const body = (await read.json()) as { data: { name: string } };
    expect(body.data.name).toBe("Alpha");

    // a save needs a version; the version answer proves the cookie got that far
    const save = await asEditor(`/api/v1/reports/${reportId}/docx`, cookie, {
      method: "PUT",
      headers: { "content-type": DOCX_MIME },
      body: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    });
    expect(save.status).toBe(428);
  });

  it("never opens another report with the same cookie", async () => {
    const cookie = cookieOf(await app.request(`/editor/reports/${reportId}`));

    const foreign = await asEditor(`/api/v1/reports/${otherReportId}`, cookie);
    expect(foreign.status).toBe(401);
  });

  it("carries no right beyond the editor's own two paths", async () => {
    const cookie = cookieOf(await app.request(`/editor/reports/${reportId}`));

    const renamed = await asEditor(`/api/v1/reports/${reportId}`, cookie, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(renamed.status).toBe(401);

    const removed = await asEditor(`/api/v1/reports/${reportId}`, cookie, { method: "DELETE" });
    expect(removed.status).toBe(401);

    // and the list is a bearer read
    const listed = await asEditor("/api/v1/projects/1/reports", cookie);
    expect(listed.status).toBe(401);
  });

  it("refuses a token minted for another report, and a tampered one", async () => {
    const foreign = mintReportEditorToken(otherReportId);
    const res = await asEditor(`/api/v1/reports/${reportId}`, `${REPORT_EDITOR_COOKIE}=${foreign}`);
    expect(res.status).toBe(401);

    const tampered = `${mintReportEditorToken(reportId)}x`;
    const bad = await asEditor(`/api/v1/reports/${reportId}`, `${REPORT_EDITOR_COOKIE}=${tampered}`);
    expect(bad.status).toBe(401);
  });

  it("still answers the bearer, and 401 with neither", async () => {
    expect((await asAdmin(`/api/v1/reports/${reportId}`)).status).toBe(200);
    expect((await app.request(`/api/v1/reports/${reportId}`)).status).toBe(401);
  });
});
