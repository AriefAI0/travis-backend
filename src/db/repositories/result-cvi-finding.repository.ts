import { eq, inArray } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { resultCviFinding } from "../schema";

export type CreateResultCviFindingInput = {
  resultId: number;
  value: number | null;
  remark: string | null;
  sortOrder: number;
};

export const createResultCviFinding = async (
  data: CreateResultCviFindingInput,
  database: DbOrTx = db,
) =>
  (await database
    .insert(resultCviFinding)
    .values(data)
    .returning())[0] ?? null;

export const listResultCviFindingsByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  database.query.resultCviFinding.findMany({
    where: eq(resultCviFinding.resultId, resultId),
    orderBy: (finding, { asc }) => [asc(finding.sortOrder)],
  });

/** Batched CVI CP findings across many results (event-recorder summary). */
export const listResultCviFindingsByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, (typeof resultCviFinding.$inferSelect)[]>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultCviFinding)
    .where(inArray(resultCviFinding.resultId, resultIds))
    .orderBy(resultCviFinding.sortOrder);

  const grouped = new Map<number, (typeof resultCviFinding.$inferSelect)[]>();
  for (const row of rows) {
    const existing = grouped.get(row.resultId) ?? [];
    existing.push(row);
    grouped.set(row.resultId, existing);
  }

  return grouped;
};

export const deleteResultCviFindingsByResultId = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database
    .delete(resultCviFinding)
    .where(eq(resultCviFinding.resultId, resultId))
    .returning();

  return rows.length > 0;
};