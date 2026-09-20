// Test DB infra: travis_test lifecycle, schema apply, ordered truncate.
// Real Postgres only — no drizzle mocking (spec rule).
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { env } from "../../src/config/env";
import * as schema from "../../src/db/schema";

export type TestDb = NodePgDatabase<typeof schema>;

const TEST_DB_NAME = "travis_test";

// swap db name in DATABASE_URL, keep creds/host/params
const withDbName = (name: string) => {
  const url = new URL(env.DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
};

// connection string for the test DB (counting client opens its own)
export const testDatabaseUrl = withDbName(TEST_DB_NAME);

// create travis_test if missing + apply committed migrations (idempotent)
export const ensureTestDatabase = async () => {
  const admin = new pg.Client({ connectionString: withDbName("postgres") });
  await admin.connect();
  const existing = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [TEST_DB_NAME],
  );
  if (existing.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  }
  await admin.end();

  const bootPool = new pg.Pool({ connectionString: withDbName(TEST_DB_NAME), max: 1 });
  await migrate(drizzle(bootPool, { schema }), {
    migrationsFolder: new URL("../../migrations", import.meta.url).pathname,
  });
  await bootPool.end();
};

// shared pool for the suite; max 1 keeps query counting deterministic
const pool = new pg.Pool({ connectionString: withDbName(TEST_DB_NAME), max: 1 });
export const testDb: TestDb = drizzle(pool, { schema });

// FK dependency order: children first (app deleteOrder + typed details)
const deleteOrder = [
  schema.recordingIngestSegment,
  schema.recordingIngest,
  schema.videoClip,
  schema.resultImage,
  schema.resultMgiFinding,
  schema.resultMgi,
  schema.resultCviPosition,
  schema.resultCvi,
  schema.resultGvi,
  schema.resultScour,
  schema.resultFmd,
  schema.resultCp,
  schema.result,
  schema.timelineThumbnail,
  schema.masterVideo,
  schema.sessionItem,
  schema.item,
  schema.component,
  schema.asset,
  schema.session,
  schema.project,
] as const;

// wipe all rows between tests, FK-safe order
export const truncateTestDatabase = async (database: TestDb = testDb) => {
  for (const table of deleteOrder) {
    await database.delete(table);
  }
};

// no-op between suite files: bun runs all files in one process and the pool
// is shared. bun test exits when the run completes; ending here would kill
// the pool for every later file.
export const closeTestDatabase = async () => {};
