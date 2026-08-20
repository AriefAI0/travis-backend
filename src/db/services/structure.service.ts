import type { ProjectStructureAssetNode } from "../../types/api";
import { db, type DbOrTx } from "../client";
import {
  createAssetRecord,
  deleteAssetById,
  findAssetById,
  findAssetByProjectIdAndName,
  listAssetRecords,
  listAssetRecordsByProjectId,
  updateAssetById,
} from "../repositories/asset.repository";
import {
  createComponentRecord,
  deleteComponentById,
  findComponentByAssetIdAndName,
  findComponentById,
  listComponentRecords,
  listComponentRecordsByAssetId,
  listComponentRecordsByProjectId,
  updateComponentById,
} from "../repositories/component.repository";
import {
  createItemRecord,
  deleteItemById,
  findItemByComponentIdAndLabel,
  findItemById,
  findItemByLabel,
  listItemRecords,
  listItemRecordsByComponentId,
  listItemRecordsByProjectId,
  updateItemById,
} from "../repositories/item.repository";
import { asset, component, item } from "../schema";

export type CreateAssetInput = {
  projectId: number;
  name: string;
};

export type CreateComponentInput = {
  assetId: number;
  name: string;
};

export type CreateItemInput = {
  componentId: number;
  itemLabel: string;
  position?: string | null;
  status?: "not_set" | "pending" | "complete" | null;
};

const normalizeRequiredName = (value: string, fieldName: string) => {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    throw new Error(`${fieldName} is required`);
  }

  return trimmedValue;
};

const normalizeOptionalText = (value?: string | null) => {
  const trimmedValue = value?.trim();

  return trimmedValue ? trimmedValue : null;
};

const normalizeAssetUpdate = (
  data: Partial<typeof asset.$inferInsert>,
): Partial<typeof asset.$inferInsert> => {
  const nextData: Partial<typeof asset.$inferInsert> = {};

  if ("projectId" in data) {
    nextData.projectId = data.projectId;
  }

  if ("name" in data) {
    if (data.name === undefined) {
      throw new Error("Asset name is required");
    }

    nextData.name = normalizeRequiredName(data.name, "Asset name");
  }

  return nextData;
};

const normalizeComponentUpdate = (
  data: Partial<typeof component.$inferInsert>,
): Partial<typeof component.$inferInsert> => {
  const nextData: Partial<typeof component.$inferInsert> = {};

  if ("assetId" in data) {
    nextData.assetId = data.assetId;
  }

  if ("projectId" in data) {
    nextData.projectId = data.projectId;
  }

  if ("name" in data) {
    if (data.name === undefined) {
      throw new Error("Component name is required");
    }

    nextData.name = normalizeRequiredName(data.name, "Component name");
  }

  return nextData;
};

const normalizeItemUpdate = (
  data: Partial<typeof item.$inferInsert> | { itemLabel?: string; position?: string | null; status?: "pending" | "complete" | null },
): Partial<typeof item.$inferInsert> => {
  const nextData: Partial<typeof item.$inferInsert> = {};

  // Handle both schema fields and shared type fields
  if ("componentId" in data && data.componentId !== undefined) {
    nextData.componentId = data.componentId;
  }
  if ("projectId" in data && data.projectId !== undefined) {
    nextData.projectId = data.projectId;
  }
  if ("assetId" in data && data.assetId !== undefined) {
    nextData.assetId = data.assetId;
  }

  // Handle both camelCase (shared) and snake_case (schema) field names
  const itemLabelValue = "itemLabel" in data ? data.itemLabel : "item_label" in data ? (data as any).item_label : undefined;
  if (itemLabelValue !== undefined) {
    if (itemLabelValue === undefined || itemLabelValue === null) {
      throw new Error("Item label is required");
    }
    nextData.itemLabel = normalizeRequiredName(itemLabelValue, "Item label");
  }

  const positionValue = "position" in data ? data.position : undefined;
  if (positionValue !== undefined) {
    nextData.position = normalizeOptionalText(positionValue);
  }

  const statusValue = "status" in data ? data.status : undefined;
  if (statusValue !== undefined) {
    // Convert null to undefined for the schema (which doesn't allow null)
    nextData.status = statusValue === null ? undefined : statusValue;
  }

  return nextData;
};

export const createAsset = async (
  data: CreateAssetInput,
  database?: DbOrTx,
) =>
  createAssetRecord(
    {
      projectId: data.projectId,
      name: normalizeRequiredName(data.name, "Asset name"),
    },
    database,
  );

export const listAssets = async (database?: DbOrTx) =>
  listAssetRecords(database);

export const listAssetsByProjectId = async (
  projectId: number,
  database?: DbOrTx,
) => listAssetRecordsByProjectId(projectId, database);

