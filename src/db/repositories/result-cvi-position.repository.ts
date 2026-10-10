import { eq } from "drizzle-orm";

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