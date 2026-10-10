import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultCgb } from "../schema";

export type CreateResultCgbInput = {
  resultId: number;
  movement: "yes" | "no" | null;
  remark: string | null;
  debris: "yes" | "no" | null;
  debrisType: string | null;
};

export const createResultCgb = async (
  data: CreateResultCgbInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultCgb).values(data).returning())[0] ?? null;

export const getResultCgbByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database
    .select()
    .from(resultCgb)
    .where(eq(resultCgb.resultId, resultId))
    .limit(1))[0] ?? null;

/** Batched CGB detail across many results (event-recorder summary). */
export const listResultCgbByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultCgb.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultCgb)
    .where(inArray(resultCgb.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultCgb = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database
    .delete(resultCgb)
    .where(eq(resultCgb.resultId, resultId))
    .returning();

  return rows.length > 0;
};