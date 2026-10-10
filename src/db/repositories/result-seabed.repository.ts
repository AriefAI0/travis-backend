
import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultSeabed, resultSeabedFinding } from "../schema";

/* =========================================================
   Types
   ========================================================= */

export type CreateResultSeabedFindingInput = {
  resultId: number;
  rangeMeters: string | null;
  fixes: string;
  debris: "yes" | "no" | null;
  debrisType: string;
};

/* =========================================================
   SEABED parent record
   ========================================================= */

export const createResultSeabed = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (
    await database
      .insert(resultSeabed)
      .values({ resultId })
      .returning()
  )[0] ?? null;

export const getResultSeabedByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (
    await database
      .select()
      .from(resultSeabed)
      .where(eq(resultSeabed.resultId, resultId))
      .limit(1)
  )[0] ?? null;

export const listResultSeabedByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultSeabed.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultSeabed)
    .where(inArray(resultSeabed.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultSeabed = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database
    .delete(resultSeabed)
    .where(eq(resultSeabed.resultId, resultId))
    .returning();

  return rows.length > 0;
};

/* =========================================================
   SEABED findings
   ========================================================= */

export const createResultSeabedFinding = async (
  data: CreateResultSeabedFindingInput,
  database: DbOrTx = db,
) =>
  (
    await database
      .insert(resultSeabedFinding)
      .values(data)
      .returning()
  )[0] ?? null;

export const listResultSeabedFindingsByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  database
    .select()
    .from(resultSeabedFinding)
    .where(eq(resultSeabedFinding.resultId, resultId))
    .orderBy(resultSeabedFinding.findingId);

export const listResultSeabedFindingsByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<
  Map<number, (typeof resultSeabedFinding.$inferSelect)[]>
> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultSeabedFinding)
    .where(inArray(resultSeabedFinding.resultId, resultIds))
    .orderBy(resultSeabedFinding.findingId);

  const grouped = new Map<
    number,
    (typeof resultSeabedFinding.$inferSelect)[]
  >();

  for (const row of rows) {
    const existing = grouped.get(row.resultId) ?? [];
    existing.push(row);
    grouped.set(row.resultId, existing);
  }

  return grouped;
};

export const deleteResultSeabedFindingsByResultId = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<number> => {
  const rows = await database
    .delete(resultSeabedFinding)
    .where(eq(resultSeabedFinding.resultId, resultId))
    .returning();

  return rows.length;
};
