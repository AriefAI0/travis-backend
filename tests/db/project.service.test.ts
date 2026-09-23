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
import { createSessionRecord } from "../../src/db/repositories/session.repository";
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

  it("counts progress from stopped results, not from targets alone", async () => {
    const projectRecord = await createProject({ title: "Progress Project" }, testDb);
    const projectId = projectRecord!.projectId;

    const group = await testDb
      .insert(schema.taskGroup)
      .values({ projectId, groupCode: "100", label: "Rows" })
      .returning()
      .then((rows) => rows[0]!);
    const taskCode = await testDb
      .insert(schema.taskCode)
      .values({ taskGroupId: group.taskGroupId, code: "101", label: "Row A" })
      .returning()
      .then((rows) => rows[0]!);
    const componentA = await testDb
      .insert(schema.mainComponent)
      .values({ taskCodeId: taskCode.taskCodeId, description: "A" })
      .returning()
      .then((rows) => rows[0]!);
    const componentB = await testDb
      .insert(schema.mainComponent)
      .values({ taskCodeId: taskCode.taskCodeId, description: "B" })
      .returning()
      .then((rows) => rows[0]!);
    const sessionRecord = await testDb
      .insert(schema.session)
      .values({ projectId, displayNumber: 1 })
      .returning()
      .then((rows) => rows[0]!);
    const form = await testDb
      .insert(schema.inspectionForm)
      .values({ projectId, inspectionTypeCode: "GVI", version: 1 })
      .returning()
      .then((rows) => rows[0]!);

    // A is stopped (has an end anchor) so it counts; B is still open.
    await testDb.insert(schema.result).values({
      projectId,
      sessionId: sessionRecord.sessionId,
      inspectionTypeCode: "GVI",
      mainComponentId: componentA.mainComponentId,
      layer: 1,
      masterStartMs: 0,
      masterEndMs: 5000,
      displayNumber: 1,
      inspectionFormId: form.inspectionFormId,
    });
    await testDb.insert(schema.result).values({
      projectId,
      sessionId: sessionRecord.sessionId,
      inspectionTypeCode: "GVI",
      mainComponentId: componentB.mainComponentId,
      layer: 2,
      masterStartMs: 0,
      displayNumber: 2,
      inspectionFormId: form.inspectionFormId,
    });

    const dashboard = await listDashboard(testDb);
    const row = dashboard.find((entry) => entry.projectId === projectId);

    expect(row).toBeDefined();
    expect(row!.totalAssets).toBe(1); // task groups
    expect(row!.totalComponents).toBe(1); // task codes
    expect(row!.totalItems).toBe(2); // inspectable targets
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

  describe("with v2 hierarchy data", () => {
    beforeEach(async () => {
      await truncateTestDatabase();
    });

    it("creates project with task group, task code, component, type, component code, session, result, clip, master", async () => {
      const project = await createProject({ title: "Full Hierarchy" }, testDb);

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

      const group = await testDb
        .insert(schema.taskGroup)
        .values({ projectId: project!.projectId, groupCode: "100", label: "Rows" })
        .returning()
        .then((rows) => rows[0]!);

      const taskCode = await testDb
        .insert(schema.taskCode)
        .values({ taskGroupId: group.taskGroupId, code: "101", label: "Row A" })
        .returning()
        .then((rows) => rows[0]!);

      const component = await testDb
        .insert(schema.mainComponent)
        .values({ taskCodeId: taskCode.taskCodeId, description: "Row A" })
        .returning()
        .then((rows) => rows[0]!);

      const componentType = await testDb
        .insert(schema.componentType)
        .values({ projectId: project!.projectId, typeCode: "VDM", label: "Vertical Diagonal Member" })
        .returning()
        .then((rows) => rows[0]!);

      const branch = await testDb
        .insert(schema.mainComponentType)
        .values({
          mainComponentId: component.mainComponentId,
          componentTypeId: componentType.componentTypeId,
        })
        .returning()
        .then((rows) => rows[0]!);

      const componentCode = await testDb
        .insert(schema.componentCode)
        .values({ mainComponentTypeId: branch.mainComponentTypeId, code: "101-105" })
        .returning()
        .then((rows) => rows[0]!);

      const form = await testDb
        .insert(schema.inspectionForm)
        .values({ projectId: project!.projectId, inspectionTypeCode: "GVI", version: 1 })
        .returning()
        .then((rows) => rows[0]!);

      const master = await testDb
        .insert(schema.masterVideo)
        .values({ sessionId: session.sessionId, startEpoch: 1000 })
        .returning()
        .then((rows) => rows[0]!);

      const result = await testDb
        .insert(schema.result)
        .values({
          displayNumber: 8001,
          resultId: 8001,
          inspectionTypeCode: "GVI",
          projectId: project!.projectId,
          sessionId: session.sessionId,
          componentCodeId: componentCode.componentCodeId,
          layer: 1,
          masterStartMs: 0,
          inspectionFormId: form.inspectionFormId,
          remarks: "Test result",
        })
        .returning()
        .then((rows) => rows[0]!);

      const clip = await testDb
        .insert(schema.videoClip)
        .values({
          resultId: result.resultId,
          masterVideoId: master.masterVideoId,
          startOffsetMs: 0,
        })
        .returning()
        .then((rows) => rows[0]!);

      expect(result.resultId).toBe(8001);
      expect(clip.resultId).toBe(result.resultId);
      expect(clip.clipId).toBeGreaterThan(0);
      expect(master.sessionId).toBe(session.sessionId);
      expect(componentCode.mainComponentTypeId).toBe(branch.mainComponentTypeId);
      expect(branch.mainComponentId).toBe(component.mainComponentId);
    });
  });
});
