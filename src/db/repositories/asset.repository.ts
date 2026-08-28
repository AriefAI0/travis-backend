import { and, asc, eq, isNull } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { asset } from "../schema";

export const createAssetRecord = async (
  data: typeof asset.$inferInsert,
  database: DbOrTx = db,
) => {
  const createdAssets = await database.insert(asset).values(data).returning();

  return createdAssets[0] ?? null;
};

export const listAssetRecords = async (database: DbOrTx = db) =>
  database.query.asset.findMany({
    where: isNull(asset.archivedAt),
    orderBy: [asc(asset.projectId), asc(asset.assetId)],
  });

export const listAssetRecordsByProjectId = async (
  projectId: number,
  database: DbOrTx = db,
) =>
  database.query.asset.findMany({
    where: and(eq(asset.projectId, projectId), isNull(asset.archivedAt)),
    orderBy: asc(asset.assetId),
  });

export const findAssetById = async (
  assetId: number,
  database: DbOrTx = db,
) =>
  (await database.query.asset.findFirst({
    where: eq(asset.assetId, assetId),
  })) ?? null;

export const findAssetByProjectIdAndName = async (
  projectId: number,
  name: string,
  database: DbOrTx = db,
) =>
  (await database.query.asset.findFirst({
    where: and(eq(asset.projectId, projectId), eq(asset.name, name)),
  })) ?? null;

export const updateAssetById = async (
  assetId: number,
  data: Partial<typeof asset.$inferInsert>,
  database: DbOrTx = db,
) => {
  const updatedAssets = await database
    .update(asset)
    .set(data)
    .where(eq(asset.assetId, assetId))
    .returning();

  return updatedAssets[0] ?? null;
};

export const deleteAssetById = async (
  assetId: number,
  database: DbOrTx = db,
) => {
  const deletedAssets = await database
    .delete(asset)
    .where(eq(asset.assetId, assetId))
    .returning();

  return deletedAssets[0] ?? null;
};
