import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "./client";
import { organization } from "./schema";

const DEFAULT_ORG_NAME = "default";

// flow: insert-if-missing > select > org row. Idempotent boot seed.
// database: optional handle so callers inside a transaction stay on it
export async function ensureDefaultOrganization(database: DbOrTx = db) {
  await database.insert(organization).values({ name: DEFAULT_ORG_NAME }).onConflictDoNothing();
  const rows = await database
    .select()
    .from(organization)
    .where(eq(organization.name, DEFAULT_ORG_NAME))
    .limit(1);
  return rows[0] ?? null;
}
