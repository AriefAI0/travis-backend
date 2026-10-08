import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import { env } from "../../config/env";
import { getProjectById } from "../../db/services/project.service";
import { AppError } from "../../lib/error";
import { minio } from "../../lib/minio_storage/clients";
import { parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { generateReport } from "./generator-client";
import { loadTemplate, reportTemplateKey, templateStatus } from "./report-generator";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// The browser-facing report surface: one page per project, the filled docx it
// fetches, and the admin upload that replaces the bundled template.
export const reportRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  // what the Report dialog's link opens
  routes.get("/reports/projects/:projectId", async (c) => {
    parseId(c, "projectId");
    const page = Bun.file(new URL("./report-viewer.html", import.meta.url));
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

  // which template is in play: uploaded or the bundled default
  routes.get("/api/v1/projects/:projectId/report/status", async (c) => {
    const projectId = parseId(c, "projectId");

    const project = await getProjectById(projectId, database);
    if (!project) {
      throw new AppError(404, "project_not_found", `No project with id ${projectId}`);
    }

    return ok(c, await templateStatus(projectId));
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

    const body = await c.req.arrayBuffer();
    if (body.byteLength < 4) {
      throw new AppError(400, "invalid_template", "template body is empty");
    }

    const key = reportTemplateKey(projectId);
    await minio.putObject(env.BUCKET_MEDIA, key, Buffer.from(body), body.byteLength, {
      "Content-Type": DOCX_MIME,
    });

    return ok(c, { projectId, key });
  });

  return routes;
};
