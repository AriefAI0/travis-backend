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
import { eventRoutes } from "../../../src/features/events/routes";
import { projectRoutes } from "../../../src/features/projects/routes";
import { userRoutes } from "../../../src/features/users/routes";
import { publish, subscriberCount, type ChangeEvent } from "../../../src/lib/events/bus";
import { userPermission } from "../../../src/lib/auth/schema";
import { organization } from "../../../src/db/schema";

const app = appFor(testDb, eventRoutes);

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

// The frame grammar: `event:` then `data:` then `id:`, blank line to end. The
// blank line ends the frame, not the data line, so the pattern stops at the
// first newline after the payload.
const DATA = /data: (.+)\n/;

type Probe = {
  // The next change frame, or null when the window passes with nothing.
  next: (timeoutMs?: number) => Promise<ChangeEvent | null>
  // Nothing arrives for the window.
  silence: () => Promise<void>
  close: () => Promise<void>
};

// flow: open one stream > keep ONE read in flight > hand out frames
// A read left pending by a timeout is reused rather than re-issued: a second
// concurrent read on one reader never settles.
const openStream = async (token: string): Promise<Probe> => {
  const response = await app.request("/api/v1/events", { headers: bearer(token) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: Promise<{ done: boolean; value?: Uint8Array }> | null = null;

  const pump = async (deadline: number): Promise<ChangeEvent | null> => {
    while (Date.now() < deadline) {
      pending ??= reader.read();

      const chunk = await Promise.race([
        pending,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()))),
      ]);

      if (chunk === null) continue;
      pending = null;
      if (chunk.done || !chunk.value) return null;

      buffer += decoder.decode(chunk.value);
      const match = buffer.match(DATA);
      if (match?.[1]) {
        buffer = buffer.slice(match.index! + match[0].length);
        return JSON.parse(match[1]) as ChangeEvent;
      }
    }

    return null;
  };

  return {
    next: (timeoutMs = 4_000) => pump(Date.now() + timeoutMs),
    silence: async () => {
      expect(await pump(Date.now() + 1_500)).toBeNull();
    },
    close: () => reader.cancel(),
  };
};

const org = (name: string) => testDb.insert(organization).values({ name }).returning();

