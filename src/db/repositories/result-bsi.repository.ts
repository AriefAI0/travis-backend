import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import {
  resultBsi,
  resultBsiClampMissingBolt,
  resultBsiClampMissingWasher,
  resultBsiHingeMissingBolt,
  resultBsiHingeMissingWasher,
} from "../schema";

export type CreateResultBsiInput = typeof resultBsi.$inferInsert;

// the four missing-part tables share one column shape
type MissingPartTable =
  | typeof resultBsiClampMissingBolt
  | typeof resultBsiClampMissingWasher
  | typeof resultBsiHingeMissingBolt
  | typeof resultBsiHingeMissingWasher;

export type BsiMissingPartInsert = {
  resultId: number;
  position: string;
  sortOrder: number;
};

export const createResultBsi = async (
  data: CreateResultBsiInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultBsi).values(data).returning())[0] ?? null;

// insert one missing-part list; empty list writes nothing
export const createBsiMissingParts = async (
  table: MissingPartTable,
  rows: BsiMissingPartInsert[],
  database: DbOrTx = db,
): Promise<void> => {
  if (rows.length === 0) {
    return;
  }
  await database.insert(table).values(rows);
};

export const getResultBsiByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database.select().from(resultBsi).where(eq(resultBsi.resultId, resultId)).limit(1))[0] ??
  null;

// one missing-part list ordered as entered
export const listBsiMissingParts = async (
  table: MissingPartTable,
  resultId: number,
  database: DbOrTx = db,
) =>
  database
    .select()
    .from(table)
    .where(eq(table.resultId, resultId))
    .orderBy(table.sortOrder);

/** Batched BSI detail across many results (event-recorder summary). */
export const listResultBsiByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultBsi.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultBsi)
    .where(inArray(resultBsi.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultBsi = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database.delete(resultBsi).where(eq(resultBsi.resultId, resultId)).returning();
  return rows.length > 0;
};
