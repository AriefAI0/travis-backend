import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultGvi } from "../schema";

export type CreateResultGviInput = {
  resultId: number;
  kpRange?: string | null;
  depthEl?: number | null;
  gviCP?: number | null;
  gviUT?: number | null;
  condition: "ok" | "not_ok";
};

export const createResultGvi = async (
  data: CreateResultGviInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultGvi).values(data).returning())[0] ?? null;

export const getResultGviByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database.select().from(resultGvi).where(eq(resultGvi.resultId, resultId)).limit(1))[0] ??
  null;

/** Batched GVI detail across many results (event-recorder summary). */
export const listResultGviByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultGvi.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultGvi)
    .where(inArray(resultGvi.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultGvi = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database.delete(resultGvi).where(eq(resultGvi.resultId, resultId)).returning();
  return rows.length > 0;
};
