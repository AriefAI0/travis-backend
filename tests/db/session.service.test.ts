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
  deleteSession,
  getSessionById,
  getSessionByProjectIdAndName,
  listSessions,
  listSessionsByProjectId,
  updateSession,
} from "../../src/db/services/session.service";

describe("session.service", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  it("assigns display numbers as per-project max + 1", async () => {
    await testDb.insert(schema.project).values({ displayNumber: 1, projectId: 1, title: "Project One" });
    await testDb.insert(schema.project).values({ displayNumber: 2, projectId: 2, title: "Project Two" });

    const first = await createSession({ projectId: 1, name: "Run 1" }, testDb);
    const second = await createSession({ projectId: 1, name: "Run 2" }, testDb);
    const otherProject = await createSession({ projectId: 2, name: "Run A" }, testDb);

    expect(first).toMatchObject({ projectId: 1, displayNumber: 1 });
    expect(second).toMatchObject({ projectId: 1, displayNumber: 2 });
    // counters run per project, never globally
    expect(otherProject).toMatchObject({ projectId: 2, displayNumber: 1 });
  });

});
