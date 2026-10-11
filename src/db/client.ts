import { drizzle, type NodePgDatabase, type NodePgTransaction } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { Pool } from "pg"; // pg = postgres driver, for drizzle-orm to use under the hood
import { env } from "../config/env";
import * as schema from "./schema";
import { authTables } from "../lib/auth/schema";

// One registry for both schema files. Keys are export names, so nothing here
// shadows the domain's `session`.
export const fullSchema = { ...schema, ...authTables };

// Pooling connection for db
export const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema: fullSchema });

// Readiness probe — one round trip, no schema involved.
export async function pingDb(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export type Db = NodePgDatabase<typeof fullSchema>;

// typesafe transaction type, for use in functions that accept either a db or a transaction
export type DbOrTx =
  | Db
  | NodePgTransaction<typeof fullSchema, ExtractTablesWithRelations<typeof fullSchema>>;
