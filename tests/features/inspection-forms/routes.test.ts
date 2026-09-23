import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { inspectionFormRoutes } from "../../../src/features/inspection-forms/routes";
import { projectRoutes } from "../../../src/features/projects/routes";

const app = appFor(testDb, inspectionFormRoutes, projectRoutes);

const post = async (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const seedProject = async () => {
  const res = await post("/api/v1/projects", { title: "Alpha" });
  return (await json(res)).data.projectId as number;
};

const getForm = (projectId: number) =>
  app.request(`/api/v1/projects/${projectId}/inspection-forms/GVI`);

// flow: seed v1 > save versions > reject bad labels
describe("inspection form routes", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);
  beforeEach(truncateTestDatabase);

  it("seeds version 1 with built-in fields on first read", async () => {
    const projectId = await seedProject();

    const res = await getForm(projectId);
    expect(res.status).toBe(200);
    const form = (await json(res)).data as Record<string, any>;

    expect(form.version).toBe(1);
    const builtins = form.fields.filter((f: Record<string, any>) => f.isBuiltin);
    expect(builtins.map((f: Record<string, any>) => f.label)).toEqual([
      "CP mV",
      "UT mm",
      "Condition",
    ]);
    expect(form.fields.filter((f: Record<string, any>) => !f.isBuiltin)).toEqual([]);
  });

  it("saves a new version with custom fields and keeps builtins", async () => {
    const projectId = await seedProject();
    await getForm(projectId);

    const saved = await post(`/api/v1/projects/${projectId}/inspection-forms/GVI/versions`, {
      customFields: [
        { label: "Clamp note", dataType: "text", required: false, displayOrder: 0 },
        { label: "Anode count", dataType: "integer", required: true, displayOrder: 1 },
      ],
    });
    expect(saved.status).toBe(201);
    const form = (await json(saved)).data as Record<string, any>;

    expect(form.version).toBe(2);
    const builtins = form.fields.filter((f: Record<string, any>) => f.isBuiltin);
    expect(builtins).toHaveLength(3);
    const customs = form.fields.filter((f: Record<string, any>) => !f.isBuiltin);
    expect(customs).toHaveLength(2);
    expect(customs.find((f: Record<string, any>) => f.label === "Anode count").required).toBe(true);
  });

  it("rejects duplicate custom labels and reserved builtin labels", async () => {
    const projectId = await seedProject();
    await getForm(projectId);

    const dup = await post(`/api/v1/projects/${projectId}/inspection-forms/GVI/versions`, {
      customFields: [
        { label: "Clamp note", dataType: "text", displayOrder: 0 },
        { label: "Clamp note", dataType: "text", displayOrder: 1 },
      ],
    });
    expect(dup.status).toBe(400);

    const reserved = await post(`/api/v1/projects/${projectId}/inspection-forms/GVI/versions`, {
      customFields: [{ label: "Condition", dataType: "text", displayOrder: 0 }],
    });
    expect(reserved.status).toBe(400);
  });

  it("rejects an unknown inspection type code", async () => {
    const projectId = await seedProject();
    const res = await app.request(`/api/v1/projects/${projectId}/inspection-forms/NOPE`);
    expect(res.status).toBe(400);
  });

  it("bumps the version per save and freezes earlier versions", async () => {
    const projectId = await seedProject();
    await getForm(projectId);

    for (const label of ["First extra", "Second extra"]) {
      await post(`/api/v1/projects/${projectId}/inspection-forms/GVI/versions`, {
        customFields: [{ label, dataType: "text", displayOrder: 0 }],
      });
    }

    const current = (await json(await getForm(projectId))).data as Record<string, any>;
    expect(current.version).toBe(3);
    // old versions keep their own rows: v1 has 3 builtin fields only
    const rows = await testDb.query.inspectionFormField.findMany({
      where: undefined,
    });
    const versionFormIds = new Set(
      (
        await testDb.query.inspectionForm.findMany({
          where: undefined,
        })
      ).map((f: Record<string, any>) => f.inspectionFormId),
    );
    expect(versionFormIds.size).toBe(3);
    // v1: 3 builtins; v2 and v3: 3 builtins + 1 custom each
    expect(rows.length).toBe(3 + 4 + 4);
  });
});
