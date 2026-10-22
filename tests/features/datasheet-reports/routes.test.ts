import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { appFor } from "../../helpers/app";
import { createTestUser } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  testOrgId,
  truncateTestDatabase,
} from "../../helpers/db";
import { datasheetRoutes } from "../../../src/features/datasheet-reports/routes";
import { env } from "../../../src/config/env";
import * as schema from "../../../src/db/schema";

const require = createRequire(import.meta.url);
const PizZip = require("pizzip");

const app = appFor(testDb, datasheetRoutes);

// minted per test in beforeEach; every request below carries it
let adminToken = "";

// soffice ships in the runtime image. A dev host may not carry it, and the PDF
// half of the flow needs the real binary.
const sofficeAvailable = Bun.which(env.SOFFICE_PATH) !== null;

beforeAll(ensureTestDatabase);
beforeEach(async () => {
  await truncateTestDatabase();
  adminToken = (await createTestUser({ preset: "Admin" })).token;
});
afterAll(closeTestDatabase);

// project > group > code > description > type > part code > result
const seed = async () => {
  await testDb.insert(schema.project).values({
    organizationId: testOrgId,
    projectId: 1,
    displayNumber: 1,
    title: "Alpha",
    documentId: "DOC-1",
  });
  await testDb.insert(schema.session).values({
    sessionId: 101,
    projectId: 1,
    displayNumber: 1,
    name: "Run 1",
  });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 1, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 10, taskGroupId: 1, code: "101" });
  await testDb.insert(schema.description).values({ descriptionId: 100, taskCodeId: 10, label: "Leg A" });
  await testDb.insert(schema.type).values({ typeId: 200, descriptionId: 100, code: "T1" });
  await testDb.insert(schema.partCode).values({ partCodeId: 300, typeId: 200, code: "P1" });
  await testDb.insert(schema.result).values({
    resultId: 5001,
    displayNumber: 1,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "GVI",
    partCodeId: 300,
    layer: 1,
    masterStartMs: 0,
    remarks: "looks fine",
  });
  await testDb.insert(schema.resultGvi).values({ resultId: 5001, depthEl: 1.25, condition: "ok" });
};

type DatasheetBody = {
  datasheetId: string;
  name: string;
  kind: string;
  status: string;
  errorDetail: string | null;
  pdfError: string | null;
};

const readData = async <T>(res: Response): Promise<T> =>
  ((await res.json()) as { data: T }).data;

const preview = (body: Record<string, unknown>) =>
  authRequest("/api/v1/projects/1/datasheets/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const generate = (body: Record<string, unknown>) =>
  authRequest("/api/v1/projects/1/datasheets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const statusOf = async (datasheetId: string) =>
  readData<DatasheetBody>(await authRequest(`/api/v1/datasheets/${datasheetId}`));

// The render runs after the POST answers, so wait for the row to settle.
const waitForRender = async (datasheetId: string) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const row = await statusOf(datasheetId);
    if (row.status !== "generating") return row;
    await Bun.sleep(250);
  }

  throw new Error(`datasheet ${datasheetId} never left generating`);
};

describe("datasheet reports", () => {
  it("previews every card's count and one card's rows", async () => {
    await seed();

    const res = await preview({ targets: ["partCode:300"], kind: "GVI" });
    expect(res.status).toBe(200);

    const body = await readData<{
      counts: Record<string, number>;
      preview: { columns: string[]; rows: Record<string, string>[] } | null;
    }>(res);

    expect(body.counts).toMatchObject({ GVI: 1, CP_ANODE: 0, FMD: 0, SCOUR: 0 });
    expect(body.preview?.columns).toContain("component_id");
    expect(body.preview?.rows[0]).toMatchObject({
      component_id: "P1",
      component_type: "T1",
      depth_el: "1.25",
      condition: "Good Condition",
    });
  });

  it("generates a sheet that renders and stores its document", async () => {
    await seed();

    const res = await generate({ kind: "GVI", targets: ["partCode:300"] });
    expect(res.status).toBe(202);

    const created = await readData<DatasheetBody>(res);
    expect(created.name).toMatch(/^GVI \d{4}-\d{2}-\d{2}$/);

    const row = await waitForRender(created.datasheetId);
    expect(row.status).toBe("ready");
    expect(row.errorDetail).toBeNull();

    const docx = await authRequest(`/api/v1/datasheets/${created.datasheetId}/docx`);
    expect(docx.status).toBe(200);
    expect(docx.headers.get("content-disposition")).toContain(".docx");

    const xml = new PizZip(Buffer.from(await docx.arrayBuffer()))
      .file("word/document.xml")
      .asText() as string;
    expect(xml).toContain("P1");
    expect(xml).toContain("Good Condition");
    expect(xml).not.toMatch(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
  }, 30_000);

  it.skipIf(!sofficeAvailable)("stores the PDF next to the document", async () => {
    await seed();

    const { datasheetId } = await readData<DatasheetBody>(
      await generate({ kind: "GVI", targets: ["partCode:300"] }),
    );
    const row = await waitForRender(datasheetId);

    expect(row.pdfError).toBeNull();

    const pdf = await authRequest(`/api/v1/datasheets/${datasheetId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
  }, 60_000);

  it("keeps the document when the PDF conversion failed", async () => {
    await seed();

    const { datasheetId } = await readData<DatasheetBody>(
      await generate({ kind: "GVI", targets: ["partCode:300"] }),
    );
    const row = await waitForRender(datasheetId);

    // no soffice on this host: the render degrades and still reaches ready
    if (!sofficeAvailable) {
      expect(row.pdfError).not.toBeNull();
    }

    const pdf = await authRequest(`/api/v1/datasheets/${datasheetId}/pdf`);
    if (row.pdfError === null) {
      expect(pdf.status).toBe(200);
      return;
    }

    expect(pdf.status).toBe(409);
    expect((await pdf.json()).code).toBe("pdf_unavailable");

    const docx = await authRequest(`/api/v1/datasheets/${datasheetId}/docx`);
    expect(docx.status).toBe(200);
  }, 30_000);

  it("refuses a kind with no template", async () => {
    await seed();

    const res = await generate({ kind: "DVI", targets: ["partCode:300"] });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("datasheet_template_missing");
  });

  it("rejects a target key that names no kind", async () => {
    await seed();

    const res = await generate({ kind: "GVI", targets: ["part_code:300"] });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_error");
  });

  it("answers 404 for an unknown project", async () => {
    const res = await authRequest("/api/v1/projects/999/datasheets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "GVI", targets: ["partCode:300"] }),
    });

    expect(res.status).toBe(404);
  });

  it("lists and deletes a generated sheet", async () => {
    await seed();

    const { datasheetId } = await readData<DatasheetBody>(
      await generate({ kind: "GVI", targets: ["partCode:300"] }),
    );
    await waitForRender(datasheetId);

    const list = await readData<DatasheetBody[]>(
      await authRequest("/api/v1/projects/1/datasheets"),
    );
    expect(list.map((row) => row.datasheetId)).toContain(datasheetId);

    const removed = await authRequest(`/api/v1/datasheets/${datasheetId}`, { method: "DELETE" });
    expect(removed.status).toBe(200);

    const gone = await authRequest(`/api/v1/datasheets/${datasheetId}`);
    expect(gone.status).toBe(404);
  }, 30_000);
});

// every request carries the Admin token minted in beforeEach
const authRequest = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...((init.headers ?? {}) as Record<string, string>),
      authorization: `Bearer ${adminToken}`,
    },
  });
