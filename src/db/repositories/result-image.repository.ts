import { asc, eq, inArray } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { resultImage } from "../schema";

export const createResultImageRecord = async (
  data: typeof resultImage.$inferInsert,
  database: DbOrTx = db,
) => {
  const createdResultImages = await database
    .insert(resultImage)
    .values(data)
    .returning();

  return createdResultImages[0] ?? null;
};

export const listResultImageRecords = async (database: DbOrTx = db) =>
  database.query.resultImage.findMany({
    orderBy: asc(resultImage.imageId),
  });

export const findResultImageById = async (
  imageId: number,
  database: DbOrTx = db,
) =>
  (await database.query.resultImage.findFirst({
    where: eq(resultImage.imageId, imageId),
  })) ?? null;

export const listResultImageRecordsByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  database.query.resultImage.findMany({
    where: eq(resultImage.resultId, resultId),
    orderBy: asc(resultImage.imageId),
  });

/** Batched image fetch across many results (kills the sidebar/playback N+1). */
export const listResultImageRecordsByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
) => {
  if (resultIds.length === 0) {
    return [];
  }

  return database.query.resultImage.findMany({
    where: inArray(resultImage.resultId, resultIds),
    orderBy: [asc(resultImage.resultId), asc(resultImage.imageId)],
  });
};

export const updateResultImageById = async (
  imageId: number,
  data: Partial<typeof resultImage.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updatedResultImages = await database
    .update(resultImage)
    .set(data)
    .where(eq(resultImage.imageId, imageId))
    .returning();

  return updatedResultImages[0] ?? null;
};

export const deleteResultImageById = async (
  imageId: number,
  database: DbOrTx = db,
) => {
  const deletedResultImages = await database
    .delete(resultImage)
    .where(eq(resultImage.imageId, imageId))
    .returning();

  return deletedResultImages[0] ?? null;
};
