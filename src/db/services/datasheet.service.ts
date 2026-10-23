// Stored datasheets: the row, its two objects, and their lifecycle.
//
// The row exists before any bytes do, so a failed render still leaves the user
// something to see, retry, or delete.
// flow: create (generating) > render docx > convert pdf > ready
import { randomUUID } from "node:crypto";

import { db, type DbOrTx } from "../client";
import { env } from "../../config/env";
import type { Caller } from "../../lib/caller";
import { AppError } from "../../lib/error";
import { log } from "../../lib/logger";
import { minio } from "../../lib/minio_storage/clients";
import { writeAudit } from "./audit.service";
import {
  deleteDatasheetRecord,
  failStaleGeneratingDatasheets,
  findDatasheetRecord,
  insertDatasheetRecord,
  listDatasheetRecords,
  updateDatasheetRecord,
  type DatasheetRow,
} from "../repositories/datasheet.repository";
import { DOCX_MIME } from "./report.service";
import type { DatasheetKind, DatasheetListItem, DatasheetStatus } from "../../types/api";

export const PDF_MIME = "application/pdf";

// One key per artefact. The key is stored on the row, so a later scheme keeps
// old rows readable.
export const datasheetDocxKey = (datasheetId: string) => `datasheets/${datasheetId}.docx`;
export const datasheetPdfKey = (datasheetId: string) => `datasheets/${datasheetId}.pdf`;

// A render cut short by a restart leaves `generating` behind forever.
const STUCK_AFTER_MS = 10 * 60_000;

// Card label used in the row name and the download file name.
const KIND_LABEL: Record<DatasheetKind, string> = {
  GVI: "GVI",
  CP_ANODE: "CP-ANODE",
  CP_MEMBER: "CP-MEMBER",
  FMD: "FMD",
  SCOUR: "SCOUR",
  DVI: "DVI",
};

// `GVI 2026-10-22`: the kind and the day, which is what a user calls one.
export const defaultDatasheetName = (kind: DatasheetKind, day = new Date()) =>
  `${KIND_LABEL[kind]} ${day.toISOString().slice(0, 10)}`;

// `gvi_2026-10-22.docx`: the row name, safe as a file name.
export const datasheetFilename = (row: DatasheetRow, extension: "docx" | "pdf") =>
  `${row.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}.${extension}`;

export const datasheetListItem = (row: DatasheetRow): DatasheetListItem => ({
  datasheetId: row.datasheetId,
  name: row.name,
  kind: row.kind as DatasheetKind,
  status: row.status as DatasheetStatus,
  errorDetail: row.errorDetail,
  pdfError: row.pdfError,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

// The audit row for a datasheet write. A background write has no actor, so it
// writes none — the create that started the render is already on the record.
const auditDatasheet = async (
  caller: Caller,
  action: "create" | "modify" | "remove",
  row: DatasheetRow,
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
      resourceId: row.datasheetId,
      before,
      after: action === "remove" ? undefined : row,
    },
    tx,
  );
};

