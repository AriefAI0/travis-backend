import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../helpers/db";
import * as schema from "../../src/db/schema";
import {
  MAX_ACTIVE_EXPORTS,
  cancelExcelExport,
  claimExcelExport,
  createExcelExport,
  getExcelExport,
  moveExcelExport,
  removeExcelExport,
  requestHashOf,
} from "../../src/db/services/excel-export.service";

beforeAll(ensureTestDatabase);
beforeEach(async () => {
  await truncateTestDatabase();
});
afterAll(closeTestDatabase);

const OWNER = "user-1";
const OTHER_OWNER = "user-2";

const seedProject = () =>
  testDb.insert(schema.project).values({
    organizationId: testOrgId,
    projectId: 1,
    displayNumber: 1,
    title: "Alpha",
  });

// one request, varied by target so the hash differs
const request = (targetId: number) => ({
  projectId: 1,
  types: ["GVI"] as const,
  targets: [`partCode:${targetId}`],
  media: "raw" as const,
});

// the production shape: the whole create runs in one transaction, so the
// advisory lock and the cap count hold under a race
const create = (targetId: number, owner = OWNER) =>
  testDb.transaction((tx) =>
    createExcelExport(
      { ...request(targetId), types: [...request(targetId).types] },
      testOrgId,
      owner,
      tx,
    ),
  );

const activeCount = async (owner = OWNER) =>
  (await testDb.select().from(schema.excelExport)).filter(
    (row) => row.ownerUserId === owner && ["queued", "running", "cancelling"].includes(row.status),
  ).length;

describe("excel export service", () => {
  it("returns the live row for the same request, whatever the order", async () => {
    await seedProject();

    const first = await create(300);
    const again = await createExcelExport(
      { projectId: 1, types: ["GVI"], targets: ["partCode:300"], media: "raw" },
      testOrgId,
      OWNER,
      testDb,
    );

    expect(again.id).toBe(first.id);
    expect(await activeCount()).toBe(1);
  });

  it("hashes the request without depending on list order", () => {
    const a = requestHashOf({ ...request(300), types: ["GVI", "CVI"], targets: ["partCode:2", "partCode:1"] });
    const b = requestHashOf({ ...request(300), types: ["CVI", "GVI"], targets: ["partCode:1", "partCode:2"] });
    expect(a).toBe(b);
  });

  it("refuses the sixth active export", async () => {
    await seedProject();
    for (let index = 0; index < MAX_ACTIVE_EXPORTS; index++) await create(300 + index);

    await expect(create(999)).rejects.toMatchObject({ code: "export_limit" });
    expect(await activeCount()).toBe(MAX_ACTIVE_EXPORTS);
  });

  it("leaves exactly five when two creates race at four active", async () => {
    await seedProject();
    for (let index = 0; index < MAX_ACTIVE_EXPORTS - 1; index++) await create(300 + index);

    const results = await Promise.allSettled([create(500), create(501)]);
    const created = results.filter((result) => result.status === "fulfilled").length;
    const refused = results.filter(
      (result) => result.status === "rejected" && (result.reason as { code?: string }).code === "export_limit",
    ).length;

    expect(created).toBe(1);
    expect(refused).toBe(1);
    expect(await activeCount()).toBe(MAX_ACTIVE_EXPORTS);
  });

  it("cancels a queued export at once and a running one through cancelling", async () => {
    await seedProject();
    const queued = await create(300);
    expect((await cancelExcelExport(queued.id, testOrgId, OWNER, testDb)).status).toBe("cancelled");

    const running = await create(301);
    await moveExcelExport(running.id, "queued", { status: "running" }, testDb);
    expect((await cancelExcelExport(running.id, testOrgId, OWNER, testDb)).status).toBe("cancelling");
  });

  it("leaves one terminal status when cancel races finish", async () => {
    await seedProject();
    const row = await create(300);
    await moveExcelExport(row.id, "queued", { status: "running" }, testDb);

    const [cancelMoved, finishMoved] = await Promise.all([
      moveExcelExport(row.id, "running", { status: "cancelling" }, testDb),
      moveExcelExport(row.id, "running", { status: "ready" }, testDb),
    ]);

    expect([cancelMoved, finishMoved].filter(Boolean)).toHaveLength(1);
    const settled = await getExcelExport(row.id, testOrgId, OWNER, testDb);
    expect(["cancelling", "ready"]).toContain(settled.status);
  });

  it("claims the oldest queued row with the row's own field names", async () => {
    await seedProject();
    const first = await create(300);
    await create(301);

    const claimed = await claimExcelExport("light", "excel-exports/light/one.xlsx", testDb);

    // a raw SQL claim once handed back snake_case columns; the worker read
    // undefined and stalled, so the shape is part of the contract
    expect(claimed).toMatchObject({
      id: first.id,
      status: "running",
      projectId: 1,
      packageKey: "excel-exports/light/one.xlsx",
      attempts: 1,
    });
  });

  it("hides another owner's export as missing", async () => {
    await seedProject();
    const row = await create(300);

    await expect(getExcelExport(row.id, testOrgId, OTHER_OWNER, testDb)).rejects.toMatchObject({
      code: "export_not_found",
    });
  });

  it("refuses to remove a live export", async () => {
    await seedProject();
    const row = await create(300);

    await expect(removeExcelExport(row.id, testOrgId, OWNER, testDb)).rejects.toMatchObject({
      code: "export_active",
    });
  });

  it("removes a finished export", async () => {
    await seedProject();
    const row = await create(300);
    await moveExcelExport(row.id, "queued", { status: "ready" }, testDb);

    await removeExcelExport(row.id, testOrgId, OWNER, testDb);
    await expect(getExcelExport(row.id, testOrgId, OWNER, testDb)).rejects.toMatchObject({
      code: "export_not_found",
    });
  });
});
