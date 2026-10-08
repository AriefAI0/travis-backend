import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { reportRoutes } from "../../../src/features/reports/routes";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, reportRoutes);

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

const seedProject = () =>
  testDb.insert(schema.project).values({ projectId: 1, displayNumber: 1, title: "Alpha" });

describe("report routes", () => {
  it("serves the dialog, which generates only on request", async () => {
    const res = await app.request("/reports/projects/1");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Generate report");
    // the report is fetched on click, never on load
    expect(html).toContain("/report/docx");
    expect(html).toContain("startGenerate");
    // template management rides the same page
    expect(html).toContain("/report/template");
    // no CDN leg remains
    expect(html).not.toContain("esm.sh");

    // the inline script must parse: a syntax error blanks the whole dialog
    const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
    expect(() => new Function(script)).not.toThrow();
  });

  it("serves the filled document as a docx", async () => {
    await seedProject();

    const res = await app.request("/api/v1/projects/1/report/docx");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("wordprocessingml.document");
    expect(res.headers.get("content-disposition")).toContain('report-1.docx');

    // a docx is a zip, so the first two bytes are the zip magic
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe("PK");
  });

  it("answers 404 for an unknown project", async () => {
    const res = await app.request("/api/v1/projects/999/report/docx");

    expect(res.status).toBe(404);
  });

  it("rejects a template upload that is not a docx", async () => {
    const res = await app.request("/api/v1/projects/1/report/template", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "not a docx",
    });

    expect(res.status).toBe(415);
  });

  it("rejects an empty template body", async () => {
    const res = await app.request("/api/v1/projects/1/report/template", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(0),
    });

    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric project id", async () => {
    const res = await app.request("/api/v1/projects/abc/report/docx");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