export const listProjectStructureTree = async (
  projectId: number,
  database?: DbOrTx,
): Promise<ProjectStructureAssetNode[]> => {
  // Batched via the denormalized projectId on asset/component/item — 3 queries
  // total, independent of how many assets/components/items exist. The previous
  // implementation issued 1 + A + A*C queries (per-asset, per-component fetches).
  const [assets, components, items] = await Promise.all([
    listAssetRecordsByProjectId(projectId, database),
    listComponentRecordsByProjectId(projectId, database),
    listItemRecordsByProjectId(projectId, database),
  ]);

  const itemsByComponentId = new Map<number, typeof items>();
  for (const itemRecord of items) {
    const bucket = itemsByComponentId.get(itemRecord.componentId) ?? [];
    bucket.push(itemRecord);
    itemsByComponentId.set(itemRecord.componentId, bucket);
  }

  const componentsByAssetId = new Map<number, typeof components>();
  for (const componentRecord of components) {
    const bucket = componentsByAssetId.get(componentRecord.assetId) ?? [];
    bucket.push(componentRecord);
    componentsByAssetId.set(componentRecord.assetId, bucket);
  }

  return assets.map((assetRecord) => ({
    assetId: assetRecord.assetId,
    projectId: assetRecord.projectId,
    name: assetRecord.name,
    assetType: assetRecord.assetType ?? null,
    components: (componentsByAssetId.get(assetRecord.assetId) ?? []).map(
      (componentRecord) => ({
        componentId: componentRecord.componentId,
        assetId: componentRecord.assetId,
        projectId: componentRecord.projectId,
        name: componentRecord.name,
        items: (itemsByComponentId.get(componentRecord.componentId) ?? []).map(
          (itemRecord) => ({
            itemId: itemRecord.itemId,
            componentId: itemRecord.componentId,
            itemLabel: itemRecord.itemLabel,
            position: itemRecord.position,
            status: itemRecord.status,
          }),
        ),
      }),
    ),
  }));
};

export const getAssetById = async (assetId: number, database?: DbOrTx) =>
  findAssetById(assetId, database);

export const getAssetByProjectIdAndName = async (
  projectId: number,
  name: string,
  database?: DbOrTx,
) =>
  findAssetByProjectIdAndName(
    projectId,
    normalizeRequiredName(name, "Asset name"),
    database,
  );

export const updateAsset = async (
  assetId: number,
  data: Partial<typeof asset.$inferInsert>,
  database?: DbOrTx,
) => updateAssetById(assetId, normalizeAssetUpdate(data), database);

export const deleteAsset = async (assetId: number, database?: DbOrTx) =>
  deleteAssetById(assetId, database);

export const createComponent = async (
  data: CreateComponentInput,
  database?: DbOrTx,
) => {
  // flow: parent asset lookup > insert component, one tx
  const run = async (tx: DbOrTx) => {
    // Look up parent asset to get projectId for denormalization
    const parentAsset = await findAssetById(data.assetId, tx);
    if (!parentAsset) {
      throw new Error("Parent asset not found");
    }

    return createComponentRecord(
      {
        assetId: data.assetId,
        projectId: parentAsset.projectId, // Denormalized from parent asset
        name: normalizeRequiredName(data.name, "Component name"),
      },
      tx,
    );
  };

  return database ? run(database) : db.transaction(run);
};

export const listComponents = async (database?: DbOrTx) =>
  listComponentRecords(database);

export const listComponentsByAssetId = async (
  assetId: number,
  database?: DbOrTx,
) => listComponentRecordsByAssetId(assetId, database);

export const getComponentById = async (
  componentId: number,
  database?: DbOrTx,
) => findComponentById(componentId, database);

export const getComponentByAssetIdAndName = async (
  assetId: number,
  name: string,
  database?: DbOrTx,
) =>
  findComponentByAssetIdAndName(
    assetId,
    normalizeRequiredName(name, "Component name"),
    database,
  );

export const updateComponent = async (
  componentId: number,
  data: Partial<typeof component.$inferInsert>,
  database?: DbOrTx,
) => updateComponentById(componentId, normalizeComponentUpdate(data), database);

export const deleteComponent = async (
  componentId: number,
  database?: DbOrTx,
) => deleteComponentById(componentId, database);

export const createItem = async (
  data: CreateItemInput,
  database?: DbOrTx,
) => {
  // flow: parent component lookup > insert item, one tx
  const run = async (tx: DbOrTx) => {
    // Look up parent component to get projectId and assetId for denormalization
    const parentComponent = await findComponentById(data.componentId, tx);
    if (!parentComponent) {
      throw new Error("Parent component not found");
    }

    return createItemRecord(
      {
        componentId: data.componentId,
        projectId: parentComponent.projectId, // Denormalized from parent component
        assetId: parentComponent.assetId, // Denormalized from parent component
        itemLabel: normalizeRequiredName(data.itemLabel, "Item label"),
        position: normalizeOptionalText(data.position),
        status: data.status ?? "not_set",
      },
      tx,
    );
  };

  return database ? run(database) : db.transaction(run);
};

export const listItems = async (database?: DbOrTx) => listItemRecords(database);

export const listItemsByComponentId = async (
  componentId: number,
  database?: DbOrTx,
) => listItemRecordsByComponentId(componentId, database);

export const getItemById = async (itemId: number, database?: DbOrTx) =>
  findItemById(itemId, database);

export const getItemByLabel = async (
  itemLabel: string,
  database?: DbOrTx,
) => findItemByLabel(normalizeRequiredName(itemLabel, "Item label"), database);

export const getItemByComponentIdAndLabel = async (
  componentId: number,
  itemLabel: string,
  database?: DbOrTx,
) =>
  findItemByComponentIdAndLabel(
    componentId,
    normalizeRequiredName(itemLabel, "Item label"),
    database,
  );

export const updateItem = async (
  itemId: number,
  data: Partial<typeof item.$inferInsert>,
  database?: DbOrTx,
) => updateItemById(itemId, normalizeItemUpdate(data), database);

export const deleteItem = async (itemId: number, database?: DbOrTx) =>
  deleteItemById(itemId, database);
