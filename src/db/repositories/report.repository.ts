import { and, desc, eq, lt } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { report } from "../schema";

export type ReportRow = typeof report.$inferSelect;

// One project's reports, newest first. Every read carries the org, so no query
// can cross an org boundary once auth lands.
export const listReportRecords = async (
  organizationId: number,
  projectId: number,
  database: DbOrTx = db,
) =>
  database
    .select()
    .from(report)
    .where(and(eq(report.organizationId, organizationId), eq(report.projectId, projectId)))
    .orderBy(desc(report.createdAt));

export const findReportRecord = async (
  organizationId: number,
  reportId: string,
  database: DbOrTx = db,
) => {
  const rows = await database
    .select()
    .from(report)
    .where(and(eq(report.organizationId, organizationId), eq(report.reportId, reportId)))
    .limit(1);

  return rows[0] ?? null;
};

export const insertReportRecord = async (
  values: typeof report.$inferInsert,
  database: DbOrTx = db,
) => {
  const rows = await database.insert(report).values(values).returning();

  return rows[0] ?? null;
};

// The where repeats the org, so a stale caller cannot touch another org's row.
export const updateReportRecord = async (
  organizationId: number,
  reportId: string,
  values: Partial<typeof report.$inferInsert>,
  database: DbOrTx = db,
) => {
  const rows = await database
    .update(report)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(report.organizationId, organizationId), eq(report.reportId, reportId)))
    .returning();

  return rows[0] ?? null;
};

// Returns the removed row so the caller can drop its stored object too.
export const deleteReportRecord = async (
  organizationId: number,
  reportId: string,
  database: DbOrTx = db,
) => {
  const rows = await database
    .delete(report)
    .where(and(eq(report.organizationId, organizationId), eq(report.reportId, reportId)))
    .returning();

  return rows[0] ?? null;
};

// Rows a crash left mid-render. The one query without an org filter: the boot
// sweep runs before any caller has an org, and it only touches `generating`.
export const failStaleGeneratingReports = async (
  cutoff: Date,
  database: DbOrTx = db,
) => {
  const rows = await database
    .update(report)
    .set({
      status: "error",
      errorDetail: "Generation was interrupted before it finished",
      updatedAt: new Date(),
    })
    .where(and(eq(report.status, "generating"), lt(report.createdAt, cutoff)))
    .returning({ reportId: report.reportId });

  return rows.length;
};
