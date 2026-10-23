// Lifecycle of one excel export: create, read, cancel, remove, recover.
//
// Create dedupes on a request hash and caps the owner's live exports. Every
// later move is a compare-and-set, so a cancel racing a finish leaves exactly
// one terminal status.
// flow: validate project > hash > tx(lock > dedupe > cap > insert)

import { createHash } from "node:crypto";

import { db, type DbOrTx } from "../client";
import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { log } from "../../lib/logger";
import { minio } from "../../lib/minio_storage/clients";
import type { InspectionTypeCode } from "../../types/api";
import {
  ACTIVE_STATUSES,
  cancelCancellingExcelExports,
  claimQueuedExcelExport,
  countActiveExcelExports,
  createExcelExportRecord,
  expireExcelExports,
  findActiveExcelExportRecord,
  findExcelExportRecord,
  listExcelExportRecordsByOwner,
  lockExcelExportOwner,
  removeExcelExportRecord,
  requeueRunningExcelExports,
  updateExcelExportRecord,
  type ExcelExportRow,
} from "../repositories/excel-export.repository";
import { getProjectById } from "./project.service";

// One owner holds this many live exports. The sixth answers 429.
export const MAX_ACTIVE_EXPORTS = 5;

// A package lives a week, then the sweep removes it.
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ExcelMediaLevel = "raw" | "images" | "clips";

export type ExcelExportRequest = {
  projectId: number;
  types: InspectionTypeCode[];
  targets: string[];
  media: ExcelMediaLevel;
};

export type ExcelExportView = ExcelExportRow;

// media decides the lane: only a clip merge waits for ffmpeg
export const laneFor = (media: ExcelMediaLevel): "light" | "clips" =>
  media === "clips" ? "clips" : "light";

// The request identity: same project, media, and selection is the same export.
export const requestHashOf = (input: ExcelExportRequest) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        projectId: input.projectId,
        media: input.media,
        types: [...input.types].sort(),
        targets: [...input.targets].sort(),
      }),
    )
    .digest("hex");

const notFound = () => new AppError(404, "export_not_found", "No export with that id");

// Create or return the live export for this exact request.
export const createExcelExport = async (
  input: ExcelExportRequest,
  organizationId: number,
  ownerUserId: string,
  database?: DbOrTx,
): Promise<ExcelExportView> => {
  const project = await getProjectById(input.projectId, { organizationId, userId: null }, database);
  if (!project) {
    throw new AppError(404, "project_not_found", `No project with id ${input.projectId}`);
  }

  const requestHash = requestHashOf(input);
  const lane = laneFor(input.media);

  const run = async (tx: DbOrTx): Promise<ExcelExportView> => {
    // one create at a time per owner, so the cap cannot be overshot
    await lockExcelExportOwner(ownerUserId, tx);

    const existing = await findActiveExcelExportRecord(ownerUserId, requestHash, tx);
    if (existing) return existing;

    if ((await countActiveExcelExports(ownerUserId, tx)) >= MAX_ACTIVE_EXPORTS) {
      throw new AppError(
        429,
        "export_limit",
        `${MAX_ACTIVE_EXPORTS} exports are still running; finish or cancel one first`,
      );
    }

    const created = await createExcelExportRecord(
      {
        organizationId,
        projectId: input.projectId,
        ownerUserId,
        types: input.types,
        targets: input.targets,
        media: input.media,
        lane,
        requestHash,
        expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
      },
      tx,
    );

    // a parallel create with the same hash won the insert; hand back its row
    if (!created) {
      const raced = await findActiveExcelExportRecord(ownerUserId, requestHash, tx);
      if (!raced) throw new AppError(409, "export_conflict", "Export changed during create");
      return raced;
    }

    return created;
  };

  return database ? run(database) : db.transaction(run);
};

// One owner's exports, newest first. The org check runs first.
export const listExcelExports = async (
  organizationId: number,
  ownerUserId: string,
  database?: DbOrTx,
) => listExcelExportRecordsByOwner(organizationId, ownerUserId, database);

// A row outside the caller's org or ownership reads as missing.
export const getExcelExport = async (
  id: string,
  organizationId: number,
  ownerUserId: string,
  database?: DbOrTx,
): Promise<ExcelExportView> => {
  const row = await findExcelExportRecord(id, database);
  if (!row || row.organizationId !== organizationId || row.ownerUserId !== ownerUserId) {
    throw notFound();
  }
  return row;
};

// queued stops at once; running is asked to stop at its next checkpoint.
export const cancelExcelExport = async (
  id: string,
  organizationId: number,
  ownerUserId: string,
  database?: DbOrTx,
): Promise<ExcelExportView> => {
  const row = await getExcelExport(id, organizationId, ownerUserId, database);

  if (row.status === "queued") {
    await updateExcelExportRecord(id, "queued", { status: "cancelled" }, database);
  } else if (row.status === "running") {
    await updateExcelExportRecord(id, "running", { status: "cancelling" }, database);
  }

  return getExcelExport(id, organizationId, ownerUserId, database);
};

// Only a finished export can be removed; a live one answers 409. The package
// goes first, so a row never outlives the object a download link points at.
export const removeExcelExport = async (
  id: string,
  organizationId: number,
  ownerUserId: string,
  database?: DbOrTx,
): Promise<ExcelExportRow> => {
  const row = await getExcelExport(id, organizationId, ownerUserId, database);
  if ((ACTIVE_STATUSES as readonly string[]).includes(row.status)) {
    throw new AppError(409, "export_active", "Cancel the export before removing it");
  }

  if (row.packageKey) {
    await minio.removeObject(env.BUCKET_MEDIA, row.packageKey).catch((error) => {
      log.warn("excel export package remove failed", { key: row.packageKey, err: String(error) });
    });
  }

  await removeExcelExportRecord(id, database);
  return row;
};

/* ---------- worker moves ---------- */

// Claim the oldest queued row of one lane. The package key is set here, before
// any upload, so an abort knows what to remove.
export const claimExcelExport = (lane: "light" | "clips", packageKey: string, database?: DbOrTx) =>
  claimQueuedExcelExport(lane, packageKey, database);

// Move a row on, only from the status the caller still believes it holds.
export const moveExcelExport = (
  id: string,
  from: ExcelExportRow["status"],
  patch: Parameters<typeof updateExcelExportRecord>[2],
  database?: DbOrTx,
) => updateExcelExportRecord(id, from, patch, database);

// Boot: requeue what a dead worker left running, and finish stale cancels.
export const recoverExcelExports = async (database?: DbOrTx) => {
  const requeued = await requeueRunningExcelExports(database);
  const cancelled = await cancelCancellingExcelExports(database);
  return { requeued, cancelled };
};

// Retention: move expired rows off the listing and hand back their keys.
export const sweepExcelExports = (database?: DbOrTx) => expireExcelExports(database);
