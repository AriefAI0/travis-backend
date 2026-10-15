import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";

import { createTestUser } from "../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../helpers/db";
import { auditLog } from "../../src/lib/auth/schema";
import { writeAudit } from "../../src/db/services/audit.service";

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

const rows = () => testDb.select().from(auditLog);

describe("writeAudit", () => {
  it("writes one row inside the caller's transaction", async () => {
    const actor = await createTestUser();

    await testDb.transaction(async (tx) => {
      await writeAudit(
        {
          organizationId: testOrgId,
          userId: actor.userId,
          action: "create",
          resourceType: "Project",
          resourceId: 7,
          after: { title: "Alpha" },
        },
        tx,
      );
    });

    const written = await rows();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      organizationId: testOrgId,
      action: "create",
      resourceType: "Project",
      resourceId: "7",
      userId: actor.userId,
      after: { title: "Alpha" },
    });
    // and it is out of reach of another org's filter
    expect(
      await testDb.select().from(auditLog).where(eq(auditLog.organizationId, -1)),
    ).toHaveLength(0);
  });

  it("leaves no row when the caller's transaction rolls back", async () => {
    const actor = await createTestUser();

    await expect(
      testDb.transaction(async (tx) => {
        await writeAudit(
          {
            organizationId: testOrgId,
            userId: actor.userId,
            action: "remove",
            resourceType: "Result",
            resourceId: 1,
          },
          tx,
        );
        throw new Error("the write after the audit failed");
      }),
    ).rejects.toThrow("the write after the audit failed");

    // an audit trail that survives a rollback records writes that never happened
    expect(await rows()).toHaveLength(0);
  });

  it("strips a password hash out of the payload", async () => {
    const actor = await createTestUser();

    await testDb.transaction(async (tx) => {
      await writeAudit(
        {
          organizationId: testOrgId,
          userId: actor.userId,
          action: "password_reset",
          resourceType: "User",
          resourceId: actor.userId,
          before: { passwordHash: "scrypt$abc", email: "a@b.local" },
          after: { password: "the-new-plaintext", mustChangePassword: true },
        },
        tx,
      );
    });

    const written = (await rows())[0]!;
    const serialized = JSON.stringify(written);
    expect(serialized).not.toContain("scrypt$abc");
    expect(serialized).not.toContain("the-new-plaintext");
    expect(written.before).toMatchObject({ passwordHash: "[redacted]", email: "a@b.local" });
    expect(written.after).toMatchObject({ password: "[redacted]", mustChangePassword: true });
  });

  it("strips a token nested inside the payload", async () => {
    const actor = await createTestUser();

    await testDb.transaction(async (tx) => {
      await writeAudit(
        {
          organizationId: testOrgId,
          userId: actor.userId,
          action: "modify",
          resourceType: "Session",
          resourceId: 5,
          after: { session: { token: "bearer-abc", name: "Run 1" } },
        },
        tx,
      );
    });

    const written = (await rows())[0]!;
    expect(JSON.stringify(written)).not.toContain("bearer-abc");
    expect(written.after).toMatchObject({ session: { token: "[redacted]", name: "Run 1" } });
  });

  it("accepts a null actor for a system write", async () => {
    await testDb.transaction(async (tx) => {
      await writeAudit(
        {
          organizationId: testOrgId,
          userId: null,
          action: "modify",
          resourceType: "Session",
          resourceId: 9,
        },
        tx,
      );
    });

    expect((await rows())[0]).toMatchObject({ userId: null, resourceId: "9" });
  });

  it("refuses to write with no transaction", async () => {
    // a default would write outside the caller's transaction
    await expect(
      writeAudit(
        {
          organizationId: testOrgId,
          userId: null,
          action: "create",
          resourceType: "Project",
          resourceId: 1,
        },
        undefined as never,
      ),
    ).rejects.toThrow(/transaction/);
  });

  it("scopes a read to the calling org", async () => {
    const actor = await createTestUser();

    await testDb.transaction(async (tx) => {
      await writeAudit(
        {
          organizationId: testOrgId,
          userId: actor.userId,
          action: "create",
          resourceType: "Project",
          resourceId: 1,
        },
        tx,
      );
    });

    const mine = await testDb.select().from(auditLog).where(eq(auditLog.organizationId, testOrgId));
    const theirs = await testDb.select().from(auditLog).where(eq(auditLog.organizationId, -1));
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});

// The append-only rule is the whole point of the table, so it is checked
// against the repo file itself rather than trusted.
describe("the audit repository", () => {
  it("has no update or delete", async () => {
    const source = await Bun.file(
      new URL("../../src/db/repositories/audit.repository.ts", import.meta.url).pathname,
    ).text();

    expect(source).not.toMatch(/\.update\(/);
    expect(source).not.toMatch(/\.delete\(/);
  });
});
