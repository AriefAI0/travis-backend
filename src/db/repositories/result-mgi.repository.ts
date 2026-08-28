import { count, eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { resultMgi, resultMgiFinding } from "../schema";

export type CreateResultMgiInput = {
  resultId: number;
  noMgObserved: number;
  criteriaPreset?: "project_default" | "client_cnc" | "manual" | null;
};

export type CreateResultMgiFindingInput = {
  resultMgiId: number;
  growthType: "soft" | "hard";
  species: string;
  speciesOtherText?: string | null;
  coveragePercent?: number | null;
  thicknessMm?: number | null;
  remarks?: string | null;
  sortOrder?: number;
};

export const createResultMgi = async (
  data: CreateResultMgiInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultMgi).values(data).returning())[0] ?? null;

export const getResultMgiByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (await database.select().from(resultMgi).where(eq(resultMgi.resultId, resultId)).limit(1))[0] ?? null;

export type ResultMgiSummary = {
  resultId: number;
  noMgObserved: number;
  findingCount: number;
};

/**
 * Batched MGI summary across many results (event-recorder summary): the no-MG flag
 * plus a finding count, from a single LEFT JOIN + GROUP BY. result_mgi.resultId is
 * the PK and equals result.resultId, and result_mgi_finding.result_mgi_id points at
 * it, so the finding count keys directly off the resultId.
 */
export const listResultMgiSummaryByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, ResultMgiSummary>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select({
      resultId: resultMgi.resultId,
      noMgObserved: resultMgi.noMgObserved,
      findingCount: count(resultMgiFinding.findingId),
    })
    .from(resultMgi)
    .leftJoin(resultMgiFinding, eq(resultMgiFinding.resultMgiId, resultMgi.resultId))
    .where(inArray(resultMgi.resultId, resultIds))
    .groupBy(resultMgi.resultId);

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const updateResultMgi = async (
  resultId: number,
  data: Partial<CreateResultMgiInput>,
  database: DbOrTx = db,
) =>
  (await database
    .update(resultMgi)
    .set(data)
    .where(eq(resultMgi.resultId, resultId))
    .returning())[0] ?? null;

export const deleteResultMgi = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database.delete(resultMgi).where(eq(resultMgi.resultId, resultId)).returning();
  return rows.length > 0;
};

export const createResultMgiFinding = async (
  data: CreateResultMgiFindingInput,
  database: DbOrTx = db,
) =>
  (await database.insert(resultMgiFinding).values(data).returning())[0] ?? null;

export const listResultMgiFindingsByResultMgiId = async (
  resultMgiId: number,
  database: DbOrTx = db,
) =>
  await database
    .select()
    .from(resultMgiFinding)
    .where(eq(resultMgiFinding.resultMgiId, resultMgiId))
    .orderBy(resultMgiFinding.sortOrder);

export const getResultMgiFindingById = async (
  findingId: number,
  database: DbOrTx = db,
) =>
  (await database
    .select()
    .from(resultMgiFinding)
    .where(eq(resultMgiFinding.findingId, findingId))
    .limit(1))[0] ?? null;

export const updateResultMgiFinding = async (
  findingId: number,
  data: Partial<CreateResultMgiFindingInput>,
  database: DbOrTx = db,
) =>
  (await database
    .update(resultMgiFinding)
    .set(data)
    .where(eq(resultMgiFinding.findingId, findingId))
    .returning())[0] ?? null;

export const deleteResultMgiFinding = async (
  findingId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database.delete(resultMgiFinding).where(eq(resultMgiFinding.findingId, findingId)).returning();
  return rows.length > 0;
};
