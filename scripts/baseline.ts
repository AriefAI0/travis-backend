// One-time cutover for push-managed databases: records the latest migration
// as applied WITHOUT running its SQL. Run only on a database that already
// matches src/db/schema.ts — the migrator skips by created_at, never re-checks.
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";
import { env } from "../src/config/env";

const migrations = readMigrationFiles({ migrationsFolder: `${import.meta.dir}/../migrations` });
const latest = migrations.at(-1);
if (!latest) {
  console.error("no migrations found — run bun run db:generate first");
  process.exit(1);
}

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });

// flow: ensure bookkeeping table > refuse when already marked > insert marker
await pool.query("CREATE SCHEMA IF NOT EXISTS drizzle");
await pool.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
)`);

const { rows } = await pool.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
if (rows[0].n > 0) {
  console.error(
    "refused: drizzle.__drizzle_migrations already has rows — database is baselined or migrate-managed",
  );
  await pool.end();
  process.exit(1);
}

await pool.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [
  latest.hash,
  latest.folderMillis,
]);
console.log(`baseline marked: created_at=${latest.folderMillis} hash=${latest.hash.slice(0, 12)}`);
console.log("drizzle-kit migrate now applies only future migrations");
await pool.end();
process.exit(0);
