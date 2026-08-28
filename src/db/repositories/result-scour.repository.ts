import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultScour } from "../schema";

export type CreateResultScourInput = {
  resultId: number;
  exposedPile: "exposed" | "not_exposed";
  exposedPileHeight: number | null;
  heightLeg1: number | null;
  heightMidpoint: number | null;
  heightLeg2: number | null;
};

export const createResultScour = async (
  data: CreateResultScourInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultScour).values(data).returning())[0] ?? null;

export const getResultScourByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database.select().from(resultScour).where(eq(resultScour.resultId, resultId)).limit(1))[0] ??
  null;

/** Batched Scour detail across many results (event-recorder summary). */
export const listResultScourByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultScour.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultScour)
    .where(inArray(resultScour.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultScour = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database.delete(resultScour).where(eq(resultScour.resultId, resultId)).returning();
  return rows.length > 0;
};
