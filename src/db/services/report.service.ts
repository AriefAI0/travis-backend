import { randomUUID } from "node:crypto";

import { db, type DbOrTx } from "../client";
import { env } from "../../config/env";
import type { Caller } from "../../lib/caller";
import { AppError } from "../../lib/error";
import { log } from "../../lib/logger";
import { minio } from "../../lib/minio_storage/clients";
import { ensureDefaultOrganization } from "../ensure-org";
import { writeAudit } from "./audit.service";
import {
  claimReportDocxWrite,
  deleteReportRecord,
  failStaleGeneratingReports,
  findReportRecord,
  insertReportRecord,
  listReportRecords,
  updateReportRecord,
  type ReportRow,
} from "../repositories/report.repository";
import type { ReportListItem, ReportScope, ReportStatus } from "../../types/api";

// A write with no actor: the background render, which the user's own create
// already recorded. Only a human action writes an audit row.
export const systemCaller = (organizationId: number): Caller => ({
  userId: null,
  organizationId,
});

// The audit row for a report write. A background write has no actor, so it
// writes none — the create that started the render is already on the record.
const auditReport = async (
  caller: Caller,
  action: "create" | "modify" | "remove",
  row: ReportRow,
  before: unknown,
  tx: DbOrTx,
) => {
  if (caller.userId === null) return;

  await writeAudit(
    {
      organizationId: caller.organizationId,
      userId: caller.userId,
      action,
      resourceType: "Report",
      resourceId: row.reportId,
      before,
      after: action === "remove" ? undefined : row,
    },
    tx,
  );
};

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// One object per report. The key is stored on the row, so a later key scheme
// keeps old rows readable.
export const reportDocxKey = (reportId: string) => `reports/${reportId}.docx`;

// A render cut short by a restart leaves `generating` behind forever, and the
// dialog polls that row until it changes.
const STUCK_AFTER_MS = 10 * 60_000;

// Every row belongs to the seeded default org until the report routes take the
// caller's org instead. Memoized: the boot seed makes it stable.
// ponytail: drop the memo once the routes pass their own organizationId.
let cachedOrgId: number | null = null;

export const defaultOrgId = async (database?: DbOrTx): Promise<number> => {
  if (cachedOrgId !== null) return cachedOrgId;

  const org = await ensureDefaultOrganization(database);
  if (!org) {
    throw new AppError(500, "org_missing", "No default organization row");
  }

  cachedOrgId = org.organizationId;
  return cachedOrgId;
};