describe("GET /api/v1/events", () => {
  it("refuses a caller with no token", async () => {
    expect((await app.request("/api/v1/events")).status).toBe(401);
  });

  it("answers an event stream to a signed-in caller", async () => {
    const user = await createTestUser({ preset: "Admin" });
    const stream = await openStream(user.token);

    await stream.close();
  });

  it("delivers its own organization's event", async () => {
    const user = await createTestUser({ preset: "Admin" });
    const stream = await openStream(user.token);

    publish({
      organizationId: testOrgId,
      action: "modify",
      resourceType: "project",
      resourceId: "7",
      userId: null,
    });

    expect(await stream.next()).toMatchObject({
      organizationId: testOrgId,
      action: "modify",
      resourceType: "project",
      resourceId: "7",
    });

    await stream.close();
  });

  // The load-bearing one: a leak here leaks every change in the deployment.
  it("never crosses an organization boundary", async () => {
    const rows = await org(`other-${crypto.randomUUID()}`);
    const otherOrgId = rows[0]!.organizationId;

    const mine = await createTestUser({ preset: "Admin", organizationId: otherOrgId });
    const stream = await openStream(mine.token);

    publish({
      organizationId: testOrgId,
      action: "modify",
      resourceType: "project",
      resourceId: "1",
      userId: null,
    });
    await stream.silence();

    // the stream still works: its own org's event arrives after
    publish({
      organizationId: otherOrgId,
      action: "create",
      resourceType: "project",
      resourceId: "2",
      userId: null,
    });
    expect(await stream.next()).toMatchObject({ resourceId: "2" });

    await stream.close();
  });

  it("withholds an event for a resource the caller cannot read", async () => {
    const viewer = await createTestUser({ preset: "Viewer" });
    const stream = await openStream(viewer.token);

    // the Viewer preset holds no read AuditLog
    publish({
      organizationId: testOrgId,
      action: "modify",
      resourceType: "auditLog",
      resourceId: "3",
      userId: null,
    });
    await stream.silence();

    // an event they may read still arrives
    publish({
      organizationId: testOrgId,
      action: "modify",
      resourceType: "project",
      resourceId: "4",
      userId: null,
    });
    expect(await stream.next()).toMatchObject({ resourceId: "4" });

    await stream.close();
  });

  it("withholds a resource type nobody mapped", async () => {
    const user = await createTestUser({ preset: "Admin" });
    const stream = await openStream(user.token);

    publish({
      organizationId: testOrgId,
      action: "create",
      resourceType: "somethingNew",
      resourceId: "5",
      userId: null,
    });
    await stream.silence();

    await stream.close();
  });

  // A user must learn that their own rights moved, whatever they may read.
  // The row's target is the account, so the actor is somebody else.
  it("delivers a change to the caller's own account", async () => {
    const admin = await createTestUser({ preset: "Admin" });
    const viewer = await createTestUser({ preset: "Viewer" });
    const stream = await openStream(viewer.token);

    publish({
      organizationId: testOrgId,
      action: "permission_change",
      resourceType: "permission",
      resourceId: viewer.userId,
      userId: admin.userId,
    });

    expect(await stream.next()).toMatchObject({
      action: "permission_change",
      resourceId: viewer.userId,
    });

    await stream.close();
  });

  it("delivers another account's change only to a reader of that subject", async () => {
    const admin = await createTestUser({ preset: "Admin" });
    const other = await createTestUser({ preset: "Viewer" });
    const stream = await openStream(admin.token);

    publish({
      organizationId: testOrgId,
      action: "user_disable",
      resourceType: "user",
      resourceId: other.userId,
      userId: admin.userId,
    });

    expect(await stream.next()).toMatchObject({ resourceId: other.userId });

    await stream.close();
  });

  // The audit rows spell the resource two ways: projects write "Project" and
  // the archive writes "project". Both must reach the same readers.
  it("folds case on the resource type", async () => {
    const viewer = await createTestUser({ preset: "Viewer" });
    const stream = await openStream(viewer.token);

    publish({
      organizationId: testOrgId,
      action: "create",
      resourceType: "Project",
      resourceId: "9",
      userId: null,
    });

    expect(await stream.next()).toMatchObject({ resourceType: "Project", resourceId: "9" });

    await stream.close();
  });

  // A stream outlives a request, so the rights are read per event.
  it("stops delivering what a revoke took away, without a reconnect", async () => {
    const user = await createTestUser({ preset: "Viewer" });
    const stream = await openStream(user.token);

    publish({
      organizationId: testOrgId,
      action: "modify",
      resourceType: "project",
      resourceId: "6",
      userId: null,
    });
    expect(await stream.next()).toMatchObject({ resourceId: "6" });

    // revoke every row mid-stream
    await testDb.delete(userPermission).where(eq(userPermission.userId, user.userId));

    publish({
      organizationId: testOrgId,
      action: "modify",
      resourceType: "project",
      resourceId: "7",
      userId: null,
    });
    await stream.silence();

    await stream.close();
  });

  // The wiring the feature exists for: a real write through a route lands on
  // the stream, because the write that audits is the write that publishes.
  it("carries a change made through a route", async () => {
    const admin = await createTestUser({ preset: "Admin" });
    const app = appFor(testDb, projectRoutes, eventRoutes);
    const stream = await openStream(admin.token);

    const created = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { ...bearer(admin.token), "content-type": "application/json" },
      body: JSON.stringify({ title: "Streamed project" }),
    });
    expect(created.status).toBe(201);

    expect(await stream.next()).toMatchObject({
      organizationId: testOrgId,
      action: "create",
      // the project service audits "Project", not "project"
      resourceType: "Project",
      userId: admin.userId,
    });

    await stream.close();
  });

  // The end-to-end claim: an admin changes a user's rights, and that user's
  // open stream hears about it without a reconnect or a refresh.
  it("carries a permission change to the account it concerns", async () => {
    const admin = await createTestUser({ preset: "Admin" });
    const viewer = await createTestUser({ preset: "Viewer" });
    const app = appFor(testDb, userRoutes, eventRoutes);
    const stream = await openStream(viewer.token);

    const changed = await app.request(`/api/v1/users/${viewer.userId}/permissions`, {
      method: "PUT",
      headers: { ...bearer(admin.token), "content-type": "application/json" },
      body: JSON.stringify({ permissions: [{ action: "read", subject: "Project" }] }),
    });
    expect(changed.status).toBe(200);

    expect(await stream.next()).toMatchObject({
      action: "permission_change",
      resourceType: "Permission",
      resourceId: viewer.userId,
    });

    await stream.close();
  });

  it("unsubscribes when the client goes away", async () => {
    const user = await createTestUser({ preset: "Admin" });
    const before = subscriberCount();

    const stream = await openStream(user.token);
    expect(subscriberCount()).toBe(before + 1);

    await stream.close();
    // the abort listener runs on the server's next turn of the loop
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(subscriberCount()).toBe(before);
  });
});
