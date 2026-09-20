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
  createResult,
  createResultImage,
  deleteResult,
  deleteResultImage,
  getCpDetailByResultId,
  getCviDetailByResultId,
  getFmdDetailByResultId,
  getGviDetailByResultId,
  getItemResultSidebar,
  getResultById,
  getResultEvidence,
  getResultImageById,
  getResultMgiDetailByResultId,
  listProjectSummary,
  listResultImages,
  listResultImagesByResultId,
  listResults,
  listResultsBySessionItemId,
  updateResult,
  updateResultImage,
  writeTypedDetail,
} from "../../src/db/services/result.service";
import { createMasterVideo, createVideoClip } from "../../src/db/services/video.service";

describe("result.service", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  describe("createResult", () => {
    it("creates a result with all fields", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 1,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
          remarks: "Test result",
        },
        testDb,
      );

      expect(result).not.toBeNull();
      expect(result!.sessionItemId).toBe(sessionItem.sessionItemId);
      expect(result!.inspectionTypeCode).toBe("GVI");
      expect(result!.projectId).toBe(project.projectId);
      expect(result!.assetId).toBe(asset.assetId);
      expect(result!.componentId).toBe(component.componentId);
      expect(result!.itemId).toBe(item.itemId);
      expect(result!.sessionId).toBe(session.sessionId);
      expect(result!.remarks).toBe("Test result");
    });

    it("creates a result with minimal fields", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 2,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "MGI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      expect(result).not.toBeNull();
      expect(result!.inspectionTypeCode).toBe("MGI");
      expect(result!.remarks).toBeNull();
    });

    // The ordinal that names the clip folder and the results folder. It is
    // scoped to the SESSION: a clip is 1:1 with its result, so one number
    // serves both, and a second session starts again at 1.
    it("numbers results per session, starting at one", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({ displayNumber: 1, title: "Test Project" })
        .returning()
        .then((rows) => rows[0]!);
      const asset = await testDb
        .insert(schema.asset)
        .values({ projectId: project.projectId, name: "Asset 1" })
        .returning()
        .then((rows) => rows[0]!);
      const component = await testDb
        .insert(schema.component)
        .values({ projectId: project.projectId, assetId: asset.assetId, name: "Component 1" })
        .returning()
        .then((rows) => rows[0]!);
      const item = await testDb
        .insert(schema.item)
        .values({
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemLabel: "Item 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const seedSession = async (name: string, displayNumber: number) => {
        const session = await testDb
          .insert(schema.session)
          .values({ displayNumber, projectId: project.projectId, name })
          .returning()
          .then((rows) => rows[0]!);
        const sessionItem = await testDb
          .insert(schema.sessionItem)
          .values({ sessionId: session.sessionId, itemId: item.itemId })
          .returning()
          .then((rows) => rows[0]!);
        return {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI" as const,
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        };
      };

      const firstSession = await seedSession("Run 1", 1);
      const results = [
        await createResult(firstSession, testDb),
        await createResult(firstSession, testDb),
        await createResult(firstSession, testDb),
      ];

      expect(results.map((row) => row!.displayNumber)).toEqual([1, 2, 3]);

      // a different session is a different sequence
      const secondSession = await seedSession("Run 2", 2);
      const firstOfSecond = await createResult(secondSession, testDb);
      expect(firstOfSecond!.displayNumber).toBe(1);
    });
  });

  describe("getResultById", () => {
    it("returns null when result does not exist", async () => {
      const result = await getResultById(999, testDb);
      expect(result).toBeNull();
    });

    it("returns result by id", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 4,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const createdResult = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "CP",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const result = await getResultById(createdResult!.resultId!, testDb);
      expect(result).not.toBeNull();
      expect(result!.resultId).toBe(createdResult!.resultId);
      expect(result!.inspectionTypeCode).toBe("CP");
    });
  });

  describe("listResults", () => {
    it("returns empty list when no results", async () => {
      const results = await listResults(testDb);
      expect(results).toHaveLength(0);
    });

    it("returns all results ordered by sessionItemId and resultId", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 5,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "FMD",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const results = await listResults(testDb);
      expect(results).toHaveLength(1);
      expect(results[0]!.inspectionTypeCode).toBe("FMD");
    });
  });

  describe("listResultsBySessionItemId", () => {
    it("returns empty list when no results for session item", async () => {
      const results = await listResultsBySessionItemId(999, testDb);
      expect(results).toHaveLength(0);
    });

    it("returns results for a specific session item", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 6,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem1 = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      await createResult(
        {
          sessionItemId: sessionItem1.sessionItemId,
          inspectionTypeCode: "CVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const results = await listResultsBySessionItemId(sessionItem1.sessionItemId, testDb);
      expect(results).toHaveLength(1);
      expect(results[0]!.inspectionTypeCode).toBe("CVI");
    });
  });

  describe("updateResult", () => {
    it("updates result remarks", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 7,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const createdResult = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
          remarks: "Original remarks",
        },
        testDb,
      );

      const updatedResult = await updateResult(
        createdResult!.resultId!,
        { remarks: "Updated remarks" },
        testDb,
      );

      expect(updatedResult).not.toBeNull();
      expect(updatedResult!.remarks).toBe("Updated remarks");
      expect(updatedResult!.inspectionTypeCode).toBe("GVI");
    });
  });

  describe("deleteResult", () => {
    it("deletes a result", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 8,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const createdResult = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "CP",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const deletedResult = await deleteResult(createdResult!.resultId!, testDb);

      expect(deletedResult).not.toBeNull();
      expect(deletedResult!.resultId).toBe(createdResult!.resultId);

      const result = await getResultById(createdResult!.resultId!, testDb);
      expect(result).toBeNull();
    });
  });

  describe("createResultImage", () => {
    it("creates a result image", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 9,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "MGI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const image = await createResultImage(
        {
          resultId: result!.resultId,
          storageStem: "https://example.com/image.jpg",
        },
        testDb,
      );

      expect(image).not.toBeNull();
      expect(image!.resultId).toBe(result!.resultId);
      expect(image!.storageStem).toBe("https://example.com/image.jpg");
    });
  });

  describe("getResultImageById", () => {
    it("returns null when image does not exist", async () => {
      const image = await getResultImageById(999, testDb);
      expect(image).toBeNull();
    });

    it("returns image by id", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 10,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const createdImage = await createResultImage(
        {
          resultId: result!.resultId,
          storageStem: "https://example.com/image.jpg",
        },
        testDb,
      );

      const image = await getResultImageById(createdImage!.imageId, testDb);
      expect(image).not.toBeNull();
      expect(image!.imageId).toBe(createdImage!.imageId);
    });
  });

  describe("listResultImages", () => {
    it("returns empty list when no images", async () => {
      const images = await listResultImages(testDb);
      expect(images).toHaveLength(0);
    });

    it("returns all result images", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 11,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "CVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      await createResultImage(
        {
          resultId: result!.resultId,
          storageStem: "https://example.com/image1.jpg",
        },
        testDb,
      );

      const images = await listResultImages(testDb);
      expect(images).toHaveLength(1);
    });
  });

  describe("listResultImagesByResultId", () => {
    it("returns empty list when no images for result", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 12,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "FMD",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const images = await listResultImagesByResultId(result!.resultId, testDb);
      expect(images).toHaveLength(0);
    });

    it("returns images for a specific result", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 13,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "CP",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      await createResultImage(
        {
          resultId: result!.resultId,
          storageStem: "https://example.com/image1.jpg",
        },
        testDb,
      );

      await createResultImage(
        {
          resultId: result!.resultId,
          storageStem: "https://example.com/image2.jpg",
        },
        testDb,
      );

      const images = await listResultImagesByResultId(result!.resultId, testDb);
      expect(images).toHaveLength(2);
    });
  });

  describe("updateResultImage", () => {
    it("updates result image", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 14,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const image = await createResultImage(
        {
          resultId: result!.resultId,
          storageStem: "https://example.com/image.jpg",
        },
        testDb,
      );

      const updatedImage = await updateResultImage(
        image!.imageId,
        { remarks: "Updated remarks" },
        testDb,
      );

      expect(updatedImage).not.toBeNull();
      expect(updatedImage!.remarks).toBe("Updated remarks");
    });
  });

  describe("deleteResultImage", () => {
    it("deletes a result image", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 15,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "CVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const image = await createResultImage(
        {
          resultId: result!.resultId,
          storageStem: "https://example.com/image.jpg",
        },
        testDb,
      );

      const deletedImage = await deleteResultImage(image!.imageId, testDb);

      expect(deletedImage).not.toBeNull();
      expect(deletedImage!.imageId).toBe(image!.imageId);

      const foundImage = await getResultImageById(image!.imageId, testDb);
      expect(foundImage).toBeNull();
    });
  });

  describe("getItemResultSidebar", () => {
    it("returns empty sidebar when item has no results", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sidebar = await getItemResultSidebar(item.itemId, testDb);
      expect(sidebar).not.toBeNull();
      expect(sidebar!.itemId).toBe(item.itemId);
      expect(sidebar!.sessions).toHaveLength(0);
    });

    it("returns sidebar with results grouped by session", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 16,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result1 = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "MGI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
          remarks: "First result",
        },
        testDb,
      );

      const sidebar = await getItemResultSidebar(item.itemId, testDb);
      expect(sidebar).not.toBeNull();
      expect(sidebar!.itemId).toBe(item.itemId);
      expect(sidebar!.sessions).toHaveLength(1);
      expect(sidebar!.sessions[0]!.sessionId).toBe(session.sessionId);
      expect(sidebar!.sessions[0]!.results).toHaveLength(1);
      expect(sidebar!.sessions[0]!.results[0]!.resultId).toBe(result1!.resultId);
      expect(sidebar!.sessions[0]!.results[0]!.inspectionTypeCode).toBe("MGI");
      expect(sidebar!.sessions[0]!.results[0]!.inspectionTypeName).toBe("MGI");
      expect(sidebar!.sessions[0]!.results[0]!.remarks).toBe("First result");
    });

    it("includes clips in sidebar data", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 17,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const masterVideo = await createMasterVideo(
        {
          sessionId: session.sessionId,
          startEpoch: Math.floor(Date.now() / 1000)
        },
        testDb,
      );

      const clip = await createVideoClip(
        {
          resultId: result!.resultId,
          masterVideoId: masterVideo!.masterVideoId,
          startOffsetMs: 1000,
          endOffsetMs: 5000,
        },
        testDb,
      );

      const sidebar = await getItemResultSidebar(item.itemId, testDb);
      const sessionResult = sidebar!.sessions[0]!;
      expect(sessionResult.results[0]!.clips).toHaveLength(1);
      expect(sessionResult.results[0]!.clips[0]!.clipId).toBe(clip!.clipId);
    });
  });

  describe("MGI typed detail (Phase 3)", () => {
    it("writeTypedDetail creates MGI record and findings", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 18,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "MGI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const mgiPayload = {
        kind: "mgi" as const,
        version: 1 as const,
        noMgObserved: false,
        criteria: {
          preset: "project_default" as const,
        },
        findings: [
          {
            id: "finding-1",
            growthType: "hard" as const,
            species: "Barnacles",
            coveragePercent: 60,
            thicknessMm: 20,
            remarks: "Found on port side",
          },
          {
            id: "finding-2",
            growthType: "soft" as const,
            species: "Tubeworms",
            coveragePercent: 40,
            thicknessMm: 5,
            remarks: "Starboard side",
          },
        ],
      };

      await writeTypedDetail("MGI", mgiPayload, result!.resultId!, testDb);

      // Verify MGI detail was created
      const mgiDetail = await getResultMgiDetailByResultId(result!.resultId!, testDb);
      expect(mgiDetail).not.toBeNull();
      expect(mgiDetail!.detail.noMgObserved).toBe(0);
      expect(mgiDetail!.detail.criteriaPreset).toBe("project_default");
      expect(mgiDetail!.findings).toHaveLength(2);

      // Verify findings are ordered correctly
      expect(mgiDetail!.findings[0]!.species).toBe("Barnacles");
      expect(mgiDetail!.findings[0]!.coveragePercent).toBe(60);
      expect(mgiDetail!.findings[0]!.thicknessMm).toBe(20);
      expect(mgiDetail!.findings[0]!.sortOrder).toBe(0);
      expect(mgiDetail!.findings[1]!.species).toBe("Tubeworms");
      expect(mgiDetail!.findings[1]!.coveragePercent).toBe(40);
      expect(mgiDetail!.findings[1]!.thicknessMm).toBe(5);
      expect(mgiDetail!.findings[1]!.sortOrder).toBe(1);
    });

    it("getResultMgiDetailByResultId returns null for non-existent result", async () => {
      const mgiDetail = await getResultMgiDetailByResultId(999, testDb);
      expect(mgiDetail).toBeNull();
    });

    it("getResultMgiDetailByResultId returns MGI data with ISO string dates", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 19,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "MGI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const mgiPayload = {
        kind: "mgi" as const,
        version: 1 as const,
        noMgObserved: true,
        criteria: {
          preset: "client_cnc" as const,
        },
        findings: [],
      };

      await writeTypedDetail("MGI", mgiPayload, result!.resultId!, testDb);

      const mgiDetail = await getResultMgiDetailByResultId(result!.resultId!, testDb);
      expect(mgiDetail).not.toBeNull();
      expect(mgiDetail!.detail.noMgObserved).toBe(1);
      expect(mgiDetail!.detail.criteriaPreset).toBe("client_cnc");
      expect(mgiDetail!.findings).toHaveLength(0);

      // Verify dates are ISO strings (not Date objects)
      expect(typeof mgiDetail!.detail.createdAt).toBe("string");
      expect(typeof mgiDetail!.detail.updatedAt).toBe("string");
      expect(mgiDetail!.detail.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("deleting result cascades to MGI detail and findings", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 20,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "MGI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const mgiPayload = {
        kind: "mgi" as const,
        version: 1 as const,
        noMgObserved: false,
        criteria: {
          preset: "manual" as const,
        },
        findings: [
          {
            id: "finding-1",
            growthType: "hard" as const,
            species: "Mussels",
            coveragePercent: 80,
            thicknessMm: 30,
            remarks: "Heavy growth",
          },
        ],
      };

      await writeTypedDetail("MGI", mgiPayload, result!.resultId!, testDb);

      // Verify MGI data exists
      const mgiDetailBefore = await getResultMgiDetailByResultId(result!.resultId!, testDb);
      expect(mgiDetailBefore).not.toBeNull();

      // Delete result
      await deleteResult(result!.resultId!, testDb);

      // Verify MGI data was cascade deleted
      const mgiDetailAfter = await getResultMgiDetailByResultId(result!.resultId!, testDb);
      expect(mgiDetailAfter).toBeNull();

      // Verify result is gone
      const resultAfter = await getResultById(result!.resultId!, testDb);
      expect(resultAfter).toBeNull();
    });
  });

  describe("CP typed detail (Phase 4)", () => {
    it("writeTypedDetail creates CP record with voltage", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 21,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "CP",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const cpPayload = {
        kind: "cp" as const,
        version: 1 as const,
        anodeType: "alu",
        depletion: "none",
        voltageMv: -850,
      };

      await writeTypedDetail("CP", cpPayload, result!.resultId!, testDb);

      // Verify CP detail was created
      const cpDetail = await getCpDetailByResultId(result!.resultId!, testDb);
      expect(cpDetail).not.toBeNull();
      expect(cpDetail!.voltageMv).toBe(-850);
      expect(cpDetail!.resultId).toBe(result!.resultId);
    });

    it("getCpDetailByResultId returns null for non-existent result", async () => {
      const cpDetail = await getCpDetailByResultId(999, testDb);
      expect(cpDetail).toBeNull();
    });

    it("getCpDetailByResultId returns CP data with ISO string dates", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 22,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "CP",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const cpPayload = {
        kind: "cp" as const,
        version: 1 as const,
        anodeType: "alu",
        depletion: "none",
        voltageMv: -920,
      };

      await writeTypedDetail("CP", cpPayload, result!.resultId!, testDb);

      const cpDetail = await getCpDetailByResultId(result!.resultId!, testDb);
      expect(cpDetail).not.toBeNull();
      expect(cpDetail!.voltageMv).toBe(-920);

      // Verify dates are ISO strings (not Date objects)
      expect(typeof cpDetail!.createdAt).toBe("string");
      expect(typeof cpDetail!.updatedAt).toBe("string");
      expect(cpDetail!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("deleting result cascades to CP detail", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 23,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "CP",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const cpPayload = {
        kind: "cp" as const,
        version: 1 as const,
        anodeType: "alu",
        depletion: "none",
        voltageMv: -780,
      };

      await writeTypedDetail("CP", cpPayload, result!.resultId!, testDb);

      // Verify CP data exists
      const cpDetailBefore = await getCpDetailByResultId(result!.resultId!, testDb);
      expect(cpDetailBefore).not.toBeNull();

      // Delete result
      await deleteResult(result!.resultId!, testDb);

      // Verify CP data was cascade deleted
      const cpDetailAfter = await getCpDetailByResultId(result!.resultId!, testDb);
      expect(cpDetailAfter).toBeNull();

      // Verify result is gone
      const resultAfter = await getResultById(result!.resultId!, testDb);
      expect(resultAfter).toBeNull();
    });
  });

  describe("FMD typed detail (Phase 5)", () => {
    it("writeTypedDetail creates FMD record with initial attempt", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 24,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "FMD",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const fmdPayload = {
        kind: "fmd" as const,
        version: 1 as const,
        depthEl: 2.5,
        initialAttempt: "flooded" as const,
        additionalAttempt1: "dry" as const,
        additionalAttempt2: "na" as const,
        additionalAttempt3: "na" as const,
      };

      await writeTypedDetail("FMD", fmdPayload, result!.resultId!, testDb);

      // Verify FMD detail was created
      const fmdDetail = await getFmdDetailByResultId(result!.resultId!, testDb);
      expect(fmdDetail).not.toBeNull();
      expect(fmdDetail!.initialAttempt).toBe("flooded");
      expect(fmdDetail!.resultId).toBe(result!.resultId);
    });

    it("getFmdDetailByResultId returns null for non-existent result", async () => {
      const fmdDetail = await getFmdDetailByResultId(999, testDb);
      expect(fmdDetail).toBeNull();
    });

    it("getFmdDetailByResultId returns FMD data with ISO string dates", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 25,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "FMD",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const fmdPayload = {
        kind: "fmd" as const,
        version: 1 as const,
        depthEl: 3,
        initialAttempt: "dry" as const,
        additionalAttempt1: "na" as const,
        additionalAttempt2: "na" as const,
        additionalAttempt3: "na" as const,
      };

      await writeTypedDetail("FMD", fmdPayload, result!.resultId!, testDb);

      const fmdDetail = await getFmdDetailByResultId(result!.resultId!, testDb);
      expect(fmdDetail).not.toBeNull();
      expect(fmdDetail!.initialAttempt).toBe("dry");

      // Verify dates are ISO strings (not Date objects)
      expect(typeof fmdDetail!.createdAt).toBe("string");
      expect(typeof fmdDetail!.updatedAt).toBe("string");
      expect(fmdDetail!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("deleting result cascades to FMD detail", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 26,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "FMD",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const fmdPayload = {
        kind: "fmd" as const,
        version: 1 as const,
        depthEl: 1,
        initialAttempt: "flooded" as const,
        additionalAttempt1: "na" as const,
        additionalAttempt2: "na" as const,
        additionalAttempt3: "na" as const,
      };

      await writeTypedDetail("FMD", fmdPayload, result!.resultId!, testDb);

      // Verify FMD data exists
      const fmdDetailBefore = await getFmdDetailByResultId(result!.resultId!, testDb);
      expect(fmdDetailBefore).not.toBeNull();

      // Delete result
      await deleteResult(result!.resultId!, testDb);

      // Verify FMD data was cascade deleted
      const fmdDetailAfter = await getFmdDetailByResultId(result!.resultId!, testDb);
      expect(fmdDetailAfter).toBeNull();

      // Verify result is gone
      const resultAfter = await getResultById(result!.resultId!, testDb);
      expect(resultAfter).toBeNull();
    });
  });

  describe("GVI typed detail (Phase 6)", () => {
    it("writeTypedDetail creates GVI record with condition", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 27,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const gviPayload = {
        kind: "gvi" as const,
        version: 1 as const,
        condition: "ok" as const,
      };

      await writeTypedDetail("GVI", gviPayload, result!.resultId!, testDb);

      // Verify GVI detail was created
      const gviDetail = await getGviDetailByResultId(result!.resultId!, testDb);
      expect(gviDetail).not.toBeNull();
      expect(gviDetail!.condition).toBe("ok");
      expect(gviDetail!.resultId).toBe(result!.resultId);
    });

    it("getGviDetailByResultId returns null for non-existent result", async () => {
      const gviDetail = await getGviDetailByResultId(999, testDb);
      expect(gviDetail).toBeNull();
    });

    it("getGviDetailByResultId returns GVI data with ISO string dates", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 28,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const gviPayload = {
        kind: "gvi" as const,
        version: 1 as const,
        condition: "not_ok" as const,
      };

      await writeTypedDetail("GVI", gviPayload, result!.resultId!, testDb);

      const gviDetail = await getGviDetailByResultId(result!.resultId!, testDb);
      expect(gviDetail).not.toBeNull();
      expect(gviDetail!.condition).toBe("not_ok");

      // Verify dates are ISO strings (not Date objects)
      expect(typeof gviDetail!.createdAt).toBe("string");
      expect(typeof gviDetail!.updatedAt).toBe("string");
      expect(gviDetail!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("deleting result cascades to GVI detail", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 29,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const gviPayload = {
        kind: "gvi" as const,
        version: 1 as const,
        condition: "ok" as const,
      };

      await writeTypedDetail("GVI", gviPayload, result!.resultId!, testDb);

      // Verify GVI data exists
      const gviDetailBefore = await getGviDetailByResultId(result!.resultId!, testDb);
      expect(gviDetailBefore).not.toBeNull();

      // Delete result
      await deleteResult(result!.resultId!, testDb);

      // Verify GVI data was cascade deleted
      const gviDetailAfter = await getGviDetailByResultId(result!.resultId!, testDb);
      expect(gviDetailAfter).toBeNull();

      // Verify result is gone
      const resultAfter = await getResultById(result!.resultId!, testDb);
      expect(resultAfter).toBeNull();
    });
  });

  describe("CVI typed detail (Phase 6)", () => {
    it("writeTypedDetail creates CVI record with condition", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 30,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "CVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const cviPayload = {
        kind: "cvi" as const,
        version: 1 as const,
        datumReference: "Datum A",
        memberType: "brace" as const,
        positions: [
          { clockPosition: "12", utMm: 10.5, findings: "Clean" },
        ],
        cpPotentialMv: -850,
      };

      await writeTypedDetail("CVI", cviPayload, result!.resultId!, testDb);

      // Verify CVI detail was created
      const cviDetail = await getCviDetailByResultId(result!.resultId!, testDb);
      expect(cviDetail).not.toBeNull();
      expect(cviDetail!.memberType).toBe("brace");
      expect(cviDetail!.cpPotentialMv).toBe(-850);
      expect(cviDetail!.positions).toHaveLength(1);
      expect(cviDetail!.resultId).toBe(result!.resultId);
    });

    it("getCviDetailByResultId returns null for non-existent result", async () => {
      const cviDetail = await getCviDetailByResultId(999, testDb);
      expect(cviDetail).toBeNull();
    });

    it("getCviDetailByResultId returns CVI data with ISO string dates", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 31,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "CVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const cviPayload = {
        kind: "cvi" as const,
        version: 1 as const,
        datumReference: "Datum B",
        memberType: "chord" as const,
        positions: [],
        cpPotentialMv: -1200,
      };

      await writeTypedDetail("CVI", cviPayload, result!.resultId!, testDb);

      const cviDetail = await getCviDetailByResultId(result!.resultId!, testDb);
      expect(cviDetail).not.toBeNull();
      expect(cviDetail!.memberType).toBe("chord");
      expect(cviDetail!.cpPotentialMv).toBe(-1200);

      // Verify dates are ISO strings (not Date objects)
      expect(typeof cviDetail!.createdAt).toBe("string");
      expect(typeof cviDetail!.updatedAt).toBe("string");
      expect(cviDetail!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("deleting result cascades to CVI detail", async () => {
      const project = await testDb
        .insert(schema.project)
        .values({
          displayNumber: 1,
          title: "Test Project",
        })
        .returning()
        .then((rows) => rows[0]!);

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 32,
          projectId: project.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project.projectId,
          assetId: asset.assetId,
          itemLabel: "Item 1",
          position: "POS-001",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);

      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({
          sessionId: session.sessionId,
          itemId: item.itemId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const result = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "CVI",
          projectId: project.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const cviPayload = {
        kind: "cvi" as const,
        version: 1 as const,
        datumReference: "Datum A",
        memberType: "chord" as const,
        positions: [],
        cpPotentialMv: null,
      };

      await writeTypedDetail("CVI", cviPayload, result!.resultId!, testDb);

      // Verify CVI data exists
      const cviDetailBefore = await getCviDetailByResultId(result!.resultId!, testDb);
      expect(cviDetailBefore).not.toBeNull();

      // Delete result
      await deleteResult(result!.resultId!, testDb);

      // Verify CVI data was cascade deleted
      const cviDetailAfter = await getCviDetailByResultId(result!.resultId!, testDb);
      expect(cviDetailAfter).toBeNull();

      // Verify result is gone
      const resultAfter = await getResultById(result!.resultId!, testDb);
      expect(resultAfter).toBeNull();
    });
  });

  describe("listProjectSummary / getResultEvidence (event recorder)", () => {
    // Compact skeleton seed for one project (project/session/asset/component/item/session_item).
    const seedSkeleton = async (projectId: number, label: string) => {
      await testDb.insert(schema.project).values({ displayNumber: projectId, projectId, title: label });
      const session = await testDb
        .insert(schema.session)
        .values({ displayNumber: 33, projectId, name: `${label}-S` })
        .returning()
        .then((rows) => rows[0]!);
      const asset = await testDb
        .insert(schema.asset)
        .values({ projectId, name: `${label}-A`, assetType: "Structure" })
        .returning()
        .then((rows) => rows[0]!);
      const component = await testDb
        .insert(schema.component)
        .values({ assetId: asset.assetId, projectId, name: `${label}-C` })
        .returning()
        .then((rows) => rows[0]!);
      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId,
          assetId: asset.assetId,
          itemLabel: `${label}-I`,
          position: "P",
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]!);
      const sessionItem = await testDb
        .insert(schema.sessionItem)
        .values({ sessionId: session.sessionId, itemId: item.itemId })
        .returning()
        .then((rows) => rows[0]!);

      return { session, asset, component, item, sessionItem };
    };

    const setCreatedAt = async (resultId: number, iso: string) =>
      testDb
        .update(schema.result)
        .set({ createdAt: new Date(iso) })
        .where(eq(schema.result.resultId, resultId));

    it("returns the project's results newest-first with per-type resultValue", async () => {
      const { asset, component, item, session, sessionItem } = await seedSkeleton(1, "P1");

      const mk = (code: "GVI" | "CVI" | "MGI" | "CP" | "FMD") =>
        createResult(
          {
            sessionItemId: sessionItem.sessionItemId,
            inspectionTypeCode: code,
            projectId: 1,
            assetId: asset.assetId,
            componentId: component.componentId,
            itemId: item.itemId,
            sessionId: session.sessionId,
            remarks: code === "GVI" ? "gvi remarks" : null,
          },
          testDb,
        );

      const gvi = await mk("GVI");
      const cvi = await mk("CVI");
      const mgi = await mk("MGI");
      const cp = await mk("CP");
      const fmd = await mk("FMD");

      await writeTypedDetail("GVI", { kind: "gvi", version: 1, gviCP: null, gviUT: null, condition: "ok" }, gvi!.resultId, testDb);
      await writeTypedDetail("CVI", { kind: "cvi", version: 1, datumReference: "Datum A", memberType: "chord", positions: [], cpPotentialMv: null }, cvi!.resultId, testDb);
      await writeTypedDetail(
        "MGI",
        {
          kind: "mgi",
          version: 1,
          noMgObserved: false,
          criteria: { preset: "project_default" },
          findings: [
            { id: "f1", growthType: "hard", species: "Barnacles", coveragePercent: 60, thicknessMm: 20 },
          ],
        },
        mgi!.resultId,
        testDb,
      );
      await writeTypedDetail("CP", { kind: "cp", version: 1, anodeType: "alu", depletion: "none", voltageMv: -850 }, cp!.resultId, testDb);
      await writeTypedDetail("FMD", { kind: "fmd", version: 1, depthEl: 1, initialAttempt: "flooded", additionalAttempt1: "na", additionalAttempt2: "na", additionalAttempt3: "na" }, fmd!.resultId, testDb);

      // createdAt is second-resolution; pin each to a distinct instant so newest-first
      // ordering is deterministic.
      await setCreatedAt(gvi!.resultId, "2026-01-01T00:00:00Z");
      await setCreatedAt(cvi!.resultId, "2026-01-02T00:00:00Z");
      await setCreatedAt(mgi!.resultId, "2026-01-03T00:00:00Z");
      await setCreatedAt(cp!.resultId, "2026-01-04T00:00:00Z");
      await setCreatedAt(fmd!.resultId, "2026-01-05T00:00:00Z");

      const rows = await listProjectSummary(1, testDb);

      expect(rows).toHaveLength(5);
      // newest-first: FMD (Jan 5) → CP → MGI → CVI → GVI (Jan 1)
      expect(rows.map((r) => r.inspectionTypeCode)).toEqual(["FMD", "CP", "MGI", "CVI", "GVI"]);
      const byCode = Object.fromEntries(rows.map((r) => [r.inspectionTypeCode, r.resultValue]));
      expect(byCode.GVI).toBe("Good Condition");
      expect(byCode.CVI).toBe("CHORD | CP N/A");
      expect(byCode.CP).toBe("-850 mV");
      expect(byCode.FMD).toBe("Flooded");
      expect(byCode.MGI).toBe("1 findings");
      // IDs + remarks shipped (names resolved client-side).
      expect(rows[4]!.remarks).toBe("gvi remarks");
      expect(rows[4]!.assetId).toBe(asset.assetId);
      expect(rows[4]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("excludes archived results and other projects' results", async () => {
      const p1 = await seedSkeleton(1, "P1");
      const p2 = await seedSkeleton(2, "P2");

      const kept = await createResult(
        {
          sessionItemId: p1.sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: 1,
          assetId: p1.asset.assetId,
          componentId: p1.component.componentId,
          itemId: p1.item.itemId,
          sessionId: p1.session.sessionId,
        },
        testDb,
      );
      const archived = await createResult(
        {
          sessionItemId: p1.sessionItem.sessionItemId,
          inspectionTypeCode: "CP",
          projectId: 1,
          assetId: p1.asset.assetId,
          componentId: p1.component.componentId,
          itemId: p1.item.itemId,
          sessionId: p1.session.sessionId,
        },
        testDb,
      );
      await createResult(
        {
          sessionItemId: p2.sessionItem.sessionItemId,
          inspectionTypeCode: "FMD",
          projectId: 2,
          assetId: p2.asset.assetId,
          componentId: p2.component.componentId,
          itemId: p2.item.itemId,
          sessionId: p2.session.sessionId,
        },
        testDb,
      );

      // Soft-delete (archive) one of project 1's rows.
      await testDb
        .update(schema.result)
        .set({ archivedAt: new Date("2026-01-01T00:00:00Z") })
        .where(eq(schema.result.resultId, archived!.resultId));

      const rows = await listProjectSummary(1, testDb);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.resultId).toBe(kept!.resultId);
    });

    it("returns empty for a project with no results", async () => {
      const rows = await listProjectSummary(999, testDb);
      expect(rows).toEqual([]);
    });

    it("getResultEvidence returns the result's clips and images", async () => {
      const { asset, component, item, session, sessionItem } = await seedSkeleton(1, "P1");
      const resultRecord = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: 1,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const masterVideo = await createMasterVideo(
        { sessionId: session.sessionId, startEpoch: 1000 },
        testDb,
      );
      await createVideoClip(
        {
          resultId: resultRecord!.resultId,
          masterVideoId: masterVideo!.masterVideoId,
          startOffsetMs: 1000,
          endOffsetMs: 5000,
        },
        testDb,
      );
      await createResultImage(
        { resultId: resultRecord!.resultId, storageStem: "p1/s1/result_1" },
        testDb,
      );

      const evidence = await getResultEvidence(resultRecord!.resultId, testDb);
      expect(evidence.clips).toHaveLength(1);
      // no clip still producer yet: the card face is absent by design
      expect(evidence.clips[0]!.thumbnailUrl).toBeNull();
      expect(evidence.images).toHaveLength(1);
      expect(evidence.images[0]!.storageStem).toBe("p1/s1/result_1");
    });

    it("getResultEvidence returns empty arrays for a result with no media", async () => {
      const { asset, component, item, session, sessionItem } = await seedSkeleton(1, "P1");
      const resultRecord = await createResult(
        {
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: 1,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
        },
        testDb,
      );

      const evidence = await getResultEvidence(resultRecord!.resultId, testDb);
      expect(evidence.clips).toEqual([]);
      expect(evidence.images).toEqual([]);
    });
  });
});
