import { eq } from "drizzle-orm";

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