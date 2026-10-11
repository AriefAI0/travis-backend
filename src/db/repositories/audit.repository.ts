import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import { auditLog } from "../../lib/auth/schema";
import { db, type DbOrTx } from "../client";

export type AuditRow = typeof auditLog.$inferSelect;
export type AuditInsert = typeof auditLog.$inferInsert;

// Append only. This file has no update and no delete on purpose: an audit
// trail a handler can rewrite is not an audit trail.
export const insertAuditRow = async (
  row: AuditInsert,
  database: DbOrTx,
): Promise<AuditRow> => {
  const inserted = await database.insert(auditLog).values(row).returning();
  return inserted[0]!;
};

export type AuditFilters = {
  organizationId: number;
  userId?: string;
  resourceType?: string;
  from?: Date;
  to?: Date;
};

// Every filter is optional on top of the org, which is never optional.
const whereFor = (filters: AuditFilters): SQL => {
  const clauses: SQL[] = [eq(auditLog.organizationId, filters.organizationId)];
  if (filters.userId) clauses.push(eq(auditLog.userId, filters.userId));
  if (filters.resourceType) clauses.push(eq(auditLog.resourceType, filters.resourceType));
  if (filters.from) clauses.push(gte(auditLog.createdAt, filters.from));
  if (filters.to) clauses.push(lte(auditLog.createdAt, filters.to));

  return and(...clauses)!;
};

// Newest first: the audit read is "what just happened".
export const listAuditRows = async (
  filters: AuditFilters,
  limit: number,
  offset: number,
  database: DbOrTx = db,
): Promise<AuditRow[]> =>
  database
    .select()
    .from(auditLog)
    .where(whereFor(filters))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.auditLogId))
    .limit(limit)
    .offset(offset);

export const countAuditRows = async (
  filters: AuditFilters,
  database: DbOrTx = db,
): Promise<number> => {
  const rows = await database
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(auditLog)
    .where(whereFor(filters));

  return rows[0]?.total ?? 0;
};
