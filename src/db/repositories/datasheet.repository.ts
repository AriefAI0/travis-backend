// Data access for stored datasheets. Every read carries the org, so no query
// can cross an org boundary once auth lands.
import { and, desc, eq, lt } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { datasheetReport } from "../schema";

export type DatasheetRow = typeof datasheetReport.$inferSelect;

// One project's datasheets, newest first.
export const listDatasheetRecords = async (
  organizationId: number,
  projectId: number,
  database: DbOrTx = db,
) =>
  database
    .select()
    .from(datasheetReport)
    .where(
      and(eq(datasheetReport.organizationId, organizationId), eq(datasheetReport.projectId, projectId)),
    )
    .orderBy(desc(datasheetReport.createdAt));

export const findDatasheetRecord = async (
  organizationId: number,
  datasheetId: string,
  database: DbOrTx = db,
) => {
  const rows = await database
    .select()
    .from(datasheetReport)
    .where(
      and(
        eq(datasheetReport.organizationId, organizationId),
        eq(datasheetReport.datasheetId, datasheetId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
};

export const insertDatasheetRecord = async (
  values: typeof datasheetReport.$inferInsert,
  database: DbOrTx = db,
) => {
  const rows = await database.insert(datasheetReport).values(values).returning();

  return rows[0] ?? null;
};

export const updateDatasheetRecord = async (
  organizationId: number,
  datasheetId: string,
  values: Partial<typeof datasheetReport.$inferInsert>,
  database: DbOrTx = db,
) => {
  const rows = await database
    .update(datasheetReport)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(
        eq(datasheetReport.organizationId, organizationId),
        eq(datasheetReport.datasheetId, datasheetId),
      ),
    )
    .returning();

  return rows[0] ?? null;
};

// Returns the removed row so the caller can drop its stored objects too.
export const deleteDatasheetRecord = async (
  organizationId: number,
  datasheetId: string,
  database: DbOrTx = db,
) => {
  const rows = await database
    .delete(datasheetReport)
    .where(
      and(
        eq(datasheetReport.organizationId, organizationId),
        eq(datasheetReport.datasheetId, datasheetId),
      ),
    )
    .returning();

  return rows[0] ?? null;
};

// Rows a crash left mid-render. The one query without an org filter: the boot
// sweep runs before any caller has an org, and it only touches `generating`.
export const failStaleGeneratingDatasheets = async (
  cutoff: Date,
  database: DbOrTx = db,
) => {
  const rows = await database
    .update(datasheetReport)
    .set({
      status: "error",
      errorDetail: "Generation was interrupted before it finished",
      updatedAt: new Date(),
    })
    .where(and(eq(datasheetReport.status, "generating"), lt(datasheetReport.createdAt, cutoff)))
    .returning({ datasheetId: datasheetReport.datasheetId });

  return rows.length;
};
