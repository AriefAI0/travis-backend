
import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultGviMgi, resultGviMgiFinding } from "../schema";

export type CreateResultGviMgiInput = {
  resultId: number;
};

export type CreateResultGviMgiFindingInput = {
  resultGviMgiId: number;
  depth?: number | null;
  softCoveragePercent?: number | null;
  hardCoveragePercent?: number | null;
  remarks?: string | null;
  sortOrder?: number;
};

export const createResultGviMgi = async (
  data: CreateResultGviMgiInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultGviMgi).values(data).returning())[0] ?? null;

export const getResultGviMgiByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database
    .select()
    .from(resultGviMgi)
    .where(eq(resultGviMgi.resultId, resultId))
    .limit(1))[0] ?? null;

export const deleteResultGviMgi = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database
    .delete(resultGviMgi)
    .where(eq(resultGviMgi.resultId, resultId))
    .returning();

  return rows.length > 0;
};

export const createResultGviMgiFinding = async (
  data: CreateResultGviMgiFindingInput,
  database: DbOrTx = db,
) =>
  (await database
    .insert(resultGviMgiFinding)
    .values(data)
    .returning())[0] ?? null;

export const listResultGviMgiFindingsByResultGviMgiId = async (
  resultGviMgiId: number,
  database: DbOrTx = db,
) =>
  await database
    .select()
    .from(resultGviMgiFinding)
    .where(eq(resultGviMgiFinding.resultGviMgiId, resultGviMgiId))
    .orderBy(resultGviMgiFinding.sortOrder);

export const updateResultGviMgiFinding = async (
  findingId: number,
  data: Partial<CreateResultGviMgiFindingInput>,
  database: DbOrTx = db,
) =>
  (await database
    .update(resultGviMgiFinding)
    .set(data)
    .where(eq(resultGviMgiFinding.findingId, findingId))
    .returning())[0] ?? null;

export const deleteResultGviMgiFinding = async (
  findingId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database
    .delete(resultGviMgiFinding)
    .where(eq(resultGviMgiFinding.findingId, findingId))
    .returning();

  return rows.length > 0;
};
