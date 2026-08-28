import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultCp } from "../schema";

export type CreateResultCpInput = {
  resultId: number;
  anodeType?: string | null;
  voltageMv?: number | null;
  depletion?: string | null;
  anodeWidth?: number | null;
  anodeHeight?: number | null;
  anodeLength?: number | null;
  widestPit?: number | null;
  deepestPit?: number | null;
};

export const createResultCp = async (
  data: CreateResultCpInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultCp).values(data).returning())[0] ?? null;

export const getResultCpByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database.select().from(resultCp).where(eq(resultCp.resultId, resultId)).limit(1))[0] ??
  null;

/** Batched CP detail across many results (event-recorder summary). */
export const listResultCpByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultCp.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultCp)
    .where(inArray(resultCp.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultCp = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database.delete(resultCp).where(eq(resultCp.resultId, resultId)).returning();
  return rows.length > 0;
};
