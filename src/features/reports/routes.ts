import { Hono, type Context } from "hono";
import type { DbOrTx } from "../../db/client";
import { getProjectById } from "../../db/services/project.service";
import {
  DOCX_MIME,
  getReportStatus,
  listProjectReports,
  loadReportDocx,
  removeReport,
  renameReport,
  reportListItem,
  saveReportDocx,
} from "../../db/services/report.service";
import { AppError } from "../../lib/error";
import { parseBody, parseId, parseUuid } from "../../lib/parse";
import { ok } from "../../lib/response";
import { convertDocxToPdf } from "../../lib/pdf/convert";
import { reportCreateSchema, reportNameSchema } from "../../types/api";
import { queueReportGeneration } from "./generate";
import { refreshReport } from "./refresh";

const PDF_MIME = "application/pdf";

// The version the editor loaded, sent on save.
const VERSION_HEADER = "x-report-version";

// A version is a positive integer, or absent. Anything else is not a version,
// and the service answers 428 for absent.
const parseVersion = (header: string | undefined): number | null => {
  if (header === undefined || header.trim() === "") return null;

  const version = Number(header);
  if (!Number.isInteger(version) || version < 1) {
    throw new AppError(400, "invalid_version", `${VERSION_HEADER} must be a positive integer`);
  }

  return version;
};

// A docx is a zip, and the editor refuses anything else — so does this.
const isZip = (bytes: Uint8Array): boolean => bytes[0] === 0x50 && bytes[1] === 0x4b;

// The name is user text, so anything outside a safe set drops out. A quote or a
// newline in a header splits the response.
const attachmentFilename = (name: string, reportId: string, extension: string) => {
  const safe = name.replace(/[^A-Za-z0-9 ._-]/g, "").trim();
  return `${safe || `report-${reportId}`}.${extension}`;
};

// The bytes leave as a download, never as a page the browser renders.
const attachmentResponse = (c: Context, bytes: Uint8Array, filename: string, mime: string) => {
  // copy into an exactly-sized ArrayBuffer so the body type stays honest
  const buffer = new Uint8Array(bytes.byteLength);
  buffer.set(bytes);

  return c.body(buffer.buffer, 200, {
    "content-type": mime,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
};

// The report surface: one row and one docx per generated document. The app
// lists them, the browser editor opens and saves one.
export const reportRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  // 404 beats a foreign-key error later, and the list is per project
  const requireProject = async (projectId: number) => {
    const project = await getProjectById(projectId, database);
    if (!project) {
      throw new AppError(404, "project_not_found", `No project with id ${projectId}`);
    }
    return project;
  };

  // read the upload, then check it is a docx before it reaches storage
  const readDocxBody = async (c: Context) => {
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

    return body;
  };

  // Generate: the row lands now, the docx lands when the render finishes.
  routes.post("/api/v1/projects/:projectId/reports", async (c) => {
    const projectId = parseId(c, "projectId");
    await requireProject(projectId);

    const { name, scope } = await parseBody(c, reportCreateSchema);
    const report = await queueReportGeneration(projectId, name, scope ?? "all", database);

    return ok(c, reportListItem(report), 202);
  });

  routes.get("/api/v1/projects/:projectId/reports", async (c) => {
    const projectId = parseId(c, "projectId");
    await requireProject(projectId);

    return ok(c, await listProjectReports(projectId, database));
  });

  // the editor page reads this for the document name and state
  routes.get("/api/v1/reports/:reportId", async (c) => {
    const reportId = parseUuid(c, "reportId");

    return ok(c, await getReportStatus(reportId, database));
  });

  // the stored document; the editor fetches it and the download link points here
  routes.get("/api/v1/reports/:reportId/docx", async (c) => {
    const reportId = parseUuid(c, "reportId");

    const status = await getReportStatus(reportId, database);
    if (status.status === "generating") {
      throw new AppError(409, "report_not_ready", "The report is still generating");
    }

    const docx = new Uint8Array(await loadReportDocx(reportId, database));
    return attachmentResponse(
      c,
      docx,
      attachmentFilename(status.name, reportId, "docx"),
      DOCX_MIME,
    );
  });

  // The printable copy of the same stored document, rendered off-process. The
  // editor has no exporter, so this is where a PDF comes from.
  routes.get("/api/v1/reports/:reportId/pdf", async (c) => {
    const reportId = parseUuid(c, "reportId");

    const status = await getReportStatus(reportId, database);
    if (status.status === "generating") {
      throw new AppError(409, "report_not_ready", "The report is still generating");
    }

    const pdf = await convertDocxToPdf(new Uint8Array(await loadReportDocx(reportId, database)));
    return attachmentResponse(c, pdf, attachmentFilename(status.name, reportId, "pdf"), PDF_MIME);
  });

  // the browser editor's save path. The version the editor loaded travels in a
  // header, because the body is the document itself.
  routes.put("/api/v1/reports/:reportId/docx", async (c) => {
    const reportId = parseUuid(c, "reportId");
    const header = c.req.header(VERSION_HEADER);
    const body = await readDocxBody(c);

    const written = await saveReportDocx(reportId, body, parseVersion(header), database);

    return ok(c, written);
  });

  // Rewrite the generated regions from current data. The user's own edits sit
  // outside every region, so they survive.
  routes.post("/api/v1/reports/:reportId/refresh", async (c) => {
    const reportId = parseUuid(c, "reportId");

    return ok(c, await refreshReport(reportId, database));
  });

  routes.patch("/api/v1/reports/:reportId", async (c) => {
    const reportId = parseUuid(c, "reportId");
    const { name } = await parseBody(c, reportNameSchema);

    return ok(c, await renameReport(reportId, name, database));
  });

  routes.delete("/api/v1/reports/:reportId", async (c) => {
    const reportId = parseUuid(c, "reportId");
    await removeReport(reportId, database);

    return ok(c, { reportId });
  });

  return routes;
};
