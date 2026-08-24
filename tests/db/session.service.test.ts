import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";
import {
  createSession,
  createSessionItem,
  deleteSession,
  deleteSessionItem,
  getSessionById,
  getSessionByProjectIdAndName,
  getSessionItemById,
  getSessionItemBySessionIdAndItemId,
  listSessionItems,
  listSessionItemsByItemId,
  listSessionItemsBySessionId,
  listSessions,
  listSessionsByProjectId,
  updateSession,
  updateSessionItem,
} from "../../src/db/services/session.service";

describe("session.service", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  it("assigns display numbers as per-project max + 1", async () => {
    await testDb.insert(schema.project).values({ projectId: 1, title: "Project One" });
    await testDb.insert(schema.project).values({ projectId: 2, title: "Project Two" });

    const first = await createSession({ projectId: 1, name: "Run 1" }, testDb);
    const second = await createSession({ projectId: 1, name: "Run 2" }, testDb);
    const otherProject = await createSession({ projectId: 2, name: "Run A" }, testDb);

    expect(first).toMatchObject({ projectId: 1, displayNumber: 1 });
    expect(second).toMatchObject({ projectId: 1, displayNumber: 2 });
    // counters run per project, never globally
    expect(otherProject).toMatchObject({ projectId: 2, displayNumber: 1 });
  });

  it("supports CRUD for session and session item", async () => {
    await testDb.insert(schema.project).values({
      projectId: 1,
      title: "Project Alpha",
    });

    await testDb.insert(schema.asset).values({
      assetId: 1,
      projectId: 1,
      name: "Platform A",
    });

    await testDb.insert(schema.component).values({
      componentId: 10,
      assetId: 1,
      projectId: 1,
      name: "Jacket Leg",
    });

    await testDb.insert(schema.item).values({
      itemId: 100,
      componentId: 10,
      projectId: 1,
      assetId: 1,
      itemLabel: "JL-01",
      status: "pending",
    });

    const createdSession = await createSession(
      {
        projectId: 1,
        name: " Run 1 ",
      },
      testDb,
    );

    expect(createdSession).toMatchObject({
      projectId: 1,
      name: "Run 1",
    });
    expect(createdSession?.sessionId).toBeTypeOf("number");
    expect(createdSession?.createdAt).toBeInstanceOf(Date);
    expect(createdSession?.updatedAt).toBeInstanceOf(Date);

    expect(await listSessions(testDb)).toHaveLength(1);
    expect(await listSessionsByProjectId(1, testDb)).toHaveLength(1);
    expect(await getSessionById(createdSession!.sessionId, testDb)).toMatchObject({
      name: "Run 1",
    });
    expect(
      await getSessionByProjectIdAndName(1, " Run 1 ", testDb),
    ).toMatchObject({
      sessionId: createdSession!.sessionId,
    });

    const updatedSession = await updateSession(
      createdSession!.sessionId,
      {
        name: " Run 1 Updated ",
      },
      testDb,
    );

    expect(updatedSession).toMatchObject({
      sessionId: createdSession!.sessionId,
      name: "Run 1 Updated",
    });
    expect(updatedSession?.updatedAt).toBeInstanceOf(Date);

    const createdSessionItem = await createSessionItem(
      {
        sessionId: createdSession!.sessionId,
        itemId: 100,
      },
      testDb,
    );

    expect(createdSessionItem).toMatchObject({
      sessionId: createdSession!.sessionId,
      itemId: 100,
    });
    expect(createdSessionItem?.sessionItemId).toBeTypeOf("number");

    expect(await listSessionItems(testDb)).toHaveLength(1);
    expect(
      await listSessionItemsBySessionId(createdSession!.sessionId, testDb),
    ).toHaveLength(1);
    expect(await listSessionItemsByItemId(100, testDb)).toHaveLength(1);
    expect(
      await getSessionItemById(createdSessionItem!.sessionItemId, testDb),
    ).toMatchObject({
      itemId: 100,
    });
    expect(
      await getSessionItemBySessionIdAndItemId(createdSession!.sessionId, 100, testDb),
    ).toMatchObject({
      sessionItemId: createdSessionItem!.sessionItemId,
    });

    const updatedSessionItem = await updateSessionItem(
      createdSessionItem!.sessionItemId,
      {
        itemId: 100,
      },
      testDb,
    );

    expect(updatedSessionItem).toMatchObject({
      sessionItemId: createdSessionItem!.sessionItemId,
      itemId: 100,
    });

    expect(await deleteSessionItem(createdSessionItem!.sessionItemId, testDb)).toMatchObject({
      sessionItemId: createdSessionItem!.sessionItemId,
    });
    expect(await deleteSession(createdSession!.sessionId, testDb)).toMatchObject({
      sessionId: createdSession!.sessionId,
    });

    const remainingSession = await testDb.query.session.findFirst({
      where: eq(schema.session.sessionId, createdSession!.sessionId),
    });

    expect(remainingSession).toBeUndefined();
  });
});
