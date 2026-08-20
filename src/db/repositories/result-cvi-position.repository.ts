import { eq } from "drizzle-orm";

import { db } from "../client";
import { resultCviPosition } from "../schema";

import type { DbOrTx } from "../client";

export type CreateResultCviPositionInput = {
    resultId: number;
    clockPosition: string;
    utMm: number | null;
    findings: string | null;
    sortOrder: number;
};

export const createResultCviPosition = async (
    data: CreateResultCviPositionInput,
    database: DbOrTx = db,
) => (
    await database
    .insert(resultCviPosition)
    .values(data)
    .returning()
)[0] ?? null;

export const getResultCviPositions = async (
    resultId: number,
    database: DbOrTx = db,
) =>
    database.query.resultCviPosition.findMany({
        where: eq(resultCviPosition.resultId, resultId),
        orderBy: (position, { asc }) => [
            asc(position.sortOrder),
        ],
    });