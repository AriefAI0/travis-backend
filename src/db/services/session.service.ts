import type { DbOrTx } from "../client";
import {
  createSessionRecord,
  deleteSessionById,
  findSessionById,
  findSessionByProjectIdAndName,
  listSessionRecords,
  listSessionRecordsByIds,
  listSessionRecordsByProjectId,
  maxSessionDisplayNumberByProjectId,
  updateSessionById,
} from "../repositories/session.repository";
import {
  createSessionItemRecord,
  deleteSessionItemById,
  findSessionItemById,
  findSessionItemBySessionIdAndItemId,
  listSessionItemRecords,
  listSessionItemRecordsByItemId,
  listSessionItemRecordsBySessionId,
  updateSessionItemById,
} from "../repositories/session-item.repository";
import { session, sessionItem } from "../schema";

export type CreateSessionInput = {
  projectId: number;
  name?: string | null;
};

export type CreateSessionItemInput = {
  sessionId: number;
  itemId: number;
};

const normalizeOptionalText = (value?: string | null) => {
  const trimmedValue = value?.trim();

  return trimmedValue ? trimmedValue : null;
};

const normalizeSessionUpdate = (
  data: Partial<typeof session.$inferInsert>,
): Partial<typeof session.$inferInsert> => {
  const nextData: Partial<typeof session.$inferInsert> = {};

  if ("projectId" in data) {
    nextData.projectId = data.projectId;
  }

  if ("name" in data) {
    nextData.name = normalizeOptionalText(data.name);
  }

  return nextData;
};

// display number: one more than the project's current max (spec). Concurrent
// inserts race on max+1; the uniq (project_id, display_number) index rejects
// the loser, which retries with a fresh max. A caller-supplied transaction
// gets a single attempt — a failed statement aborts that transaction.
export const createSession = async (
  data: CreateSessionInput,
  database?: DbOrTx,
) => {
  const insertOnce = async (dbOrTx?: DbOrTx) => {
    const max =
      await maxSessionDisplayNumberByProjectId(data.projectId, dbOrTx);

    return createSessionRecord(
      {
        projectId: data.projectId,
        name: normalizeOptionalText(data.name),
        displayNumber: (max ?? 0) + 1,
      },
      dbOrTx,
    );
  };

  if (database) {
    return insertOnce(database);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await insertOnce();
    } catch (err) {
      const lostRace =
        attempt < 2 && String(err).includes("uniq_session_project_display");
      if (!lostRace) throw err;
    }
  }
};

export const listSessions = async (database?: DbOrTx) =>
  listSessionRecords(database);

export const listSessionsByProjectId = async (
  projectId: number,
  database?: DbOrTx,
) => listSessionRecordsByProjectId(projectId, database);

export const listSessionsByIds = async (
  sessionIds: number[],
  database?: DbOrTx,
) => listSessionRecordsByIds(sessionIds, database);

export const getSessionById = async (
  sessionId: number,
  database?: DbOrTx,
) => findSessionById(sessionId, database);

export const getSessionByProjectIdAndName = async (
  projectId: number,
  name: string,
  database?: DbOrTx,
) => {
  const normalizedName = normalizeOptionalText(name);

  if (normalizedName === null) {
    return null;
  }

  return findSessionByProjectIdAndName(projectId, normalizedName, database);
};

export const updateSession = async (
  sessionId: number,
  data: Partial<typeof session.$inferInsert>,
  database?: DbOrTx,
) => updateSessionById(sessionId, normalizeSessionUpdate(data), database);

export const deleteSession = async (
  sessionId: number,
  database?: DbOrTx,
) => deleteSessionById(sessionId, database);

export const createSessionItem = async (
  data: CreateSessionItemInput,
  database?: DbOrTx,
) =>
  createSessionItemRecord(
    {
      sessionId: data.sessionId,
      itemId: data.itemId,
    },
    database,
  );

export const listSessionItems = async (database?: DbOrTx) =>
  listSessionItemRecords(database);

export const listSessionItemsBySessionId = async (
  sessionId: number,
  database?: DbOrTx,
) => listSessionItemRecordsBySessionId(sessionId, database);

export const listSessionItemsByItemId = async (
  itemId: number,
  database?: DbOrTx,
) => listSessionItemRecordsByItemId(itemId, database);

export const getSessionItemById = async (
  sessionItemId: number,
  database?: DbOrTx,
) => findSessionItemById(sessionItemId, database);

export const getSessionItemBySessionIdAndItemId = async (
  sessionId: number,
  itemId: number,
  database?: DbOrTx,
) => findSessionItemBySessionIdAndItemId(sessionId, itemId, database);

export const updateSessionItem = async (
  sessionItemId: number,
  data: Partial<typeof sessionItem.$inferInsert>,
  database?: DbOrTx,
) => updateSessionItemById(sessionItemId, data, database);

export const deleteSessionItem = async (
  sessionItemId: number,
  database?: DbOrTx,
) => deleteSessionItemById(sessionItemId, database);
