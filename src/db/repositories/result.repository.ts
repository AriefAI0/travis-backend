import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { result } from "../schema";

export const createResultRecord = async (
  data: typeof result.$inferInsert,
  database: DbOrTx = db,
) => {
  const createdResults = await database.insert(result).values(data).returning();

  return createdResults[0] ?? null;
};

// highest assigned ordinal in one session; archived rows keep their number, so
// they count. Races on max+1 are caught by the uniq index and retried.
export const maxResultDisplayNumberBySessionId = async (
  sessionId: number,
  database: DbOrTx = db,
) => {
  const rows = await database
    .select({ displayNumber: result.displayNumber })
    .from(result)
    .where(and(eq(result.sessionId, sessionId), isNotNull(result.displayNumber)))
    .orderBy(desc(result.displayNumber))
    .limit(1);

  return rows[0]?.displayNumber ?? null;
};

export const listResultRecords = async (database: DbOrTx = db) =>
  database.query.result.findMany({
    where: isNull(result.archivedAt),
    orderBy: asc(result.resultId),
  });

/**
 * All non-archived results for a project, newest-first. createdAt is stored at
 * second resolution, so resultId desc is the tiebreak to keep same-second
 * submissions ordered by submission order. (Event-recorder table.)
 */
export const listResultRecordsByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
) =>
  database.query.result.findMany({
    where: and(eq(result.projectId, projectId), isNull(result.archivedAt)),
    orderBy: [desc(result.createdAt), desc(result.resultId)],
  });

export const findResultById = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database.query.result.findFirst({
    where: eq(result.resultId, resultId),
  })) ?? null;

/** Active results of one whole session (open-inspection listing). */
export const listResultRecordsBySessionId = async (
  sessionId: number,
  database: DbOrTx = db,
) =>
  database.query.result.findMany({
    where: and(eq(result.sessionId, sessionId), isNull(result.archivedAt)),
    orderBy: asc(result.resultId),
  });

/** v2 target reads: results pointing at one main component. */
export const listResultRecordsByMainComponentId = async (
  mainComponentId: number,
  database: DbOrTx = db,
) =>
  database.query.result.findMany({
    where: and(eq(result.mainComponentId, mainComponentId), isNull(result.archivedAt)),
    orderBy: asc(result.resultId),
  });

/** v2 target reads: results pointing at one component code. */
export const listResultRecordsByComponentCodeId = async (
  componentCodeId: number,
  database: DbOrTx = db,
) =>
  database.query.result.findMany({
    where: and(eq(result.componentCodeId, componentCodeId), isNull(result.archivedAt)),
    orderBy: asc(result.resultId),
  });

export const updateResultById = async (
  resultId: number,
  data: Partial<typeof result.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updatedResults = await database
    .update(result)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(result.resultId, resultId))
    .returning();

  return updatedResults[0] ?? null;
};

export const deleteResultById = async (
  resultId: number,
  database: DbOrTx = db,
) => {
  const deletedResults = await database
    .delete(result)
    .where(eq(result.resultId, resultId))
    .returning();

  return deletedResults[0] ?? null;
};
