
import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultGviFinding } from "../schema";

export type CreateResultGviFindingInput = {
  resultGviId: number;
  value?: number | null;
  remark?: string | null;
  sortOrder?: number;
};

export const createResultGviFinding = async (
  data: CreateResultGviFindingInput,
  database: DbOrTx = db,
) =>
  (await database
    .insert(resultGviFinding)
    .values(data)
    .returning())[0] ?? null;

export const listResultGviFindingsByResultGviId = async (
  resultGviId: number,
  database: DbOrTx = db,
) =>
  await database
    .select()
    .from(resultGviFinding)
    .where(eq(resultGviFinding.resultGviId, resultGviId))
    .orderBy(resultGviFinding.sortOrder);

export const getResultGviFindingById = async (
  findingId: number,
  database: DbOrTx = db,
) =>
  (await database
    .select()
    .from(resultGviFinding)
    .where(eq(resultGviFinding.findingId, findingId))
    .limit(1))[0] ?? null;

export const updateResultGviFinding = async (
  findingId: number,
  data: Partial<CreateResultGviFindingInput>,
  database: DbOrTx = db,
) =>
  (await database
    .update(resultGviFinding)
    .set(data)
    .where(eq(resultGviFinding.findingId, findingId))
    .returning())[0] ?? null;

export const deleteResultGviFinding = async (
  findingId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database
    .delete(resultGviFinding)
    .where(eq(resultGviFinding.findingId, findingId))
    .returning();

  return rows.length > 0;
};
