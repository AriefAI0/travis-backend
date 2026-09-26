import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { recordingIngest, session } from "../schema";

export const createSessionRecord = async (
  data: typeof session.$inferInsert,
  database: DbOrTx = db,
) => {
  const createdSessions = await database.insert(session).values(data).returning();

  return createdSessions[0] ?? null;
};

// highest assigned display number in a project; races on max+1 are caught by
// the uniq (project_id, display_number) index and retried by the caller
export const maxSessionDisplayNumberByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
) => {
  const rows = await database
    .select({ displayNumber: session.displayNumber })
    .from(session)
    .where(and(eq(session.projectId, projectId), isNotNull(session.displayNumber)))
    .orderBy(desc(session.displayNumber))
    .limit(1);

  return rows[0]?.displayNumber ?? null;
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

/* ---- master-recording reads (the session IS the master recording) ---- */

export type SessionRecordingRow = {
  sessionId: number;
  sessionName: string | null;
  sessionDisplayNumber: number;
  startEpoch: number | null;
  endEpoch: number | null;
  durationMs: number | null;
};

// recording cards: sessions that captured a master (start stamped)
export const listSessionRecordingRowsByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
): Promise<SessionRecordingRow[]> =>
  database
    .select({
      sessionId: session.sessionId,
      sessionName: session.name,
      sessionDisplayNumber: session.displayNumber,
      startEpoch: session.startEpoch,
      endEpoch: session.endEpoch,
      durationMs: session.durationMs,
    })
    .from(session)
    .where(and(eq(session.projectId, projectId), isNotNull(session.startEpoch)))
    .orderBy(asc(session.startEpoch), asc(session.sessionId));

// sessions whose master ingest is still open on the wire
export const listSessionsWithOpenIngest = async (
  database: DbOrTx = db,
): Promise<Omit<SessionRecordingRow, "sessionName" | "sessionDisplayNumber">[]> =>
  database
    .selectDistinct({
      sessionId: session.sessionId,
      startEpoch: session.startEpoch,
      endEpoch: session.endEpoch,
      durationMs: session.durationMs,
    })
    .from(session)
    .innerJoin(
      recordingIngest,
      and(eq(recordingIngest.sessionId, session.sessionId), eq(recordingIngest.kind, "master")),
    )
    .where(isNull(recordingIngest.closedAt))
    .orderBy(asc(session.sessionId));

// The master a session is capturing right now: its master ingest is open.
// An inspection may only start against a session in this state.
export const findSessionWithOpenIngestBySessionId = async (
  sessionId: number,
  database: DbOrTx = db,
): Promise<{ sessionId: number; startEpoch: number | null; endEpoch: number | null; durationMs: number | null } | null> =>
  (
    await database
      .select({
        sessionId: session.sessionId,
        startEpoch: session.startEpoch,
        endEpoch: session.endEpoch,
        durationMs: session.durationMs,
      })
      .from(session)
      .innerJoin(
        recordingIngest,
        and(
          eq(recordingIngest.sessionId, session.sessionId),
          eq(recordingIngest.kind, "master"),
        ),
      )
      .where(and(eq(session.sessionId, sessionId), isNull(recordingIngest.closedAt)))
      .orderBy(asc(session.sessionId))
      .limit(1)
  )[0] ?? null;
