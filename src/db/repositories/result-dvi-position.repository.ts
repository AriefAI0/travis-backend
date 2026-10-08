import { eq } from "drizzle-orm";

import { db } from "../client";
import { resultDviPosition } from "../schema";

import type { DbOrTx } from "../client";

export type CreateResultDviPositionInput = {
    resultId: number;
    clockPosition: string;
    utMm: number | null;
    findings: string | null;
    sortOrder: number;
};

export const createResultDviPosition = async (
    data: CreateResultDviPositionInput,
    database: DbOrTx = db,
) => (
    await database
    .insert(resultDviPosition)
    .values(data)
    .returning()
)[0] ?? null;

export const getResultDviPositions = async (
    resultId: number,
    database: DbOrTx = db,
) =>
    database.query.resultDviPosition.findMany({
        where: eq(resultDviPosition.resultId, resultId),
        orderBy: (position, { asc }) => [
            asc(position.sortOrder),
        ],
    });