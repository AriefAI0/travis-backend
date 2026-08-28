import { and, asc, eq } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { sessionItem } from "../schema";

export const createSessionItemRecord = async (
  data: typeof sessionItem.$inferInsert,
  database: DbOrTx = db,
) => {
  const createdSessionItems = await database
    .insert(sessionItem)
    .values(data)
    .returning();

  return createdSessionItems[0] ?? null;
};

export const listSessionItemRecords = async (database: DbOrTx = db) =>
  database.query.sessionItem.findMany({
    orderBy: [asc(sessionItem.sessionId), asc(sessionItem.sessionItemId)],
  });

export const listSessionItemRecordsBySessionId = async (
  sessionId: number,
  database: DbOrTx = db,
) =>
  database.query.sessionItem.findMany({
    where: eq(sessionItem.sessionId, sessionId),
    orderBy: asc(sessionItem.sessionItemId),
  });

export const listSessionItemRecordsByItemId = async (
  itemId: number,
  database: DbOrTx = db,
) =>
  database.query.sessionItem.findMany({
    where: eq(sessionItem.itemId, itemId),
    orderBy: asc(sessionItem.sessionItemId),
  });

export const findSessionItemById = async (
  sessionItemId: number,
  database: DbOrTx = db,
) =>
  (await database.query.sessionItem.findFirst({
    where: eq(sessionItem.sessionItemId, sessionItemId),
  })) ?? null;

export const findSessionItemBySessionIdAndItemId = async (
  sessionId: number,
  itemId: number,
  database: DbOrTx = db,
) =>
  (await database.query.sessionItem.findFirst({
    where: and(
      eq(sessionItem.sessionId, sessionId),
      eq(sessionItem.itemId, itemId),
    ),
  })) ?? null;

export const updateSessionItemById = async (
  sessionItemId: number,
  data: Partial<typeof sessionItem.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updatedSessionItems = await database
    .update(sessionItem)
    .set(data)
    .where(eq(sessionItem.sessionItemId, sessionItemId))
    .returning();

  return updatedSessionItems[0] ?? null;
};

export const deleteSessionItemById = async (
  sessionItemId: number,
  database: DbOrTx = db,
) => {
  const deletedSessionItems = await database
    .delete(sessionItem)
    .where(eq(sessionItem.sessionItemId, sessionItemId))
    .returning();

  return deletedSessionItems[0] ?? null;
};
