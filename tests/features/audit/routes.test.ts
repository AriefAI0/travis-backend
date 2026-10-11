import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";

import { appFor } from "../../helpers/app";
import { bearer, createTestUser } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { auditRoutes } from "../../../src/features/audit/routes";
import { writeAudit } from "../../../src/db/services/audit.service";
import { auditLog } from "../../../src/lib/auth/schema";
import { organization } from "../../../src/db/schema";

const app = appFor(testDb, auditRoutes);

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

// A second org. Organization rows outlive the truncate, so the name carries a
// suffix rather than tripping the unique index on a second call.
const otherOrgId = async () => {
  const rows = await testDb
    .insert(organization)
    .values({ name: `audit-other-${crypto.randomUUID()}` })
    .returning();
  return rows[0]!.organizationId;
};

// flow: seed a row per case, then read it back with a filter
const seedRow = async (
  action: "create" | "modify" | "remove",
  resourceType: string,
  resourceId: number,
  userId: string | null = null,
  createdAt?: Date,
  organizationId: number = testOrgId,
) => {
  await testDb.transaction(async (tx) => {
    await writeAudit(
      {
        organizationId,
        userId,
        action,
        resourceType,
        resourceId,
        after: { resourceType },
      },
      tx,
    );
    // written at now(); the date filter needs a spread of ages to bite on
    if (createdAt) {
      await tx
        .update(auditLog)
        .set({ createdAt })
        .where(eq(auditLog.resourceId, String(resourceId)));
    }
  });
};

const get = (path: string, token: string) => app.request(path, { headers: bearer(token) });

describe("GET /api/v1/audit-logs", () => {
  it("lists the org's rows newest first with a total", async () => {
    const boss = await createTestUser({ preset: "Admin" });
    await seedRow("create", "Project", 1, boss.userId);
    await seedRow("modify", "Result", 2, boss.userId);

    const res = await get("/api/v1/audit-logs", boss.token);

    expect(res.status).toBe(200);
    const body = await json<{
      data: { items: Array<{ resourceType: string }>; total: number; limit: number; offset: number };
    }>(res);
    expect(body.data.total).toBe(2);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0]!.resourceType).toBe("Result");
    expect(body.data.limit).toBe(50);
    expect(body.data.offset).toBe(0);
  });

  it("filters by resource type", async () => {
    const boss = await createTestUser({ preset: "Admin" });
    await seedRow("create", "Project", 1, boss.userId);
    await seedRow("modify", "Result", 2, boss.userId);

    const body = await json<{ data: { items: Array<{ resourceType: string }>; total: number } }>(
      await get("/api/v1/audit-logs?resourceType=Result", boss.token),
    );

    expect(body.data.total).toBe(1);
    expect(body.data.items[0]!.resourceType).toBe("Result");
  });

  it("filters by user", async () => {
    const boss = await createTestUser({ preset: "Admin" });
    const other = await createTestUser({ preset: "Operator" });
    await seedRow("create", "Project", 1, boss.userId);
    await seedRow("modify", "Project", 2, other.userId);

    const body = await json<{ data: { items: Array<{ userId: string }>; total: number } }>(
      await get(`/api/v1/audit-logs?userId=${other.userId}`, boss.token),
    );

    expect(body.data.total).toBe(1);
    expect(body.data.items[0]!.userId).toBe(other.userId);
  });

  it("filters by date range", async () => {
    const boss = await createTestUser({ preset: "Admin" });
    await seedRow("create", "Project", 1, boss.userId, new Date("2020-01-01T00:00:00Z"));
    await seedRow("create", "Project", 2, boss.userId, new Date("2030-01-01T00:00:00Z"));

    const body = await json<{ data: { total: number } }>(
      await get("/api/v1/audit-logs?from=2025-01-01T00:00:00Z", boss.token),
    );

    expect(body.data.total).toBe(1);
  });

  it("pages with limit and offset", async () => {
    const boss = await createTestUser({ preset: "Admin" });
    for (let i = 1; i <= 5; i++) await seedRow("create", "Project", i, boss.userId);

    const body = await json<{ data: { items: unknown[]; total: number; limit: number; offset: number } }>(
      await get("/api/v1/audit-logs?limit=2&offset=2", boss.token),
    );

    expect(body.data.total).toBe(5);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.limit).toBe(2);
    expect(body.data.offset).toBe(2);
  });

  it("refuses a limit over the cap", async () => {
    const boss = await createTestUser({ preset: "Admin" });

    const res = await get("/api/v1/audit-logs?limit=5000", boss.token);

    expect(res.status).toBe(400);
  });

  it("never returns another org's rows", async () => {
    const boss = await createTestUser({ preset: "Admin" });
    const elsewhere = await otherOrgId();
    await seedRow("create", "Project", 1, null, undefined, elsewhere);

    const body = await json<{ data: { total: number } }>(
      await get("/api/v1/audit-logs", boss.token),
    );

    expect(body.data.total).toBe(0);
  });

  it("refuses a Viewer, who is granted no AuditLog read", async () => {
    const viewer = await createTestUser({ preset: "Viewer" });

    const res = await get("/api/v1/audit-logs", viewer.token);

    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe("forbidden");
  });

  it("refuses an Operator", async () => {
    const operator = await createTestUser({ preset: "Operator" });

    expect((await get("/api/v1/audit-logs", operator.token)).status).toBe(403);
  });

  it("refuses a request with no token", async () => {
    expect((await app.request("/api/v1/audit-logs")).status).toBe(401);
  });

  it("exposes no write route", async () => {
    const boss = await createTestUser({ preset: "Admin" });

    const posted = await app.request("/api/v1/audit-logs", {
      method: "POST",
      headers: { ...bearer(boss.token), "content-type": "application/json" },
      body: JSON.stringify({ action: "create" }),
    });
    const deleted = await app.request("/api/v1/audit-logs/1", {
      method: "DELETE",
      headers: bearer(boss.token),
    });

    expect(posted.status).toBe(404);
    expect(deleted.status).toBe(404);
  });
});
