// Data access for the excel export job. Every status write is a compare-and-set
// on the expected status, so a cancel and a finish cannot both win.

import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { excelExport } from "../schema";

export type ExcelExportRow = typeof excelExport.$inferSelect;
export type ExcelExportInsert = typeof excelExport.$inferInsert;

// the statuses a row can hold while its package is not final
export const ACTIVE_STATUSES = ["queued", "running", "cancelling"] as const;

export const createExcelExportRecord = async (values: ExcelExportInsert, database: DbOrTx = db) =>
  (await database.insert(excelExport).values(values).onConflictDoNothing().returning())[0] ?? null;

export const findExcelExportRecord = async (id: string, database: DbOrTx = db) =>
  (await database.select().from(excelExport).where(eq(excelExport.id, id)).limit(1))[0] ?? null;

// the same request, if it is still live
export const findActiveExcelExportRecord = async (
  ownerUserId: string,
  requestHash: string,
  database: DbOrTx = db,
) =>
  (await database
    .select()
    .from(excelExport)
    .where(
      and(
        eq(excelExport.ownerUserId, ownerUserId),
        eq(excelExport.requestHash, requestHash),
        inArray(excelExport.status, [...ACTIVE_STATUSES]),
      ),
    )
    .limit(1))[0] ?? null;

export const countActiveExcelExports = async (ownerUserId: string, database: DbOrTx = db) =>
  Number(
    (
      await database
        .select({ count: sql<number>`count(*)::int` })
        .from(excelExport)
        .where(
          and(
            eq(excelExport.ownerUserId, ownerUserId),
            inArray(excelExport.status, [...ACTIVE_STATUSES]),
          ),
        )
    )[0]?.count ?? 0,
  );

// one owner's create calls queue behind this, so the cap holds under a race
export const lockExcelExportOwner = async (ownerUserId: string, database: DbOrTx) => {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerUserId}))`);
};

export const listExcelExportRecordsByOwner = async (
  organizationId: number,
  ownerUserId: string,
  database: DbOrTx = db,
) =>
  database
    .select()
    .from(excelExport)
    .where(
      and(eq(excelExport.organizationId, organizationId), eq(excelExport.ownerUserId, ownerUserId)),
    )
    .orderBy(desc(excelExport.createdAt));

// Oldest queued row of one lane. The inner lock keeps two workers off the same
// row, and returning through drizzle keeps the row's column names typed.
export const claimQueuedExcelExport = async (
  lane: "light" | "clips",
  packageKey: string,
  database: DbOrTx = db,
) =>
  (await database
    .update(excelExport)
    .set({
      status: "running",
      packageKey,
      // a fresh attempt starts from a clean progress state
      phase: "",
      itemsTotal: 0,
      itemsDone: 0,
      attempts: sql`${excelExport.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      sql`${excelExport.id} = (
        select id from ${excelExport}
         where ${excelExport.lane} = ${lane} and ${excelExport.status} = 'queued'
         order by ${excelExport.createdAt} asc
         limit 1
         for update skip locked
      )`,
    )
    .returning())[0] ?? null;

// Compare-and-set. False means someone else moved the row, so the caller must
// re-read before deciding what to do.
export const updateExcelExportRecord = async (
  id: string,
  expectedStatus: ExcelExportRow["status"],
  patch: Partial<ExcelExportInsert>,
  database: DbOrTx = db,
) =>
  (
    await database
      .update(excelExport)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(excelExport.id, id), eq(excelExport.status, expectedStatus)))
      .returning({ id: excelExport.id })
  ).length > 0;

export const removeExcelExportRecord = async (id: string, database: DbOrTx = db) =>
  database.delete(excelExport).where(eq(excelExport.id, id));

// Boot: a running row lost its worker. Fourth attempt ends failed.
export const requeueRunningExcelExports = async (database: DbOrTx = db) => {
  const result = await database.execute(sql`
    update excel_export
       set status = case when attempts >= 3 then 'failed'::excel_export_status else 'queued'::excel_export_status end,
           updated_at = now()
     where status = 'running'
    returning id
  `);
  return result.rows.length;
};

// Boot: a cancelling row lost the worker that would have finished the cancel.
export const cancelCancellingExcelExports = async (database: DbOrTx = db) => {
  const result = await database.execute(sql`
    update excel_export
       set status = 'cancelled',
           updated_at = now()
     where status = 'cancelling'
    returning id
  `);
  return result.rows.length;
};

// Retention: a package past its expiry leaves the listing, then MinIO drops it.
export const expireExcelExports = async (database: DbOrTx = db) =>
  database
    .update(excelExport)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        inArray(excelExport.status, ["ready", "ready_with_errors"]),
        isNotNull(excelExport.expiresAt),
        lt(excelExport.expiresAt, new Date()),
      ),
    )
    .returning({ id: excelExport.id, packageKey: excelExport.packageKey });

// Oldest queued row, for a listing that shows position.
export const listQueuedExcelExportIds = async (lane: "light" | "clips", database: DbOrTx = db) =>
  database
    .select({ id: excelExport.id })
    .from(excelExport)
    .where(and(eq(excelExport.lane, lane), eq(excelExport.status, "queued")))
    .orderBy(asc(excelExport.createdAt));
