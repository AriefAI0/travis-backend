import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { createTestUser } from "../helpers/auth";
import { closeTestDatabase, ensureTestDatabase, testDb, truncateTestDatabase } from "../helpers/db";
import {
  deletePermissionsForUser,
  insertPermissions,
  listPermissionsByUser,
} from "../../src/db/repositories/user-permission.repository";

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

describe("user-permission repository", () => {
  it("lists only the rows of the user asked for", async () => {
    const one = await createTestUser();
    const two = await createTestUser();

    await insertPermissions(
      [
        { userId: one.userId, action: "read", subject: "Project" },
        { userId: one.userId, action: "modify", subject: "Result" },
        { userId: two.userId, action: "read", subject: "AuditLog" },
      ],
      testDb,
    );

    const rows = await listPermissionsByUser(one.userId, testDb);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.subject).sort()).toEqual(["Project", "Result"]);
  });

  it("returns nothing for a user with no grants", async () => {
    const user = await createTestUser();

    expect(await listPermissionsByUser(user.userId, testDb)).toEqual([]);
  });

  it("clears one user's set and leaves the other's alone", async () => {
    const one = await createTestUser();
    const two = await createTestUser();

    await insertPermissions(
      [
        { userId: one.userId, action: "read", subject: "Project" },
        { userId: two.userId, action: "read", subject: "Project" },
      ],
      testDb,
    );

    await deletePermissionsForUser(one.userId, testDb);

    expect(await listPermissionsByUser(one.userId, testDb)).toEqual([]);
    expect(await listPermissionsByUser(two.userId, testDb)).toHaveLength(1);
  });

  it("refuses the same action on the same subject twice", async () => {
    const user = await createTestUser();
    await insertPermissions(
      [{ userId: user.userId, action: "read", subject: "Project" }],
      testDb,
    );

    // the unique index is the guard; lib/error.ts maps 23505 to a 409.
    // drizzle wraps the driver error, so the code sits in the cause chain.
    let code: string | undefined;
    try {
      await insertPermissions(
        [{ userId: user.userId, action: "read", subject: "Project" }],
        testDb,
      );
    } catch (err) {
      let current: unknown = err;
      for (let depth = 0; current && depth < 4; depth += 1) {
        const found = (current as { code?: unknown }).code;
        if (typeof found === "string") {
          code = found;
          break;
        }
        current = (current as { cause?: unknown }).cause;
      }
    }

    expect(code).toBe("23505");
  });

  it("treats an empty set as a no-op", async () => {
    expect(await insertPermissions([], testDb)).toEqual([]);
  });
});
