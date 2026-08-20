import { drizzle, type NodePgDatabase, type NodePgTransaction } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { Pool } from "pg"; // pg = postgres driver, for drizzle-orm to use under the hood
import { env } from "../config/env";
import * as schema from "./schema";

// Pooling connection for db
export const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema });

// Readiness probe — one round trip, no schema involved.
export async function pingDb(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export type Db = NodePgDatabase<typeof schema>;

// typesafe transaction type, for use in functions that accept either a db or a transaction
export type DbOrTx = Db | NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;
