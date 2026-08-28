import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";
import {
  createAsset,
  createComponent,
  createItem,
  deleteAsset,
  deleteComponent,
  deleteItem,
  getAssetById,
  getAssetByProjectIdAndName,
  getComponentByAssetIdAndName,
  getComponentById,
  getItemByComponentIdAndLabel,
  getItemById,
  getItemByLabel,
  listAssets,
  listAssetsByProjectId,
  listProjectStructureTree,
  listComponents,
  listComponentsByAssetId,
  listItems,
  listItemsByComponentId,
  updateAsset,
  updateComponent,
  updateItem,
} from "../../src/db/services/structure.service";

describe("structure.service", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  it("supports CRUD for asset, component, and item", async () => {
    await testDb.insert(schema.project).values({
      projectId: 1,
      title: "Project Alpha",
    });

    const createdAsset = await createAsset(
      {
        projectId: 1,
        name: " Platform A ",
      },
      testDb,
    );

    expect(createdAsset).toMatchObject({
      projectId: 1,
      name: "Platform A",
    });
    expect(createdAsset?.assetId).toBeTypeOf("number");
    expect(createdAsset?.createdAt).toBeInstanceOf(Date);

    expect(await listAssets(testDb)).toHaveLength(1);
    expect(await listAssetsByProjectId(1, testDb)).toHaveLength(1);
    expect(await getAssetById(createdAsset!.assetId, testDb)).toMatchObject({
      name: "Platform A",
    });
    expect(await getAssetByProjectIdAndName(1, " Platform A ", testDb)).toMatchObject({
      assetId: createdAsset!.assetId,
    });

    const updatedAsset = await updateAsset(
      createdAsset!.assetId,
      {
        name: " Platform A Updated ",
      },
      testDb,
    );

    expect(updatedAsset).toMatchObject({
      assetId: createdAsset!.assetId,
      name: "Platform A Updated",
    });

    const createdComponent = await createComponent(
      {
        assetId: createdAsset!.assetId,
        name: " Jacket Leg ",
      },
      testDb,
    );

    expect(createdComponent).toMatchObject({
      assetId: createdAsset!.assetId,
      name: "Jacket Leg",
    });
    expect(createdComponent?.componentId).toBeTypeOf("number");

    expect(await listComponents(testDb)).toHaveLength(1);
    expect(await listComponentsByAssetId(createdAsset!.assetId, testDb)).toHaveLength(1);
    expect(
      await getComponentById(createdComponent!.componentId, testDb),
    ).toMatchObject({
      name: "Jacket Leg",
    });
    expect(
      await getComponentByAssetIdAndName(
        createdAsset!.assetId,
        " Jacket Leg ",
        testDb,
      ),
    ).toMatchObject({
      componentId: createdComponent!.componentId,
    });

    const updatedComponent = await updateComponent(
      createdComponent!.componentId,
      {
        name: " Jacket Leg Updated ",
      },
      testDb,
    );

    expect(updatedComponent).toMatchObject({
      componentId: createdComponent!.componentId,
      name: "Jacket Leg Updated",
    });

    const createdItem = await createItem(
      {
        componentId: createdComponent!.componentId,
        itemLabel: " JL-01 ",
        position: " 20m ",
        status: "complete",
      },
      testDb,
    );

    expect(createdItem).toMatchObject({
      componentId: createdComponent!.componentId,
      itemLabel: "JL-01",
      position: "20m",
      status: "complete",
    });
    expect(createdItem?.itemId).toBeTypeOf("number");

    expect(await listItems(testDb)).toHaveLength(1);
    expect(await listItemsByComponentId(createdComponent!.componentId, testDb)).toHaveLength(1);
    expect(await getItemById(createdItem!.itemId, testDb)).toMatchObject({
      itemLabel: "JL-01",
    });
    expect(await getItemByLabel(" JL-01 ", testDb)).toMatchObject({
      itemId: createdItem!.itemId,
    });
    expect(
      await getItemByComponentIdAndLabel(
        createdComponent!.componentId,
        " JL-01 ",
        testDb,
      ),
    ).toMatchObject({
      itemId: createdItem!.itemId,
    });

    const updatedItem = await updateItem(
      createdItem!.itemId,
      {
        itemLabel: " JL-01A ",
        position: " ",
        status: "pending",
      },
      testDb,
    );

    expect(updatedItem).toMatchObject({
      itemId: createdItem!.itemId,
      itemLabel: "JL-01A",
      position: null,
      status: "pending",
    });

    expect(await deleteItem(createdItem!.itemId, testDb)).toMatchObject({
      itemId: createdItem!.itemId,
    });
    expect(await deleteComponent(createdComponent!.componentId, testDb)).toMatchObject({
      componentId: createdComponent!.componentId,
    });
    expect(await deleteAsset(createdAsset!.assetId, testDb)).toMatchObject({
      assetId: createdAsset!.assetId,
    });

    const remainingAsset = await testDb.query.asset.findFirst({
      where: eq(schema.asset.assetId, createdAsset!.assetId),
    });

    expect(remainingAsset).toBeUndefined();
  });

  it("builds the project structure tree for workspace navigation", async () => {
    await testDb.insert(schema.project).values({
      projectId: 7,
      title: "Platform Petronas",
    });

    const assetRecord = await createAsset(
      {
        projectId: 7,
        name: "Platform Petronas",
      },
      testDb,
    );
    const riserComponent = await createComponent(
      {
        assetId: assetRecord!.assetId,
        name: "Riser",
      },
      testDb,
    );
    const jacketComponent = await createComponent(
      {
        assetId: assetRecord!.assetId,
        name: "Jacket",
      },
      testDb,
    );

    await createItem(
      {
        componentId: riserComponent!.componentId,
        itemLabel: "riser_01",
      },
      testDb,
    );
    await createItem(
      {
        componentId: riserComponent!.componentId,
        itemLabel: "riser_02",
      },
      testDb,
    );
    await createItem(
      {
        componentId: jacketComponent!.componentId,
        itemLabel: "jacket_01",
      },
      testDb,
    );

    await expect(listProjectStructureTree(7, testDb)).resolves.toEqual([
      {
        assetId: assetRecord!.assetId,
        assetType: null,
        projectId: 7,
        name: "Platform Petronas",
        components: [
          {
            componentId: riserComponent!.componentId,
            assetId: assetRecord!.assetId,
            projectId: 7,
            name: "Riser",
            items: [
              {
                itemId: expect.any(Number),
                componentId: riserComponent!.componentId,
                itemLabel: "riser_01",
                position: null,
                status: "not_set",
              },
              {
                itemId: expect.any(Number),
                componentId: riserComponent!.componentId,
                itemLabel: "riser_02",
                position: null,
                status: "not_set",
              },
            ],
          },
          {
            componentId: jacketComponent!.componentId,
            assetId: assetRecord!.assetId,
            projectId: 7,
            name: "Jacket",
            items: [
              {
                itemId: expect.any(Number),
                componentId: jacketComponent!.componentId,
                itemLabel: "jacket_01",
                position: null,
                status: "not_set",
              },
            ],
          },
        ],
      },
    ]);
  });
});
