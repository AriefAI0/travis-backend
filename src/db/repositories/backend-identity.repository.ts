import { eq } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { backendIdentity } from "../schema";

// read the singleton identity row, or null before first bootstrap
export const findBackendIdentity = async (database: DbOrTx = db) =>
  (await database.query.backendIdentity.findFirst()) ?? null;

// insert the singleton row; no-op when it already exists (idempotent bootstrap)
export const insertBackendIdentity = async (
  data: typeof backendIdentity.$inferInsert,
  database: DbOrTx = db,
) => {
  const inserted = await database
    .insert(backendIdentity)
    .values(data)
    .onConflictDoNothing()
    .returning();
  return inserted[0] ?? null;
};

// update the singleton row (recovery authority flag)
export const updateBackendIdentity = async (
  data: Partial<typeof backendIdentity.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updated = await database
    .update(backendIdentity)
    .set(data)
    .where(eq(backendIdentity.singletonId, 1))
    .returning();
  return updated[0] ?? null;
};
