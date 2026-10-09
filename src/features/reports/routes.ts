import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import { env } from "../../config/env";
import { getProjectById } from "../../db/services/project.service";
import { AppError } from "../../lib/error";
import { minio } from "../../lib/minio_storage/clients";
import { parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { generateReport } from "./generator-client";
import {
  DOCX_MIME,
  loadSavedReport,
  loadTemplate,
  removeSavedReport,
  reportSavedKey,
  reportTemplateKey,
  saveReportEdit,
  savedReportStatus,
  templateStatus,
} from "./report-generator";

// A docx is a zip, and the editor refuses anything else — so does this.
const isZip = (bytes: Uint8Array): boolean => bytes[0] === 0x50 && bytes[1] === 0x4b;

// The browser-facing report surface: one page per project, the filled docx it
// fetches, the admin upload that replaces the bundled template, and the save
// path the in-browser editor writes back through.
export const reportRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  // what the Report dialog's link opens. The editor itself comes from esm.sh,
  // so this page has no build step and no bundled assets.
  routes.get("/reports/projects/:projectId", async (c) => {
    parseId(c, "projectId");
    const page = await Bun.file(new URL("./report-viewer.html", import.meta.url));
    return c.html(await page.text());
  });

  // the filled document; the viewer fetches it and the download link points here
  routes.get("/api/v1/projects/:projectId/report/docx", async (c) => {
    const projectId = parseId(c, "projectId");
    const docx = await generateReport(projectId, database);

    // copy into an exactly-sized ArrayBuffer so the body type stays honest
    const bytes = new Uint8Array(docx.byteLength);
    bytes.set(docx);

    return c.body(bytes.buffer, 200, {
      "content-type": DOCX_MIME,
      "content-disposition": `attachment; filename="report-${projectId}.docx"`,
      "cache-control": "no-store",
    });
  });

  // which template is in play, and whether an edited copy has been saved.
  // Flat and additive: the desktop app already reads `custom`/`updatedAt`.
  routes.get("/api/v1/projects/:projectId/report/status", async (c) => {
    const projectId = parseId(c, "projectId");

    const project = await getProjectById(projectId, database);
    if (!project) {
      throw new AppError(404, "project_not_found", `No project with id ${projectId}`);
    }

    const [template, saved] = await Promise.all([
      templateStatus(projectId),
      savedReportStatus(projectId),
    ]);

    return ok(c, { ...template, ...saved });
  });

  // the hand-edited copy. 404 means none yet, and the page renders a fresh one.
  routes.get("/api/v1/projects/:projectId/report/saved", async (c) => {
    const projectId = parseId(c, "projectId");

    const saved = await loadSavedReport(projectId);
    if (!saved) {
      throw new AppError(404, "no_saved_report", `Project ${projectId} has no saved report`);
    }

    const bytes = new Uint8Array(saved.byteLength);
    bytes.set(saved);

    return c.body(bytes.buffer, 200, {
      "content-type": DOCX_MIME,
      "content-disposition": `attachment; filename="report-${projectId}.docx"`,
      "cache-control": "no-store",
    });
  });

  // what the in-browser editor writes back
  routes.put("/api/v1/projects/:projectId/report/saved", async (c) => {
    const projectId = parseId(c, "projectId");
    const contentType = c.req.header("content-type") ?? "";

    if (!contentType.includes(DOCX_MIME) && !contentType.includes("application/octet-stream")) {
      throw new AppError(415, "unsupported_media_type", "body must be a .docx file");
    }

    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength < 4) {
      throw new AppError(400, "invalid_report", "report body is empty");
    }
    if (!isZip(body)) {
      throw new AppError(400, "invalid_report", "report body is not a .docx");
    }

    await saveReportEdit(projectId, Buffer.from(body));
    return ok(c, { projectId, key: reportSavedKey(projectId) });
  });

  // discard the edited copy, so the next open renders fresh
  routes.delete("/api/v1/projects/:projectId/report/saved", async (c) => {
    const projectId = parseId(c, "projectId");
    await removeSavedReport(projectId);
    return ok(c, { projectId });
  });

  // admin download: the layout to edit in Word, then upload back
  routes.get("/api/v1/projects/:projectId/report/template", async (c) => {
    const projectId = parseId(c, "projectId");

    const project = await getProjectById(projectId, database);
    if (!project) {
      throw new AppError(404, "project_not_found", `No project with id ${projectId}`);
    }

    // the project's own template, else the bundled default
    const docx = await loadTemplate(projectId);
    const bytes = new Uint8Array(docx.byteLength);
    bytes.set(docx);

    return c.body(bytes.buffer, 200, {
      "content-type": DOCX_MIME,
      "content-disposition": `attachment; filename="template-${projectId}.docx"`,
      "cache-control": "no-store",
    });
  });

  // admin upload: this project's own template, used instead of the bundled one
  routes.put("/api/v1/projects/:projectId/report/template", async (c) => {
    const projectId = parseId(c, "projectId");
    const contentType = c.req.header("content-type") ?? "";

    if (!contentType.includes(DOCX_MIME) && !contentType.includes("application/octet-stream")) {
      throw new AppError(415, "unsupported_media_type", "body must be a .docx file");
    }

    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength < 4) {
      throw new AppError(400, "invalid_template", "template body is empty");
    }
    // a docx is a zip; anything else would fail much later, inside docxtemplater
    if (!isZip(body)) {
      throw new AppError(400, "invalid_template", "template body is not a .docx");
    }

    const key = reportTemplateKey(projectId);
    await minio.putObject(env.BUCKET_MEDIA, key, Buffer.from(body), body.byteLength, {
      "Content-Type": DOCX_MIME,
    });

    return ok(c, { projectId, key });
  });

  return routes;
};
