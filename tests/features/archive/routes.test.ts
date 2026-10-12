import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { and, eq, isNotNull } from "drizzle-orm";

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
import { archiveRoutes } from "../../../src/features/archive/routes";
import { auditLog } from "../../../src/lib/auth/schema";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, archiveRoutes);

let adminToken = "";
let viewerToken = "";
let otherOrgId = 0;

// project > group > code > description > type > part code, plus a session
const seedTree = async () => {
  await testDb
    .insert(schema.project)
    .values({ organizationId: testOrgId, displayNumber: 1, projectId: 1, title: "Alpha" });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 10, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 20, taskGroupId: 10, code: "101" });
  await testDb.insert(schema.description).values({ descriptionId: 30, taskCodeId: 20, label: "Row A" });
  await testDb.insert(schema.type).values({ typeId: 40, descriptionId: 30, code: "VDM" });
  await testDb.insert(schema.partCode).values({ partCodeId: 50, typeId: 40, code: "101-105" });
  await testDb.insert(schema.session).values({
    displayNumber: 1,
    sessionId: 60,
    projectId: 1,
    name: "Run 1",
  });
};

// the same shape in a second org, for the cross-org probes
const seedOtherOrg = async () => {
  // the org table outlives a truncate, so the seed is idempotent
  await testDb.insert(schema.organization).values({ name: "other" }).onConflictDoNothing();
  const [org] = await testDb
    .select({ organizationId: schema.organization.organizationId })
    .from(schema.organization)
    .where(eq(schema.organization.name, "other"));
  otherOrgId = org!.organizationId;

  await testDb
    .insert(schema.project)
    .values({ organizationId: otherOrgId, displayNumber: 1, projectId: 2, title: "Beta" });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 11, projectId: 2, code: "200" });
};

// a row is archived exactly when its own column is set
const archivedAt = async (table: "project" | "taskGroup" | "session", id: number) => {
  const rows =
    table === "project"
      ? await testDb
          .select({ at: schema.project.archivedAt })
          .from(schema.project)
          .where(eq(schema.project.projectId, id))
      : table === "taskGroup"
        ? await testDb
            .select({ at: schema.taskGroup.archivedAt })
            .from(schema.taskGroup)
            .where(eq(schema.taskGroup.taskGroupId, id))
        : await testDb
            .select({ at: schema.session.archivedAt })
            .from(schema.session)
            .where(eq(schema.session.sessionId, id));

  return rows[0]?.at ?? null;
};

const archive = (resource: string, id: number) =>
  asAdmin(`/api/v1/${resource}/${id}/archive`, { method: "POST" });

const restore = (resource: string, id: number) =>
  asAdmin(`/api/v1/${resource}/${id}/restore`, { method: "POST" });

const remove = (resource: string, id: number, dryRun = false) =>
  asAdmin(`/api/v1/archive/${resource}/${id}${dryRun ? "?dryRun=true" : ""}`, {
    method: "DELETE",
  });

const asAdmin = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...((init.headers ?? {}) as Record<string, string>),
      authorization: `Bearer ${adminToken}`,
    },
  });