// The app-facing row shape. `createReport` hands back a row, not a list item,
// so the route maps it here rather than reading the row twice.
export const reportListItem = (row: ReportRow): ReportListItem => ({
  reportId: row.reportId,
  name: row.name,
  status: row.status as ReportStatus,
  scope: row.scope as ReportScope,
  errorDetail: row.errorDetail,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

// Drain a MinIO object stream into one Buffer.
const drainStream = async (stream: AsyncIterable<Buffer | Uint8Array>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

// A row for a document that does not exist yet: the docx lands after the render,
// so status starts at `generating`. The id is minted here rather than by the
// column default, so the storage key is known before the insert. `scope` is
// frozen on the row, so a later refresh re-renders the same report type.
export const createReport = async (
  projectId: number,
  name: string,
  scope: ReportScope = "all",
  caller: Caller,
  database?: DbOrTx,
): Promise<ReportRow> => {
  const reportId = randomUUID();

  const insert = async (tx: DbOrTx) => {
    const row = await insertReportRecord(
      {
        reportId,
        organizationId: caller.organizationId,
        projectId,
        name: name.trim(),
        scope,
        minioKey: reportDocxKey(reportId),
      },
      tx,
    );

    if (!row) {
      throw new AppError(500, "report_create_failed", "Report insert returned no row");
    }

    await auditReport(caller, "create", row, undefined, tx);
    return row;
  };

  return database ? insert(database) : db.transaction(insert);
};

// flow: caller's org > list rows > app shape
export const listProjectReports = async (
  projectId: number,
  caller: Caller,
  database?: DbOrTx,
): Promise<ReportListItem[]> => {
  const rows = await listReportRecords(caller.organizationId, projectId, database);

  return rows.map(reportListItem);
};

// The row, org-checked. Callers that only need existence use it as the guard.
export const getReport = async (
  reportId: string,
  caller: Caller,
  database?: DbOrTx,
): Promise<ReportRow> => {
  const row = await findReportRecord(caller.organizationId, reportId, database);

  if (!row) {
    throw new AppError(404, "report_not_found", `No report with id ${reportId}`);
  }

  return row;
};

export const getReportStatus = async (
  reportId: string,
  caller: Caller,
  database?: DbOrTx,
): Promise<ReportListItem> => reportListItem(await getReport(reportId, caller, database));

// The stored document. The row decides the key, so a moved object still loads.
// flow: row guard > object read > 404 on a miss
export const loadReportDocx = async (
  reportId: string,
  caller: Caller,
  database?: DbOrTx,
): Promise<Buffer> => {
  const row = await getReport(reportId, caller, database);

  try {
    return await drainStream(await minio.getObject(env.BUCKET_MEDIA, row.minioKey));
  } catch {
    throw new AppError(404, "report_docx_missing", `Report ${reportId} stores no document`);
  }
};

// What a document write did, so the caller can hand the new version back.
export type DocxWrite = { reportId: string; version: number };

// Write the stored document, but only at the version the caller loaded.
//
// A refresh writes this row too, so without the guard an editor tab opened
// before a refresh would save its own copy over the refreshed one and undo the
// refresh with no error anywhere.
//
// The version is claimed before the object write on purpose: a claim that
// succeeds and an upload that fails leaves the version ahead, which the user
// fixes by reloading. The other order would upload first and only then discover
// the write was stale, which is the overwrite this exists to stop.
// flow: row guard > 428 without a version > claim version > upload object
export const saveReportDocx = async (
  reportId: string,
  bytes: Uint8Array,
  expectedVersion: number | null,
  caller: Caller,
  database?: DbOrTx,
): Promise<DocxWrite> => {
  const row = await getReport(reportId, caller, database);

  if (expectedVersion === null) {
    throw new AppError(
      428,
      "version_required",
      "This page carries no report version. Reload the report and save again",
    );
  }

  // The claim and its audit row land together, the object write after: a claim
  // that commits and an upload that fails leaves the version ahead, which the
  // user fixes by reloading.
  const claim = async (tx: DbOrTx) => {
    const claimed = await claimReportDocxWrite(
      caller.organizationId,
      reportId,
      expectedVersion,
      tx,
    );
    if (!claimed) return null;

    await auditReport(caller, "modify", { ...row, version: claimed.version }, row, tx);
    return claimed;
  };

  const claimed = database ? await claim(database) : await db.transaction(claim);
  if (!claimed) {
    const current = await getReport(reportId, caller, database);
    throw new AppError(
      409,
      "report_changed",
      `Report ${reportId} is at version ${current.version}, not ${expectedVersion}. Reload before saving`,
    );
  }

  // the minio client takes a Buffer, not a view
  const body = Buffer.from(bytes);
  await minio.putObject(env.BUCKET_MEDIA, row.minioKey, body, body.byteLength, {
    "Content-Type": DOCX_MIME,
  });

  return { reportId, version: claimed.version };
};

export const renameReport = async (
  reportId: string,
  name: string,
  caller: Caller,
  database?: DbOrTx,
): Promise<ReportListItem> => {
  const before = await getReport(reportId, caller, database);

  const rename = async (tx: DbOrTx) => {
    const row = await updateReportRecord(
      caller.organizationId,
      reportId,
      { name: name.trim() },
      tx,
    );

    if (!row) {
      throw new AppError(404, "report_not_found", `No report with id ${reportId}`);
    }

    await auditReport(caller, "modify", row, before, tx);
    return row;
  };

  return reportListItem(database ? await rename(database) : await db.transaction(rename));
};

// flow: drop the row and audit it > best-effort object removal. A row without
// its object is invisible; an orphan object costs storage only.
export const removeReport = async (
  reportId: string,
  caller: Caller,
  database?: DbOrTx,
): Promise<void> => {
  const remove = async (tx: DbOrTx) => {
    const row = await deleteReportRecord(caller.organizationId, reportId, tx);

    if (!row) {
      throw new AppError(404, "report_not_found", `No report with id ${reportId}`);
    }

    await auditReport(caller, "remove", row, row, tx);
    return row;
  };

  const row = database ? await remove(database) : await db.transaction(remove);

  // the sweep stays outside the transaction
  try {
    await minio.removeObject(env.BUCKET_MEDIA, row.minioKey);
  } catch {
    log.warn("report object left behind", { reportId, key: row.minioKey });
  }
};

// Status is the only field the background render writes. It has no actor, so
// it writes no audit row — the create that queued it is already recorded.
export const setReportStatus = async (
  reportId: string,
  status: ReportStatus,
  errorDetail: string | null,
  database?: DbOrTx,
): Promise<void> => {
  const organizationId = await defaultOrgId(database);

  await updateReportRecord(organizationId, reportId, { status, errorDetail }, database);
};

// Boot sweep for rows a restart left in `generating`.
export const failInterruptedReports = async (database?: DbOrTx): Promise<number> => {
  const count = await failStaleGeneratingReports(new Date(Date.now() - STUCK_AFTER_MS), database);

  if (count) log.warn("failed interrupted reports", { count });
  return count;
};
