// Test DB infra: travis_test lifecycle, schema apply, ordered truncate.
// Real Postgres only — no drizzle mocking (spec rule).
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { env } from "../../src/config/env";
import * as schema from "../../src/db/schema";
import { authTables } from "../../src/lib/auth/schema";

const fullSchema = { ...schema, ...authTables };

export type TestDb = NodePgDatabase<typeof fullSchema>;

const TEST_DB_NAME = "travis_test";

// swap db name in DATABASE_URL, keep creds/host/params
const withDbName = (name: string) => {
  const url = new URL(env.DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
};

// connection string for the test DB (counting client opens its own)
export const testDatabaseUrl = withDbName(TEST_DB_NAME);

// The seeded default org. project.organization_id is NOT NULL, so every test
// that inserts a project hangs off this. Set in ensureTestDatabase, which each
// file runs in beforeAll — callers only read it inside a hook or a test.
export let testOrgId = 0;

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
  await migrate(drizzle(bootPool, { schema: fullSchema }), {
    migrationsFolder: new URL("../../migrations", import.meta.url).pathname,
  });
  // 0003 seeds 'default'; read it back rather than assume an id
  const seeded = await bootPool.query<{ organization_id: number }>(
    `SELECT organization_id FROM organization WHERE name = 'default' LIMIT 1`,
  );
  testOrgId = seeded.rows[0]?.organization_id ?? 0;
  await bootPool.end();
};

// shared pool for the suite; max 1 keeps query counting deterministic
const pool = new pg.Pool({ connectionString: withDbName(TEST_DB_NAME), max: 1 });
export const testDb: TestDb = drizzle(pool, { schema: fullSchema });

// FK dependency order: children first (app deleteOrder + typed details).
// The auth block leads: every one of those rows hangs off auth_user.
const deleteOrder = [
  schema.recordingIngestSegment,
  schema.recordingIngest,
  schema.videoClip,
  schema.resultImage,
  schema.resultMgiFinding,
  schema.resultMgi,
  schema.resultGviMgiFinding,
  schema.resultGviMgi,
  schema.resultGviFinding,
  schema.resultCviFinding,
  schema.resultCviPosition,
  schema.resultCvi,
  schema.resultDviPosition,
  schema.resultDvi,
  schema.resultGvi,
  schema.resultCgb,
  schema.resultRiser,
  schema.resultCiGviAssociatedPipe,
  schema.resultCiCpFinding,
  schema.resultCi,
  schema.resultSeabedFinding,
  schema.resultSeabed,
  schema.resultPipelineFinding,
  schema.resultPipeline,
  schema.resultBsiClampMissingBolt,
  schema.resultBsiClampMissingWasher,
  schema.resultBsiHingeMissingBolt,
  schema.resultBsiHingeMissingWasher,
  schema.resultBsi,
  schema.resultScour,
  schema.resultFmd,
  schema.resultCp,
  schema.result,
  schema.inspectionFormField,
  schema.inspectionForm,
  schema.partCode,
  schema.type,
  schema.description,
  schema.taskCode,
  schema.taskGroup,
  schema.timelineThumbnail,
  schema.session,
  schema.report,
  schema.project,

  // auth block: last, and children first — auth_user goes after everything
  // that references it
  authTables.auditLog,
  authTables.userPermission,
  authTables.authSession,
  authTables.authAccount,
  authTables.authVerification,
  authTables.authUser,
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
