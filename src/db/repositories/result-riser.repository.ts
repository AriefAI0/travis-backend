
import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultRiser } from "../schema";

export type CreateResultRiserInput = {
  resultId: number;
  touchdownDistanceFromRiserBend: string | null;
  riserBendDistanceToMudbraceMember: string | null;
  riserBendHeightToSeabed: string | null;
  coatingStatus: "present" | "not-present" | null;
  coatingCondition: "good" | "peel-off" | null;
  kneeBrace: "yes" | "no" | null;
  debris: "yes" | "no" | null;
  debrisType: string;
  anomaly: "yes" | "no" | null;
  recommendation: string;
  restrictedAccess: "yes" | "no" | null;
};

export const createResultRiser = async (
  data: CreateResultRiserInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultRiser).values(data).returning())[0] ?? null;

export const getResultRiserByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database
    .select()
    .from(resultRiser)
    .where(eq(resultRiser.resultId, resultId))
    .limit(1))[0] ?? null;

/** Batched RISER details across many results (event-recorder summary). */
export const listResultRiserByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultRiser.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultRiser)
    .where(inArray(resultRiser.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultRiser = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database
    .delete(resultRiser)
    .where(eq(resultRiser.resultId, resultId))
    .returning();

  return rows.length > 0;
};
