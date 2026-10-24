// The excel export surface: preview a selection, queue an export, list, read,
// cancel, remove, and mint the download link.
//
// Every route is org-scoped through the caller and reuses the `Report`
// permission subject: an export is a report artifact.
// flow: bearer + ability > project guard > service > ok
import { Hono, type Context } from "hono";

import type { DbOrTx } from "../../db/client";
import { findProjectById } from "../../db/repositories/project.repository";
import { parseDatasheetTargets } from "../../db/services/datasheet-data.service";
import {
  countExcelResults,
  previewExcelExport,
} from "../../db/services/excel-export-data.service";
import {
  cancelExcelExport,
  createExcelExport,
  getExcelExport,
  listExcelExports,
  removeExcelExport,
} from "../../db/services/excel-export.service";
import { callerOf, requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import type { Caller } from "../../lib/caller";
import { publish } from "../../lib/events/bus";
import { AppError } from "../../lib/error";
import { env } from "../../config/env";
import { log } from "../../lib/logger";
import { mintDownloadUrl } from "../../lib/minio_storage/mint";
import { parseBody, parseId, parseUuid } from "../../lib/parse";
import { ok } from "../../lib/response";
import type { Action, Subject } from "../../lib/auth/permissions";
import { excelCreateSchema, excelPreviewSchema, type ExcelExportListItem } from "../../types/api";
import { EXPORT_TTL_MS } from "../../db/services/excel-export.service";
import { estimateExportSizes } from "./estimate";
import { bareWorkbook, exportFilename, shippedStem, typeFilename } from "./workbook";
import { kickExcelExportWorker } from "./worker";

const toListItem = (row: Awaited<ReturnType<typeof getExcelExport>>): ExcelExportListItem => ({
  id: row.id,
  projectId: row.projectId,
  types: row.types,
  media: row.media,
  name: row.name,
  status: row.status,
  phase: row.phase,
  itemsTotal: row.itemsTotal,
  itemsDone: row.itemsDone,
  packageSize: row.packageSize,
  errors: row.errors,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const excelExportRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  // A project in another org reads as absent, so the id cannot be probed.
  const requireProject = async (projectId: number, caller: Caller) => {
    const project = await findProjectById(projectId, caller.organizationId, database);
    if (!project) {
      throw new AppError(404, "project_not_found", `No project with id ${projectId}`);
    }
    return project;
  };

  // The check middlewares only read the request and set context, so calling
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

  // An export is owner-scoped: the caller's own id is the only owner it reads.
  const callerKey = (caller: Caller) => {
    if (!caller.userId) throw new AppError(401, "unauthenticated", "A signed-in caller is required");
    return caller.userId;
  };

  // Counts per type, ten-row previews, and the size of each media level.
  routes.post("/api/v1/projects/:projectId/excel-exports/preview", async (c) => {
    const caller = await authorized(c, "read", "Report");
    const projectId = parseId(c, "projectId");
    await requireProject(projectId, caller);

    const { types, targets } = await parseBody(c, excelPreviewSchema);
    const parsed = parseDatasheetTargets(targets);

    const [counts, preview] = await Promise.all([
      countExcelResults(projectId, parsed, caller.organizationId, database),
      previewExcelExport(projectId, types, parsed, caller.organizationId, database),
    ]);

    // real numbers: cached clip sizes, sampled image bytes, rows x fixed cost
    const estimates = await estimateExportSizes(projectId, parsed, caller.organizationId, database);

    return ok(c, { counts, preview, estimates });
  });

  // Queue the export: the row lands now, the package lands when a lane runs it.
  routes.post("/api/v1/projects/:projectId/excel-exports", async (c) => {
    const caller = await authorized(c, "create", "Report");
    const projectId = parseId(c, "projectId");
    await requireProject(projectId, caller);

    const { types, targets, media, name } = await parseBody(c, excelCreateSchema);
    // the selection is validated here, so a bad key fails before the row exists
    parseDatasheetTargets(targets);

    const row = await createExcelExport(
      { projectId, types, targets, media, name },
      caller.organizationId,
      callerKey(caller),
      database,
    );

    // a row that was already live is returned as is; only a new one wakes a lane
    if (row.status === "queued") kickExcelExportWorker();

    // the bell hears about the row now, not only when a lane first moves it
    publish({
      organizationId: row.organizationId,
      action: "create",
      resourceType: "ExcelExport",
      resourceId: row.id,
      userId: row.ownerUserId,
    });

    return ok(c, toListItem(row), 202);
  });

  routes.get("/api/v1/excel-exports", async (c) => {
    const caller = await authorized(c, "read", "Report");
    const rows = await listExcelExports(caller.organizationId, callerKey(caller), database);
    return ok(c, rows.map(toListItem));
  });

  routes.get("/api/v1/excel-exports/:id", async (c) => {
    const caller = await authorized(c, "read", "Report");
    const id = parseUuid(c, "id");
    return ok(c, toListItem(await getExcelExport(id, caller.organizationId, callerKey(caller), database)));
  });

  routes.post("/api/v1/excel-exports/:id/cancel", async (c) => {
    const caller = await authorized(c, "modify", "Report");
    const id = parseUuid(c, "id");
    return ok(c, toListItem(await cancelExcelExport(id, caller.organizationId, callerKey(caller), database)));
  });

  routes.delete("/api/v1/excel-exports/:id", async (c) => {
    const caller = await authorized(c, "remove", "Report");
    const id = parseUuid(c, "id");
    await removeExcelExport(id, caller.organizationId, callerKey(caller), database);
    return ok(c, { id });
  });

  // A presigned link, never a streaming route: the bytes leave MinIO directly.
  routes.get("/api/v1/excel-exports/:id/download-url", async (c) => {
    const caller = await authorized(c, "read", "Report");
    const id = parseUuid(c, "id");
    const row = await getExcelExport(id, caller.organizationId, callerKey(caller), database);

    if (!row.packageKey) {
      throw new AppError(409, "export_not_ready", "The export has no package yet");
    }
    if (row.status !== "ready" && row.status !== "ready_with_errors") {
      throw new AppError(409, "export_not_ready", `The export is ${row.status}`);
    }

    // never outlive the package
    const remaining = row.expiresAt
      ? Math.floor((row.expiresAt.getTime() - Date.now()) / 1000)
      : EXPORT_TTL_MS / 1000;
    const ttl = Math.min(env.PRESIGN_GET_TTL_SECONDS, remaining);
    if (ttl < 1) {
      throw new AppError(410, "export_expired", "The package has expired; export again");
    }

    const project = await findProjectById(row.projectId, caller.organizationId, database);
    // a typed name always ships inside a zip folder. Only an unnamed raw
    // export with at most one sheet opens straight from the download.
    const counts = await countExcelResults(
      row.projectId,
      parseDatasheetTargets(row.targets),
      caller.organizationId,
      database,
    );
    const typesWithRows = (row.types as string[]).filter((type) => (counts[type] ?? 0) > 0);
    const bare = bareWorkbook(row.name, typesWithRows.length);
    // a bare workbook leads with its type and the build time. A zero-row
    // export falls back to the first requested type, never a made-up one.
    const bareType = typesWithRows[0] ?? (row.types as string[])[0] ?? "export";
    // a typed name names the zip and its root; a blank one keeps the project
    // and the day
    const filename = bare
      ? typeFilename(bareType, row.createdAt)
      : exportFilename(
          shippedStem(row.name, project?.title ?? "export", row.createdAt),
          "zip",
        );
    const url = await mintDownloadUrl(env.BUCKET_MEDIA, row.packageKey, filename, ttl);

    log.debug("excel export download url minted", { id: row.id, ttl });
    return ok(c, { url, filename, expiresInSeconds: ttl });
  });

  return routes;
};
