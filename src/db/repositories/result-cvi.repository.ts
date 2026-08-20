import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultCvi } from "../schema";

export type CreateResultCviInput = {
  resultId: number;
  datumReference: string | null;
  memberType: "chord" | "brace";
  cpPotentialMv: number | null;
};

export const createResultCvi = async (
  data: CreateResultCviInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultCvi).values(data).returning())[0] ?? null;

export const getResultCviByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database.select().from(resultCvi).where(eq(resultCvi.resultId, resultId)).limit(1))[0] ??
  null;

/** Batched CVI detail across many results (event-recorder summary). */
export const listResultCviByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultCvi.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultCvi)
    .where(inArray(resultCvi.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultCvi = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database.delete(resultCvi).where(eq(resultCvi.resultId, resultId)).returning();
  return rows.length > 0;
};
