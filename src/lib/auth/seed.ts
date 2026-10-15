import { and, eq, isNull } from "drizzle-orm";

import { env } from "../../config/env";
import { db, type DbOrTx } from "../../db/client";
import { ensureDefaultOrganization } from "../../db/ensure-org";
import { createUser } from "../../db/services/user.service";
import { authUser } from "./schema";

// The first admin, and only the first.
// flow: any account exists? > backfill a missing username : seed one admin
// Seeds only on an empty account table, so a restart never resets a password.
// Returns null when it seeds nothing, which is the normal case.
export const seedFirstAdmin = async (database?: DbOrTx) => {
  const email = env.ADMIN_EMAIL;
  const password = env.ADMIN_PASSWORD;
  // stored lowercase, so a typed handle matches whatever case it was given in
  const username = env.ADMIN_USERNAME?.trim().toLowerCase();
  if (!email || !password) return null;

  const run = async (tx: DbOrTx) => {
    const existing = await tx.select({ id: authUser.id }).from(authUser).limit(1);

    // Table not empty: fill a missing username on the configured admin, so an
    // existing deploy picks ADMIN_USERNAME up without a reseed. The password
    // is never touched.
    if (existing.length > 0) {
      if (!username) return null;
      await tx
        .update(authUser)
        .set({ username })
        .where(
          and(eq(authUser.email, email.toLowerCase()), isNull(authUser.username)),
        );
      return null;
    }

    const org = await ensureDefaultOrganization(tx);
    if (!org) throw new Error("No default organization to seed the admin into");

    return createUser(
      {
        email,
        name: env.ADMIN_NAME ?? "Administrator",
        username,
        password,
        preset: "Admin",
        organizationId: org.organizationId,
        // the deploy supplies this password, so it is already the operator's
        mustChangePassword: false,
      },
      // a system write: the seed runs before any account can act
      { organizationId: org.organizationId, userId: null },
      tx,
    );
  };

  return database ? run(database) : db.transaction(run);
};
