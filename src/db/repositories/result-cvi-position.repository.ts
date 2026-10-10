import { eq, inArray } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { resultCviPosition } from "../schema";

export type CreateResultCviPositionInput = {
  resultId: number;
  memberType: "chord" | "brace";
  clockPosition: string;
  utMm: number | null;
  findings: string | null;
  sortOrder: number;
};

export const createResultCviPosition = async (
  data: CreateResultCviPositionInput,
  database: DbOrTx = db,
) =>
  (await database
    .insert(resultCviPosition)
    .values(data)
    .returning())[0] ?? null;

export const getResultCviPositions = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  database.query.resultCviPosition.findMany({
    where: eq(resultCviPosition.resultId, resultId),
    orderBy: (position, { asc }) => [asc(position.sortOrder)],
  });

/** Batched CVI positions across many results (event-recorder summary). */
export const listResultCviPositionsByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, (typeof resultCviPosition.$inferSelect)[]>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultCviPosition)
    .where(inArray(resultCviPosition.resultId, resultIds))
    .orderBy(resultCviPosition.sortOrder);

  const grouped = new Map<number, (typeof resultCviPosition.$inferSelect)[]>();
  for (const row of rows) {
    const existing = grouped.get(row.resultId) ?? [];
    existing.push(row);
    grouped.set(row.resultId, existing);
  }

  return grouped;
};