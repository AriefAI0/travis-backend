import { db, type DbOrTx } from "../client";
import {
  countAuditRows,
  insertAuditRow,
  listAuditRows,
  type AuditRow,
} from "../repositories/audit.repository";

// The writes the spec puts on the record. Source: travis-viewer-spec.md,
// "Covered actions".
export const AUDIT_ACTIONS = [
  "create",
  "modify",
  "remove",
  "archive",
  "restore",
  "permission_change",
  "password_reset",
  "user_disable",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditEntry = {
  organizationId: number;
  // null for a system write with no actor
  userId: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId?: string | number | null;
  before?: unknown;
  after?: unknown;
};

// Exact field names that carry a secret, lower-cased. A name list, not a
// substring test: `mustChangePassword` holds a boolean and must survive, and
// a substring rule would eat it. A new secret field gets added here.
const SECRET_KEYS = new Set([
  "password",
  "passwordhash",
  "hash",
  "token",
  "sessiontoken",
  "secret",
  "authorization",
  "credential",
  "credentials",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "otp",
]);
const REDACTED = "[redacted]";
// Deep payloads are truncated rather than walked forever.
const MAX_DEPTH = 6;

// flow: walk the value > replace secret-named keys > keep the rest
// A password hash or a bearer token must never reach this table, so the
// stripping happens here rather than at each call site.
const redact = (value: unknown, depth = 0): unknown => {
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : redact(nested, depth + 1);
  }
  return out;
};

// flow: entry > redact before/after > insert on the caller's transaction
// NO default for `tx`. A default would write outside the caller's transaction
// and leave a row behind when that transaction rolls back — an audit trail
// that records writes that never happened.
export const writeAudit = async (entry: AuditEntry, tx: DbOrTx): Promise<void> => {
  if (!tx) {
    throw new Error("writeAudit needs the caller's transaction");
  }

  await insertAuditRow(
    {
      organizationId: entry.organizationId,
      userId: entry.userId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId === null || entry.resourceId === undefined
        ? null
        : String(entry.resourceId),
      before: redact(entry.before),
      after: redact(entry.after),
    },
    tx,
  );
};

export type AuditQuery = {
  userId?: string;
  resourceType?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
};

// flow: filters > page + total, newest first
// The org is applied on both queries, so the total never counts another
// tenant's rows.
export const listAuditLog = async (
  organizationId: number,
  query: AuditQuery,
  database: DbOrTx = db,
): Promise<{ items: AuditRow[]; total: number; limit: number; offset: number }> => {
  const filters = {
    organizationId,
    userId: query.userId,
    resourceType: query.resourceType,
    from: query.from,
    to: query.to,
  };

  const [items, total] = await Promise.all([
    listAuditRows(filters, query.limit, query.offset, database),
    countAuditRows(filters, database),
  ]);

  return { items, total, limit: query.limit, offset: query.offset };
};
