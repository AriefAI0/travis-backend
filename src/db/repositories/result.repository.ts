import { and, asc, desc, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";

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

/** Target reads: results pointing at one description. */
export const listResultRecordsByDescriptionId = async (
  descriptionId: number,
  database: DbOrTx = db,
) =>
  database.query.result.findMany({
    where: and(eq(result.descriptionId, descriptionId), isNull(result.archivedAt)),
    orderBy: asc(result.resultId),
  });

/** Target reads: results pointing at one part code. */
export const listResultRecordsByPartCodeId = async (
  partCodeId: number,
  database: DbOrTx = db,
) =>
  database.query.result.findMany({
    where: and(eq(result.partCodeId, partCodeId), isNull(result.archivedAt)),
    orderBy: asc(result.resultId),
  });

// A result points at a description OR a part code, so a target set is two lists.
// Null when neither list carries an id, so callers skip the query entirely.
const targetMatchesFor = (descriptionIds: number[], partCodeIds: number[]): SQL | null => {
  const matches: SQL[] = [];
  if (descriptionIds.length > 0) {
    matches.push(inArray(result.descriptionId, descriptionIds));
  }
  if (partCodeIds.length > 0) {
    matches.push(inArray(result.partCodeId, partCodeIds));
  }
  return matches.length > 0 ? or(...matches)! : null;
};

/** Target reads: results pointing at any of the given targets, oldest-first. */
export const listResultRecordsByTargetIds = async (
  descriptionIds: number[],
  partCodeIds: number[],
  database: DbOrTx = db,
) => {
  const targetMatch = targetMatchesFor(descriptionIds, partCodeIds);
  if (!targetMatch) return [];

  return database.query.result.findMany({
    where: and(targetMatch, isNull(result.archivedAt)),
    orderBy: asc(result.resultId),
  });
};

/**
 * Every row the target set owns, archived included: these are the rows a
 * cascade removes, so their media keys must be collected before the delete.
 */
export const listAllResultRecordsByTargetIds = async (
  descriptionIds: number[],
  partCodeIds: number[],
  database: DbOrTx = db,
) => {
  const targetMatch = targetMatchesFor(descriptionIds, partCodeIds);
  if (!targetMatch) return [];

  return database.query.result.findMany({
    where: targetMatch,
    orderBy: asc(result.resultId),
  });
};

/** Live inspections under the target set: started (layer set) and not stopped. */
export const listOpenResultRecordsByTargetIds = async (
  descriptionIds: number[],
  partCodeIds: number[],
  database: DbOrTx = db,
) => {
  const targetMatch = targetMatchesFor(descriptionIds, partCodeIds);
  if (!targetMatch) return [];

  return database.query.result.findMany({
    where: and(targetMatch, isNotNull(result.layer), isNull(result.masterEndMs)),
    orderBy: asc(result.resultId),
  });
};

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

/** Restricted-access marks for a project: is_ra rows only, oldest-first. */
export const listRestrictedAccessRecordsByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
) =>
  database.query.result.findMany({
    where: and(eq(result.projectId, projectId), eq(result.isRa, true), isNull(result.archivedAt)),
    orderBy: asc(result.resultId),
  });

/** Unmark restricted access: deletes only is_ra rows, never a real result. */
export const deleteRestrictedAccessById = async (
  resultId: number,
  database: DbOrTx = db,
) => {
  const deletedResults = await database
    .delete(result)
    .where(and(eq(result.resultId, resultId), eq(result.isRa, true)))
    .returning();

  return deletedResults[0] ?? null;
};
