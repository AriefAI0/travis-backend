import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultDvi } from "../schema";

export type CreateResultDviInput = {
  resultId: number;
  datumReference: string | null;
  memberType: "chord" | "brace";
  cpPotentialMv: number | null;
};

export const createResultDvi = async (
  data: CreateResultDviInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultDvi).values(data).returning())[0] ?? null;

export const getResultDviByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database.select().from(resultDvi).where(eq(resultDvi.resultId, resultId)).limit(1))[0] ??
  null;

/** Batched DVI detail across many results (event-recorder summary). */
export const listResultDviByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultDvi.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultDvi)
    .where(inArray(resultDvi.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultDvi = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database.delete(resultDvi).where(eq(resultDvi.resultId, resultId)).returning();
  return rows.length > 0;
};
