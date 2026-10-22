// The datasheet surface: preview a selection, generate one sheet per kind,
// list past sheets, download either artefact, delete.
//
// Every route is org-scoped through the caller, and reuses the `Report`
// permission subject: a datasheet is a report.
// flow: bearer + ability > project guard > service
import { Hono, type Context } from "hono";
import type { DbOrTx } from "../../db/client";
import { findProjectById } from "../../db/repositories/project.repository";
import {
  PDF_MIME,
  defaultDatasheetName,
  datasheetFilename,
  datasheetListItem,
  getDatasheet,
  listProjectDatasheets,
  loadDatasheetDocx,
  loadDatasheetPdf,
  removeDatasheet,
} from "../../db/services/datasheet.service";
import {
  countDatasheetResults,
  parseDatasheetTargets,
  previewDatasheet,
} from "../../db/services/datasheet-data.service";
import { DOCX_MIME } from "../../db/services/report.service";
import { callerOf, requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import type { Caller } from "../../lib/caller";
import { AppError } from "../../lib/error";
import { parseBody, parseId, parseUuid } from "../../lib/parse";
import { ok } from "../../lib/response";
import type { Action, Subject } from "../../lib/auth/permissions";
import { datasheetCreateSchema, datasheetPreviewSchema } from "../../types/api";
import { hasDatasheetTemplate, queueDatasheetGeneration } from "./generate";

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

export const datasheetRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  // A project in another org reads as absent, so the id cannot be probed.
  const requireProject = async (projectId: number, caller: Caller) => {
    const project = await findProjectById(projectId, caller.organizationId, database);
    if (!project) {
      throw new AppError(404, "project_not_found", `No project with id ${projectId}`);
    }
    return project;
  };

  // The two check middlewares only read the request and set context, so calling
  // them with a no-op next runs the check and stops there.
  const authorized = async (
    c: Context<{ Variables: AuthVariables }>,
    action: Action,
    subject: Subject,
  ): Promise<Caller> => {
    const noop = async () => {};
    await requireUser(database)(c, noop);
    await requireCan(action, subject)(c, noop);
    return callerOf(c);
  };

  // Counts for every card, plus one card's first rows when the dialog opens it.
  routes.post("/api/v1/projects/:projectId/datasheets/preview", async (c) => {
    const caller = await authorized(c, "read", "Report");
    const projectId = parseId(c, "projectId");
    await requireProject(projectId, caller);

    const { targets, kind } = await parseBody(c, datasheetPreviewSchema);
    const parsed = parseDatasheetTargets(targets);

    return ok(c, {
      counts: await countDatasheetResults(projectId, parsed, caller.organizationId, database),
      preview: kind
        ? await previewDatasheet(projectId, kind, parsed, caller.organizationId, database)
        : null,
    });
  });

  // Generate: the row lands now, the document lands when the render finishes.
  routes.post("/api/v1/projects/:projectId/datasheets", async (c) => {
    const caller = await authorized(c, "create", "Report");
    const projectId = parseId(c, "projectId");
    await requireProject(projectId, caller);

    const { kind, targets, name } = await parseBody(c, datasheetCreateSchema);
    if (!hasDatasheetTemplate(kind)) {
      throw new AppError(
        400,
        "datasheet_template_missing",
        `No datasheet template ships for ${kind}; the card stays disabled`,
      );
    }

    // the selection is validated here, so a bad key fails before the row exists
    parseDatasheetTargets(targets);

    const row = await queueDatasheetGeneration(
      projectId,
      kind,
      targets,
      name ?? defaultDatasheetName(kind),
      caller,
      database,
    );

    return ok(c, datasheetListItem(row), 202);
  });

  routes.get("/api/v1/projects/:projectId/datasheets", async (c) => {
    const caller = await authorized(c, "read", "Report");
    const projectId = parseId(c, "projectId");
    await requireProject(projectId, caller);

    return ok(c, await listProjectDatasheets(projectId, caller, database));
  });

  routes.get("/api/v1/datasheets/:datasheetId", async (c) => {
    const caller = await authorized(c, "read", "Report");
    const datasheetId = parseUuid(c, "datasheetId");

    return ok(c, datasheetListItem(await getDatasheet(datasheetId, caller, database)));
  });

  routes.get("/api/v1/datasheets/:datasheetId/docx", async (c) => {
    const caller = await authorized(c, "read", "Report");
    const datasheetId = parseUuid(c, "datasheetId");

    const row = await getDatasheet(datasheetId, caller, database);
    if (row.status === "generating") {
      throw new AppError(409, "datasheet_not_ready", "The datasheet is still generating");
    }

    const docx = new Uint8Array(await loadDatasheetDocx(datasheetId, caller, database));
    return attachmentResponse(c, docx, datasheetFilename(row, "docx"), DOCX_MIME);
  });

  // A sheet whose PDF conversion failed answers 409 with the converter's reason.
  routes.get("/api/v1/datasheets/:datasheetId/pdf", async (c) => {
    const caller = await authorized(c, "read", "Report");
    const datasheetId = parseUuid(c, "datasheetId");

    const row = await getDatasheet(datasheetId, caller, database);
    if (row.status === "generating") {
      throw new AppError(409, "datasheet_not_ready", "The datasheet is still generating");
    }

    const pdf = new Uint8Array(await loadDatasheetPdf(datasheetId, caller, database));
    return attachmentResponse(c, pdf, datasheetFilename(row, "pdf"), PDF_MIME);
  });

  routes.delete("/api/v1/datasheets/:datasheetId", async (c) => {
    const caller = await authorized(c, "remove", "Report");
    const datasheetId = parseUuid(c, "datasheetId");
    await removeDatasheet(datasheetId, caller, database);

    return ok(c, { datasheetId });
  });

  return routes;
};
