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
  saveReportDocx,
} from "../../db/services/report.service";
import { AppError } from "../../lib/error";
import { parseBody, parseId, parseUuid } from "../../lib/parse";
import { ok } from "../../lib/response";
import { reportNameSchema } from "../../types/api";
import { queueReportGeneration } from "./generate";

// A docx is a zip, and the editor refuses anything else — so does this.
const isZip = (bytes: Uint8Array): boolean => bytes[0] === 0x50 && bytes[1] === 0x4b;

// The name is user text, so anything outside a safe set drops out. A quote or a
// newline in a header splits the response.
const docxFilename = (name: string, reportId: string) => {
  const safe = name.replace(/[^A-Za-z0-9 ._-]/g, "").trim();
  return `${safe || `report-${reportId}`}.docx`;
};

const docxResponse = (c: Context, bytes: Uint8Array, filename: string) => {
  // copy into an exactly-sized ArrayBuffer so the body type stays honest
  const buffer = new Uint8Array(bytes.byteLength);
  buffer.set(bytes);

  return c.body(buffer.buffer, 200, {
    "content-type": DOCX_MIME,
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

    const { name } = await parseBody(c, reportNameSchema);
    const report = await queueReportGeneration(projectId, name, database);

    return ok(
      c,
      { reportId: report.reportId, name: report.name, status: report.status },
      202,
    );
  });

  routes.get("/api/v1/projects/:projectId/reports", async (c) => {
    const projectId = parseId(c, "projectId");
    await requireProject(projectId);

    return ok(c, { reports: await listProjectReports(projectId, database) });
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
    return docxResponse(c, docx, docxFilename(status.name, reportId));
  });

  // the browser editor's save path
  routes.put("/api/v1/reports/:reportId/docx", async (c) => {
    const reportId = parseUuid(c, "reportId");
    const body = await readDocxBody(c);

    await saveReportDocx(reportId, body, database);

    return ok(c, { reportId });
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
