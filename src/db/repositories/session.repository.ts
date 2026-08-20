import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { session } from "../schema";

export const createSessionRecord = async (
  data: typeof session.$inferInsert,
  database: DbOrTx = db,
) => {
  const createdSessions = await database.insert(session).values(data).returning();

  return createdSessions[0] ?? null;
};

export const listSessionRecords = async (database: DbOrTx = db) =>
  database.query.session.findMany({
    where: isNull(session.archivedAt),
    orderBy: [asc(session.projectId), asc(session.sessionId)],
  });

export const listSessionRecordsByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
) =>
  database.query.session.findMany({
    where: and(eq(session.projectId, projectId), isNull(session.archivedAt)),
    orderBy: asc(session.sessionId),
  });

export const findSessionById = async (
  sessionId: number,
  database: DbOrTx = db,
) =>
  (await database.query.session.findFirst({
    where: eq(session.sessionId, sessionId),
  })) ?? null;

/**
 * Batched session lookup by id. Unfiltered by archived_at (matches findSessionById) —
 * used to resolve session names for sidebar reads regardless of archive state.
 */
export const listSessionRecordsByIds = async (
  sessionIds: number[],
  database: DbOrTx = db,
) => {
  if (sessionIds.length === 0) {
    return [];
  }

  return database.query.session.findMany({
    where: inArray(session.sessionId, sessionIds),
    orderBy: asc(session.sessionId),
  });
};

export const findSessionByProjectIdAndName = async (
  projectId: number,
  name: string,
  database: DbOrTx = db,
) =>
  (await database.query.session.findFirst({
    where: and(eq(session.projectId, projectId), eq(session.name, name)),
  })) ?? null;

export const updateSessionById = async (
  sessionId: number,
  data: Partial<typeof session.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updatedSessions = await database
    .update(session)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(session.sessionId, sessionId))
    .returning();

  return updatedSessions[0] ?? null;
};

export const deleteSessionById = async (
  sessionId: number,
  database: DbOrTx = db,
) => {
  const deletedSessions = await database
    .delete(session)
    .where(eq(session.sessionId, sessionId))
    .returning();

  return deletedSessions[0] ?? null;
};
