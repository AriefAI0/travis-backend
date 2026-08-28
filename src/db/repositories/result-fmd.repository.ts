import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultFmd } from "../schema";

export type CreateResultFmdInput = {
  resultId: number;
  depthEl: number | null;
  initialAttempt: "dry" | "flooded" | "na"
  additionalAttempt1: "dry" | "flooded" | "na"
  additionalAttempt2: "dry" | "flooded" | "na"
  additionalAttempt3: "dry" | "flooded" | "na"
};

export const createResultFmd = async (
  data: CreateResultFmdInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultFmd).values(data).returning())[0] ?? null;

export const getResultFmdByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database.select().from(resultFmd).where(eq(resultFmd.resultId, resultId)).limit(1))[0] ??
  null;

/** Batched FMD detail across many results (event-recorder summary). */
export const listResultFmdByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultFmd.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultFmd)
    .where(inArray(resultFmd.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultFmd = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database.delete(resultFmd).where(eq(resultFmd.resultId, resultId)).returning();
  return rows.length > 0;
};
