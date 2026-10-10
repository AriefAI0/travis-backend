
import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultCi, resultCiCpFinding } from "../schema";

/* =========================================================
   Types
   ========================================================= */

export type CreateResultCiInput = {
  resultId: number;
  visualDamage: boolean | null;
  visualDamageRecommendation: string;
  debrisPresent: boolean | null;
  debrisRecommendation: string;
  gratingPresent: boolean | null;
  gratingBlockage: "0_25" | "25_50" | "50_75" | "75_100" | null;
  gratingAnomalyRecommendation: string;
};

export type CreateResultCiCpFindingInput = {
  resultId: number;
  cpMv: string | null;
  remarks: string;
};

/* =========================================================
   CAISSON parent record
   ========================================================= */

export const createResultCi = async (
  data: CreateResultCiInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultCi).values(data).returning())[0] ?? null;

export const getResultCiByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database
    .select()
    .from(resultCi)
    .where(eq(resultCi.resultId, resultId))
    .limit(1))[0] ?? null;

/** Batched CAISSON parent records for result summaries. */
export const listResultCiByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultCi.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultCi)
    .where(inArray(resultCi.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultCi = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database
    .delete(resultCi)
    .where(eq(resultCi.resultId, resultId))
    .returning();

  return rows.length > 0;
};

/* =========================================================
   CAISSON CP findings
   ========================================================= */

export const createResultCiCpFinding = async (
  data: CreateResultCiCpFindingInput,
  database: DbOrTx = db,
) =>
  (
    await database
      .insert(resultCiCpFinding)
      .values(data)
      .returning()
  )[0] ?? null;

export const listResultCiCpFindingsByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  database
    .select()
    .from(resultCiCpFinding)
    .where(eq(resultCiCpFinding.resultId, resultId))
    .orderBy(resultCiCpFinding.findingId);

export const listResultCiCpFindingsByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, (typeof resultCiCpFinding.$inferSelect)[]>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultCiCpFinding)
    .where(inArray(resultCiCpFinding.resultId, resultIds))
    .orderBy(resultCiCpFinding.findingId);

  const grouped = new Map<
    number,
    (typeof resultCiCpFinding.$inferSelect)[]
  >();

  for (const row of rows) {
    const existing = grouped.get(row.resultId) ?? [];
    existing.push(row);
    grouped.set(row.resultId, existing);
  }

  return grouped;
};

export const deleteResultCiCpFindingsByResultId = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<number> => {
  const rows = await database
    .delete(resultCiCpFinding)
    .where(eq(resultCiCpFinding.resultId, resultId))
    .returning();

  return rows.length;
};
