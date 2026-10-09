import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { reportRoutes } from "../../../src/features/reports/routes";
import { DOCX_MIME } from "../../../src/features/reports/report-generator";
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
    // the editor is hosted, not bundled: no build step ships with this page
    expect(html).toContain("esm.sh/@docx-editor.dev/core");
    expect(html).toContain("mountReportEditor");

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

  it("hands back the bundled template when the project has none", async () => {
    await seedProject();

    const res = await app.request("/api/v1/projects/1/report/template");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("wordprocessingml.document");
    expect(res.headers.get("content-disposition")).toContain('template-1.docx');

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe("PK");
  });

  it("answers 404 for a template on an unknown project", async () => {
    const res = await app.request("/api/v1/projects/999/report/template");

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

describe("report editor page", () => {
  it("loads the editor module from esm.sh and its stylesheet", async () => {
    const res = await app.request("/reports/projects/1");
    const html = await res.text();

    expect(html).toContain('import { createDocxEditor } from "https://esm.sh/@docx-editor.dev/core@');
    expect(html).toContain('link rel="stylesheet" href="https://esm.sh/@docx-editor.dev/core@');

    // the editor is hosted, so the page must ship no bundled asset of its own
    expect(res.status).toBe(200);
    for (const gone of ["__ASSET_V__", "/reports/assets/editor-client.js"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("keeps the dialog usable when the editor module never arrives", async () => {
    const res = await app.request("/reports/projects/1");
    const html = await res.text();

    // the bootstrap checks for the module and falls back instead of throwing
    expect(html).toContain("reportEditorFallback");
    expect(html).toContain('typeof window.mountReportEditor !== "function"');
  });

  it("serves no editor assets of its own any more", async () => {
    const res = await app.request("/reports/assets/editor-client.js");

    expect(res.status).toBe(404);
  });
});

describe("saved report", () => {
  // the round-trip put needs a real docx, and the docx route needs a project.
  // awaited explicitly: drizzle's builder is a thenable, not a Promise.
  beforeEach(async () => {
    await seedProject();
  });

  const put = (body: Uint8Array | string, contentType: string) =>
    app.request("/api/v1/projects/1/report/saved", {
      method: "PUT",
      headers: { "content-type": contentType },
      body,
    });

  afterEach(async () => {
    await app.request("/api/v1/projects/1/report/saved", { method: "DELETE" });
  });

  it("answers 404 when nothing has been saved", async () => {
    const res = await app.request("/api/v1/projects/1/report/saved");

    expect(res.status).toBe(404);
  });

  it("round-trips saved bytes", async () => {
    // a real docx, so the zip guard is exercised rather than bypassed
    const original = await app.request("/api/v1/projects/1/report/docx");
    expect(original.status).toBe(200);
    const docx = new Uint8Array(await original.arrayBuffer());
    expect(Buffer.from(docx).subarray(0, 2).toString()).toBe("PK");

    const written = await put(docx, "application/octet-stream");
    expect(written.status).toBe(200);

    const read = await app.request("/api/v1/projects/1/report/saved");
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toContain("wordprocessingml.document");

    const buf = Buffer.from(await read.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe("PK");
  });

  it("drops the saved copy on delete", async () => {
    const docx = new Uint8Array(await (await app.request("/api/v1/projects/1/report/docx")).arrayBuffer());
    await put(docx, DOCX_MIME);

    const removed = await app.request("/api/v1/projects/1/report/saved", { method: "DELETE" });
    expect(removed.status).toBe(200);

    const res = await app.request("/api/v1/projects/1/report/saved");
    expect(res.status).toBe(404);
  });

  it("rejects a saved body that is not a docx", async () => {
    expect((await put("not a docx at all", "text/plain")).status).toBe(415);
    expect((await put(new Uint8Array(0), "application/octet-stream")).status).toBe(400);
    // right mime, wrong magic — this is what keeps a stray upload out of storage
    expect((await put("plainly not a zip", DOCX_MIME)).status).toBe(400);
  });

  it("rejects a template upload that is not a zip at all", async () => {
    const res = await app.request("/api/v1/projects/1/report/template", {
      method: "PUT",
      headers: { "content-type": DOCX_MIME },
      body: "plainly not a zip",
    });

    expect(res.status).toBe(400);
  });
});
