import { env } from "../../config/env";
import { db, type DbOrTx } from "../../db/client";
import { ensureDefaultOrganization } from "../../db/ensure-org";
import { createUser } from "../../db/services/user.service";
import { authUser } from "./schema";

// The first admin, and only the first.
// flow: any account exists? > stop : seed one admin holding the Admin preset
// Runs only on an empty account table, so a restart never resets a password.
// Returns null when it seeds nothing, which is the normal case.
export const seedFirstAdmin = async (database?: DbOrTx) => {
  const email = env.ADMIN_EMAIL;
  const password = env.ADMIN_PASSWORD;
  if (!email || !password) return null;

  const run = async (tx: DbOrTx) => {
    const existing = await tx.select({ id: authUser.id }).from(authUser).limit(1);
    if (existing.length > 0) return null;

    const org = await ensureDefaultOrganization(tx);
    if (!org) throw new Error("No default organization to seed the admin into");

    return createUser(
      {
        email,
        name: env.ADMIN_NAME ?? "Administrator",
        password,
        preset: "Admin",
        organizationId: org.organizationId,
        // the deploy supplies this password, so it is already the operator's
        mustChangePassword: false,
      },
      tx,
    );
  };

  return database ? run(database) : db.transaction(run);
};
