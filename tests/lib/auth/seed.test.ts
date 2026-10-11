import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";

import { createTestUser } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { env } from "../../../src/config/env";
import { authAccount, authUser } from "../../../src/lib/auth/schema";
import { seedFirstAdmin } from "../../../src/lib/auth/seed";
import { presetRows } from "../../../src/lib/auth/presets";
import { setUserPassword } from "../../../src/db/services/user.service";
import { listPermissionsByUser } from "../../../src/db/repositories/user-permission.repository";

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

// The seed reads its credentials from env; tests set them for the file.
const withAdminEnv = <T>(run: () => Promise<T>): Promise<T> => {
  const before = { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD };
  env.ADMIN_EMAIL = "seed-admin@example.local";
  env.ADMIN_PASSWORD = "seed-admin-password";
  env.ADMIN_NAME = "Seeded Admin";

  return run().finally(() => {
    env.ADMIN_EMAIL = before.email;
    env.ADMIN_PASSWORD = before.password;
  });
};

describe("seedFirstAdmin", () => {
  it("seeds one admin holding the Admin preset on an empty table", async () => {
    const seeded = await withAdminEnv(() => seedFirstAdmin(testDb));

    expect(seeded).not.toBeNull();
    expect(seeded!.email).toBe("seed-admin@example.local");

    const rows = await listPermissionsByUser(seeded!.id, testDb);
    expect(rows).toHaveLength(presetRows("Admin").length);
  });

  it("does nothing when an account already exists", async () => {
    const existing = await createTestUser();

    const seeded = await withAdminEnv(() => seedFirstAdmin(testDb));

    expect(seeded).toBeNull();
    // the pre-existing account is untouched
    const rows = await testDb.select().from(authUser);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(existing.userId);
  });

  it("does not reset the password on a second run", async () => {
    await withAdminEnv(() => seedFirstAdmin(testDb));
    const hashOf = async () =>
      (
        await testDb
          .select({ password: authAccount.password })
          .from(authAccount)
          .where(eq(authAccount.providerId, "credential"))
      )[0]?.password;

    // the operator changes the password out of band, as they would in life
    await setUserPassword((await testDb.select().from(authUser))[0]!.id, "a-brand-new-password", testDb);
    const afterChange = await hashOf();

    const second = await withAdminEnv(() => seedFirstAdmin(testDb));

    expect(second).toBeNull();
    expect(await hashOf()).toBe(afterChange);
  });

  it("stays out of the way when no admin credentials are configured", async () => {
    const seeded = await withAdminEnv(async () => {
      env.ADMIN_EMAIL = undefined;
      env.ADMIN_PASSWORD = undefined;
      return seedFirstAdmin(testDb);
    });

    expect(seeded).toBeNull();
    expect(await testDb.select().from(authUser)).toHaveLength(0);
  });

  it("refuses a password under the floor", async () => {
    await expect(
      withAdminEnv(async () => {
        env.ADMIN_PASSWORD = "short";
        return seedFirstAdmin(testDb);
      }),
    ).rejects.toThrow(/at least 12 characters/);
  });
});
