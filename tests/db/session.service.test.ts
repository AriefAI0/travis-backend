import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";
import { auditLog } from "../../src/lib/auth/schema";
import {
  createSession,
  deleteSession,
  getSessionById,
  getSessionByProjectIdAndName,
  listSessions,
  listSessionsByProjectId,
  updateSession,
} from "../../src/db/services/session.service";

// No user exists at this level, so the audit rows are system writes.
const caller = () => ({ organizationId: testOrgId, userId: null });

describe("session.service", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  it("assigns display numbers as per-project max + 1", async () => {
    await testDb.insert(schema.project).values({ organizationId: testOrgId, displayNumber: 1, projectId: 1, title: "Project One" });
    await testDb.insert(schema.project).values({ organizationId: testOrgId, displayNumber: 2, projectId: 2, title: "Project Two" });

    const first = await createSession({ projectId: 1, name: "Run 1" }, caller(), testDb);
    const second = await createSession({ projectId: 1, name: "Run 2" }, caller(), testDb);
    const otherProject = await createSession({ projectId: 2, name: "Run A" }, caller(), testDb);

    expect(first).toMatchObject({ projectId: 1, displayNumber: 1 });
    expect(second).toMatchObject({ projectId: 1, displayNumber: 2 });
    // counters run per project, never globally
    expect(otherProject).toMatchObject({ projectId: 2, displayNumber: 1 });
  });

  it("refuses a session under another org's project", async () => {
    const other = await testDb
      .insert(schema.organization)
      .values({ name: `other-${crypto.randomUUID()}` })
      .returning()
      .then((rows) => rows[0]!);
    await testDb
      .insert(schema.project)
      .values({ organizationId: other.organizationId, displayNumber: 1, projectId: 9, title: "Theirs" });

    await expect(createSession({ projectId: 9, name: "Trespass" }, caller(), testDb)).rejects.toThrow(
      /Project not found/,
    );
  });

  it("records one audit row per write, in the caller's transaction", async () => {
    await testDb.insert(schema.project).values({ organizationId: testOrgId, displayNumber: 1, projectId: 1, title: "Alpha" });

    const created = await createSession({ projectId: 1, name: "Run 1" }, caller(), testDb);
    await updateSession(created!.sessionId, { name: "Run 1 (edited)" }, caller(), testDb);
    await deleteSession(created!.sessionId, caller(), testDb);

    const rows = await testDb.select().from(auditLog).orderBy(auditLog.auditLogId);
    expect(rows.map((row) => row.action)).toEqual(["create", "modify", "remove"]);
    expect(rows.every((row) => row.organizationId === testOrgId)).toBe(true);
    expect(rows[1]!.before).toMatchObject({ name: "Run 1" });
    expect(rows[1]!.after).toMatchObject({ name: "Run 1 (edited)" });
  });

  it("leaves no audit row when the transaction rolls back", async () => {
    await testDb.insert(schema.project).values({ organizationId: testOrgId, displayNumber: 1, projectId: 1, title: "Alpha" });

    await expect(
      testDb.transaction(async (tx) => {
        await createSession({ projectId: 1, name: "Rolled back" }, caller(), tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await testDb.select().from(schema.session)).toHaveLength(0);
    expect(await testDb.select().from(auditLog)).toHaveLength(0);
  });
});
