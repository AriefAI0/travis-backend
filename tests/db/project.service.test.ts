import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";
import {
  createProject,
  deleteProject,
  getProjectById,
  listDashboard,
  listProjects,
  updateProject,
} from "../../src/db/services/project.service";
import { createAssetRecord } from "../../src/db/repositories/asset.repository";
import { createComponentRecord } from "../../src/db/repositories/component.repository";
import { createItemRecord } from "../../src/db/repositories/item.repository";
import { createSessionRecord } from "../../src/db/repositories/session.repository";
import { createSessionItemRecord } from "../../src/db/repositories/session-item.repository";
import { createResultRecord } from "../../src/db/repositories/result.repository";

describe("project.service", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  it("creates a project", async () => {
    const createdProject = await createProject(
      {
        title: "Project Alpha",
        description: "Initial campaign",
        documentId: "DOC-001",
      },
      testDb,
    );

    expect(createdProject).not.toBeNull();
    expect(createdProject!.title).toBe("Project Alpha");
    expect(createdProject!.description).toBe("Initial campaign");
    expect(createdProject!.documentId).toBe("DOC-001");
  });

  // The ordinal a user reads and every media key carries: 1, 2, 3 — never the
  // identity column, which is global and never reused.
  it("numbers projects sequentially from one", async () => {
    const first = await createProject({ title: "Alpha" }, testDb);
    const second = await createProject({ title: "Beta" }, testDb);
    const third = await createProject({ title: "Gamma" }, testDb);

    expect([first!.displayNumber, second!.displayNumber, third!.displayNumber]).toEqual([1, 2, 3]);
  });

  // Deleting the newest frees its number for the next create: the operator's
  // expectation. Delete a middle one and the gap stays, because renumbering
  // would break every frozen media key and stored reference.
  it("reuses the number of the newest deleted project, and keeps a middle gap", async () => {
    const first = await createProject({ title: "Alpha" }, testDb);
    const second = await createProject({ title: "Beta" }, testDb);

    await deleteProject(second!.projectId, testDb);
    const reused = await createProject({ title: "Gamma" }, testDb);
    expect(reused!.displayNumber).toBe(second!.displayNumber);

    // now delete the FIRST one: its number is stranded, so the next is max+1
    await deleteProject(first!.projectId, testDb);
    const afterGap = await createProject({ title: "Delta" }, testDb);
    expect(afterGap!.displayNumber).toBe(3);
  });

  // The original bug: a deleted project left the next one numbered 57.
  it("numbers the next project by count, not by the identity column", async () => {
    const first = await createProject({ title: "Alpha" }, testDb);
    await createProject({ title: "Beta" }, testDb);
    await deleteProject(first!.projectId, testDb);

    const replacement = await createProject({ title: "Gamma" }, testDb);

    expect(replacement!.displayNumber).toBe(3);
    // the ordinal is not the identity: the two diverge as soon as anything is
    // deleted, which is the whole reason the folders stopped showing PKs
    expect(replacement!.projectId).not.toBe(replacement!.displayNumber);
  });

  it("lists projects", async () => {
    await createProject(
      {
        title: "Project 1",
      },
      testDb,
    );

    await createProject(
      {
        title: "Project 2",
      },
      testDb,
    );

    const projects = await listProjects(testDb);

    expect(projects).toHaveLength(2);
    expect(projects[0]!.title).toBe("Project 1");
    expect(projects[1]!.title).toBe("Project 2");
  });

  it("lists dashboard", async () => {
    const project1 = await createProject(
      {
        title: "Project 1",
      },
      testDb,
    );

    await createProject(
      {
        title: "Project 2",
      },
      testDb,
    );

    const dashboard = await listDashboard(testDb);

    expect(dashboard).toHaveLength(2);
    expect(dashboard[0]!.projectId).toBe(project1!.projectId);
  });

  it("computes dashboard progress from item.status, not results", async () => {
    const projectRecord = await createProject({ title: "Progress Project" }, testDb);

    const assetRecord = await createAssetRecord(
      { projectId: projectRecord!.projectId, name: "Asset 1" },
      testDb,
    );
    const componentRecord = await createComponentRecord(
      {
        projectId: projectRecord!.projectId,
        assetId: assetRecord!.assetId,
        name: "Component 1",
      },
      testDb,
    );

    const baseItem = {
      projectId: projectRecord!.projectId,
      assetId: assetRecord!.assetId,
      componentId: componentRecord!.componentId,
    };

    // itemA: marked complete — should count toward progress.
    await createItemRecord(
      { ...baseItem, itemLabel: "A", status: "complete" },
      testDb,
    );

    // itemB: not_set but carries a result — must NOT count under status-based progress.
    const itemB = await createItemRecord(
      { ...baseItem, itemLabel: "B", status: "not_set" },
      testDb,
    );

    const sessionRecord = await createSessionRecord(
      { projectId: projectRecord!.projectId, displayNumber: 1 },
      testDb,
    );
    const sessionItemRecord = await createSessionItemRecord(
      { sessionId: sessionRecord!.sessionId, itemId: itemB!.itemId },
      testDb,
    );
    await createResultRecord(
      {
        sessionItemId: sessionItemRecord!.sessionItemId,
        inspectionTypeCode: "GVI",
        projectId: projectRecord!.projectId,
        assetId: assetRecord!.assetId,
        componentId: componentRecord!.componentId,
        itemId: itemB!.itemId,
        sessionId: sessionRecord!.sessionId,
        displayNumber: 1,
      },
      testDb,
    );

    const dashboard = await listDashboard(testDb);
    const row = dashboard.find(
      (entry) => entry.projectId === projectRecord!.projectId,
    );

    expect(row).toBeDefined();
    expect(row!.totalItems).toBe(2);
    expect(row!.completedItems).toBe(1);
    expect(row!.overallProgress).toBe(50);
    expect(row!.pendingItems).toBe(1);
  });

  it("gets project by id", async () => {
    const createdProject = await createProject(
      {
        title: "Test Project",
      },
      testDb,
    );

    const foundProject = await getProjectById(createdProject!.projectId, testDb);

    expect(foundProject).not.toBeNull();
    expect(foundProject!.projectId).toBe(createdProject!.projectId);
    expect(foundProject!.title).toBe("Test Project");
  });

  it("updates project", async () => {
    const createdProject = await createProject(
      {
        title: "Original Title",
      },
      testDb,
    );

    const updatedProject = await updateProject(
      createdProject!.projectId,
      {
        title: "Updated Title",
      },
      testDb,
    );

    expect(updatedProject).not.toBeNull();
    expect(updatedProject!.title).toBe("Updated Title");
  });

  it("deletes project", async () => {
    const createdProject = await createProject(
      {
        title: "To Delete",
      },
      testDb,
    );

    const deletedProject = await deleteProject(createdProject!.projectId, testDb);

    expect(deletedProject).not.toBeNull();
    expect(deletedProject!.projectId).toBe(createdProject!.projectId);

    const foundProject = await getProjectById(createdProject!.projectId, testDb);
    expect(foundProject).toBeNull();
  });

  describe("with hierarchy data", () => {
    beforeEach(async () => {
      await truncateTestDatabase();
    });

    it("creates project with asset, component, item, session, sessionItem, result, videoClip, masterVideo", async () => {
      const project = await createProject(
        {
          title: "Full Hierarchy",
        },
        testDb,
      );

      const session = await testDb
        .insert(schema.session)
        .values({
          displayNumber: 1,
          projectId: project!.projectId,
          name: "Session 1",
          startedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);

      const asset = await testDb
        .insert(schema.asset)
        .values({
          projectId: project!.projectId,
          name: "Asset 1",
          assetType: "Structure",
        })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.component)
        .values({
          assetId: asset.assetId,
          projectId: project!.projectId,
          name: "Component 1",
        })
        .returning()
        .then((rows) => rows[0]!);

      const item = await testDb
        .insert(schema.item)
        .values({
          componentId: component.componentId,
          projectId: project!.projectId,
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

      const result = await testDb
        .insert(schema.result)
        .values({
          displayNumber: 8001,
          resultId: 8001,
          sessionItemId: sessionItem.sessionItemId,
          inspectionTypeCode: "GVI",
          projectId: project!.projectId,
          assetId: asset.assetId,
          componentId: component.componentId,
          itemId: item.itemId,
          sessionId: session.sessionId,
          remarks: "Test result",
        })
        .returning()
        .then((rows) => rows[0]!);

      const masterVideo = await testDb
        .insert(schema.masterVideo)
        .values({
          masterVideoId: 9001,
          sessionId: session.sessionId,
          // pg integer columns reject fractional seconds — floor the epoch
          startEpoch: Math.floor(Date.now() / 1000),
        })
        .returning()
        .then((rows) => rows[0]!);

      const clip = await testDb
        .insert(schema.videoClip)
        .values({
          clipId: 10001,
          resultId: result.resultId,
          masterVideoId: masterVideo.masterVideoId,
          startOffsetMs: 0,
        })
        .returning()
        .then((rows) => rows[0]!);

      expect(project!.projectId).toBe(asset.projectId);
      expect(asset.assetId).toBe(component.assetId);
      expect(component.componentId).toBe(item.componentId);
      expect(result.sessionItemId).toBe(sessionItem.sessionItemId);
      expect(result.inspectionTypeCode).toBe("GVI");
      expect(result.projectId).toBe(project!.projectId);
      expect(result.assetId).toBe(asset.assetId);
      expect(result.componentId).toBe(component.componentId);
      expect(result.itemId).toBe(item.itemId);
      expect(result.sessionId).toBe(session.sessionId);
      expect(clip.masterVideoId).toBe(masterVideo.masterVideoId);
    });
  });
});
