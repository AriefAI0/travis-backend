import { eq } from "drizzle-orm";
import { db } from "./client";
import { organization } from "./schema";

const DEFAULT_ORG_NAME = "default";

// flow: insert-if-missing > select > org row. Idempotent boot seed.
export async function ensureDefaultOrganization() {
  await db.insert(organization).values({ name: DEFAULT_ORG_NAME }).onConflictDoNothing();
  const rows = await db
    .select()
    .from(organization)
    .where(eq(organization.name, DEFAULT_ORG_NAME))
    .limit(1);
  return rows[0] ?? null;
}