// Drain a MinIO object stream into one Buffer.
const drainStream = async (stream: AsyncIterable<Buffer | Uint8Array>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

// flow: mint id > insert generating > audit
export const createDatasheet = async (
  projectId: number,
  kind: DatasheetKind,
  targets: string[],
  name: string,
  caller: Caller,
  database?: DbOrTx,
): Promise<DatasheetRow> => {
  const datasheetId = randomUUID();

  const insert = async (tx: DbOrTx) => {
    const row = await insertDatasheetRecord(
      {
        datasheetId,
        organizationId: caller.organizationId,
        projectId,
        kind,
        name: name.trim(),
        targets,
        docxKey: datasheetDocxKey(datasheetId),
      },
      tx,
    );

    if (!row) {
      throw new AppError(500, "datasheet_create_failed", "Datasheet insert returned no row");
    }

    await auditDatasheet(caller, "create", row, undefined, tx);
    return row;
  };

  return database ? insert(database) : db.transaction(insert);
};

export const listProjectDatasheets = async (
  projectId: number,
  caller: Caller,
  database?: DbOrTx,
): Promise<DatasheetListItem[]> => {
  const rows = await listDatasheetRecords(caller.organizationId, projectId, database);
  return rows.map(datasheetListItem);
};

// The row, org-checked. Callers that only need existence use it as the guard.
export const getDatasheet = async (
  datasheetId: string,
  caller: Caller,
  database?: DbOrTx,
): Promise<DatasheetRow> => {
  const row = await findDatasheetRecord(caller.organizationId, datasheetId, database);

  if (!row) {
    throw new AppError(404, "datasheet_not_found", `No datasheet with id ${datasheetId}`);
  }

  return row;
};

const loadObject = async (key: string, missing: AppError) => {
  try {
    return await drainStream(await minio.getObject(env.BUCKET_MEDIA, key));
  } catch {
    throw missing;
  }
};

// The stored document. The row decides the key, so a moved object still loads.
export const loadDatasheetDocx = async (
  datasheetId: string,
  caller: Caller,
  database?: DbOrTx,
): Promise<Buffer> => {
  const row = await getDatasheet(datasheetId, caller, database);

  return loadObject(
    row.docxKey,
    new AppError(404, "datasheet_docx_missing", `Datasheet ${datasheetId} stores no document`),
  );
};

// The PDF, when the conversion ran. A degraded sheet answers 409 here.
export const loadDatasheetPdf = async (
  datasheetId: string,
  caller: Caller,
  database?: DbOrTx,
): Promise<Buffer> => {
  const row = await getDatasheet(datasheetId, caller, database);

  if (!row.pdfKey) {
    throw new AppError(
      409,
      "pdf_unavailable",
      row.pdfError ?? `Datasheet ${datasheetId} has no PDF yet`,
    );
  }

  return loadObject(
    row.pdfKey,
    new AppError(404, "datasheet_pdf_missing", `Datasheet ${datasheetId} stores no PDF`),
  );
};

// Store the rendered document, then the PDF when the converter produced one.
// The status flip comes last, so a poll never sees `ready` without its bytes.
export const storeDatasheet = async (
  row: DatasheetRow,
  docx: Uint8Array,
  pdf: Buffer | null,
  pdfError: string | null,
  database?: DbOrTx,
): Promise<void> => {
  const body = Buffer.from(docx);
  await minio.putObject(env.BUCKET_MEDIA, row.docxKey, body, body.byteLength, {
    "Content-Type": DOCX_MIME,
  });

  let pdfKey: string | null = null;
  if (pdf) {
    pdfKey = datasheetPdfKey(row.datasheetId);
    await minio.putObject(env.BUCKET_MEDIA, pdfKey, pdf, pdf.byteLength, {
      "Content-Type": PDF_MIME,
    });
  }

  await updateDatasheetRecord(
    row.organizationId,
    row.datasheetId,
    { pdfKey, pdfError, status: "ready", errorDetail: null },
    database,
  );
};

// Status is the only field a failed render writes. It has no actor, so it
// writes no audit row — the create that queued it is already recorded.
export const setDatasheetStatus = async (
  organizationId: number,
  datasheetId: string,
  status: DatasheetStatus,
  errorDetail: string | null,
  database?: DbOrTx,
): Promise<void> => {
  await updateDatasheetRecord(organizationId, datasheetId, { status, errorDetail }, database);
};

// flow: drop the row and audit it > best-effort object removal. A row without
// its objects is invisible; orphan objects cost storage only.
export const removeDatasheet = async (
  datasheetId: string,
  caller: Caller,
  database?: DbOrTx,
): Promise<void> => {
  const remove = async (tx: DbOrTx) => {
    const row = await deleteDatasheetRecord(caller.organizationId, datasheetId, tx);

    if (!row) {
      throw new AppError(404, "datasheet_not_found", `No datasheet with id ${datasheetId}`);
    }

    await auditDatasheet(caller, "remove", row, row, tx);
    return row;
  };

  const row = database ? await remove(database) : await db.transaction(remove);

  for (const key of [row.docxKey, row.pdfKey]) {
    if (!key) continue;
    try {
      await minio.removeObject(env.BUCKET_MEDIA, key);
    } catch {
      log.warn("datasheet object left behind", { datasheetId, key });
    }
  }
};

// Boot sweep for rows a restart left in `generating`.
export const failInterruptedDatasheets = async (database?: DbOrTx): Promise<number> => {
  const count = await failStaleGeneratingDatasheets(new Date(Date.now() - STUCK_AFTER_MS), database);

  if (count) log.warn("failed interrupted datasheets", { count });
  return count;
};