describe("archive routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(async () => {
    await truncateTestDatabase();
    adminToken = (await createTestUser({ preset: "Admin" })).token;
    viewerToken = (await createTestUser({ preset: "Viewer" })).token;
    await seedTree();
    await seedOtherOrg();
  });

  it("archives a project with everything under it", async () => {
    const res = await archive("project", 1);
    expect(res.status).toBe(200);

    expect(await archivedAt("project", 1)).not.toBeNull();
    expect(await archivedAt("taskGroup", 10)).not.toBeNull();
    expect(await archivedAt("session", 60)).not.toBeNull();

    const codes = await testDb
      .select()
      .from(schema.taskCode)
      .where(isNotNull(schema.taskCode.archivedAt));
    expect(codes).toHaveLength(1);

    // the deepest level goes too: archivedAt has no database-level cascade
    const partCodes = await testDb
      .select()
      .from(schema.partCode)
      .where(and(eq(schema.partCode.partCodeId, 50), isNotNull(schema.partCode.archivedAt)));
    expect(partCodes).toHaveLength(1);
  });

  it("archives one node and only what hangs off it", async () => {
    const res = await archive("taskCode", 20);
    expect(res.status).toBe(200);

    expect(await archivedAt("taskGroup", 10)).toBeNull();
    expect(await archivedAt("session", 60)).toBeNull();

    const [description] = await testDb
      .select()
      .from(schema.description)
      .where(eq(schema.description.descriptionId, 30));
    expect(description?.archivedAt).not.toBeNull();
  });

  it("restores the row and its descendants", async () => {
    await archive("project", 1);
    const res = await restore("project", 1);
    expect(res.status).toBe(200);

    expect(await archivedAt("project", 1)).toBeNull();
    expect(await archivedAt("taskGroup", 10)).toBeNull();
    expect(await archivedAt("session", 60)).toBeNull();

    const stillArchived = await testDb
      .select()
      .from(schema.partCode)
      .where(isNotNull(schema.partCode.archivedAt));
    expect(stillArchived).toHaveLength(0);
  });

  it("lists archived rows with search and pagination", async () => {
    await archive("project", 1);

    const listed = await json(await asAdmin("/api/v1/archive?resource=project"));
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].resource).toBe("project");
    expect(listed.data[0].total).toBe(1);
    expect(listed.data[0].rows[0].label).toBe("Alpha");
    // The page acts on the id, so the list must carry it, not just the label.
    expect(listed.data[0].rows[0].id).toBe(1);

    const miss = await json(await asAdmin("/api/v1/archive?resource=project&search=zzz"));
    expect(miss.data[0].rows).toHaveLength(0);

    // the offset pages past the only row
    const paged = await json(await asAdmin("/api/v1/archive?resource=project&limit=1&offset=1"));
    expect(paged.data[0].total).toBe(1);
    expect(paged.data[0].rows).toHaveLength(0);
  });

  it("lists every readable resource when none is named", async () => {
    await archive("project", 1);

    const listed = await json(await asAdmin("/api/v1/archive"));
    const named = listed.data.map((entry: { resource: string }) => entry.resource);

    expect(named).toContain("project");
    expect(named).toContain("taskGroup");
    expect(named).toContain("session");
  });

  it("previews the removal counts, then takes exactly those", async () => {
    await archive("project", 1);

    const preview = await json(await remove("project", 1, true));
    expect(preview.data.counts).toEqual({
      project: 1,
      session: 1,
      taskGroup: 1,
      taskCode: 1,
      description: 1,
      type: 1,
      partCode: 1,
    });

    // a dry run deletes nothing
    expect(await testDb.select().from(schema.project)).toHaveLength(2);

    const removed = await json(await remove("project", 1));
    expect(removed.data.counts).toEqual(preview.data.counts);

    expect(await testDb.select().from(schema.project)).toHaveLength(1);
    expect(await testDb.select().from(schema.taskGroup)).toHaveLength(1);
    expect(await testDb.select().from(schema.partCode)).toHaveLength(0);
  });

  it("refuses result as a resource, on both surfaces", async () => {
    const arch = await archive("result", 1);
    expect(arch.status).toBe(404);

    const del = await remove("result", 1);
    expect(del.status).toBe(404);
  });

  it("cannot reach another org's row", async () => {
    expect((await archive("project", 2)).status).toBe(404);
    expect((await restore("project", 2)).status).toBe(404);
    expect((await remove("project", 2)).status).toBe(404);

    // and the sibling node in that org stays untouched
    expect(await archivedAt("taskGroup", 11)).toBeNull();
  });

  it("refuses a viewer's archive and a viewer's removal", async () => {
    const res = await app.request("/api/v1/project/1/archive", {
      method: "POST",
      headers: bearer(viewerToken),
    });
    expect(res.status).toBe(403);

    const del = await app.request("/api/v1/archive/project/1", {
      method: "DELETE",
      headers: bearer(viewerToken),
    });
    expect(del.status).toBe(403);

    // a viewer reads the archive list, because it holds read on every subject
    const listed = await app.request("/api/v1/archive", { headers: bearer(viewerToken) });
    expect(listed.status).toBe(200);
  });

  it("answers 401 with no token", async () => {
    expect((await app.request("/api/v1/archive")).status).toBe(401);
    expect((await app.request("/api/v1/project/1/archive", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/v1/archive/project/1", { method: "DELETE" })).status).toBe(401);
  });

  it("writes an audit row for the archive and the removal", async () => {
    await archive("project", 1);
    await remove("project", 1);

    const rows = await testDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.organizationId, testOrgId));

    const actions = rows.map((row) => row.action).sort();
    expect(actions).toEqual(["archive", "remove"]);
    expect(rows.find((row) => row.action === "archive")?.resourceType).toBe("project");
  });
});
