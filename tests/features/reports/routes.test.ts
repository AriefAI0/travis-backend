import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { appFor } from "../../helpers/app";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { reportRoutes } from "../../../src/features/reports/routes";
import { convertDocxToPdf } from "../../../src/lib/pdf/convert";
import { AppError } from "../../../src/lib/error";
import { env } from "../../../src/config/env";
import * as schema from "../../../src/db/schema";

const app = appFor(testDb, reportRoutes);

// soffice ships in the runtime image. A dev host may not carry it, and the
// conversion test needs the real binary.
const sofficeAvailable = Bun.which(env.SOFFICE_PATH) !== null;
if (!sofficeAvailable) {
  console.log(
    "soffice is absent — the PDF conversion test is skipped (install libreoffice-writer)",
  );
}

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const seedProject = () =>
  testDb.insert(schema.project).values({ projectId: 1, displayNumber: 1, title: "Alpha" });

type ReportBody = { reportId: string; name: string; status: string };

// every ok() response wraps its payload in `data`
const readData = async <T>(res: Response): Promise<T> =>
  ((await res.json()) as { data: T }).data;

const generate = async (name = "Alpha 2026-10-11"): Promise<ReportBody> => {
  const res = await app.request("/api/v1/projects/1/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });

  expect(res.status).toBe(202);
  return readData<ReportBody>(res);
};

const statusOf = async (reportId: string) => {
  const res = await app.request(`/api/v1/reports/${reportId}`);
  expect(res.status).toBe(200);

  return readData<{ name: string; status: string; errorDetail: string | null }>(res);
};

// The render runs after the POST answers, so wait for the row to settle.
const waitForRender = async (reportId: string) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const report = await statusOf(reportId);
    if (report.status !== "generating") return report;
    await Bun.sleep(250);
  }

  throw new Error(`report ${reportId} never left generating`);
};

describe("report generation", () => {
  it("answers 202 with a row that starts generating", async () => {
    await seedProject();

    const report = await generate();

    expect(report.reportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.name).toBe("Alpha 2026-10-11");
    expect(["generating", "ready"]).toContain(report.status);
  }, 20_000);

  it("renders the stored document and flips the row to ready", async () => {
    await seedProject();

    const { reportId } = await generate();
    const report = await waitForRender(reportId);

    expect(report.status).toBe("ready");
    expect(report.errorDetail).toBeNull();
  }, 20_000);

  it("answers 404 for an unknown project", async () => {
    const res = await app.request("/api/v1/projects/999/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });

    expect(res.status).toBe(404);
  });

  it("rejects a name that is empty once trimmed", async () => {
    await seedProject();

    const res = await app.request("/api/v1/projects/1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });

    expect(res.status).toBe(400);
  });
});

describe("report list", () => {
  it("lists one project's reports, newest first", async () => {
    await seedProject();
    const first = await generate("First");
    const second = await generate("Second");

    const res = await app.request("/api/v1/projects/1/reports");
    expect(res.status).toBe(200);

    const reports = await readData<{ reportId: string; name: string }[]>(res);

    expect(reports).toHaveLength(2);
    expect(reports[0]?.reportId).toBe(second.reportId);
    expect(reports[1]?.reportId).toBe(first.reportId);
  }, 20_000);

  it("answers 404 for an unknown project", async () => {
    const res = await app.request("/api/v1/projects/999/reports");

    expect(res.status).toBe(404);
  });
});

describe("stored document", () => {
  it("serves the rendered docx", async () => {
    await seedProject();
    const { reportId } = await generate();
    await waitForRender(reportId);

    const res = await app.request(`/api/v1/reports/${reportId}/docx`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("wordprocessingml.document");
    expect(res.headers.get("content-disposition")).toContain(".docx");

    // a docx is a zip, so the first two bytes are the zip magic
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe("PK");
  }, 20_000);

  it("round-trips an edited document", async () => {
    await seedProject();
    const { reportId } = await generate();
    await waitForRender(reportId);

    const original = Buffer.from(
      await (await app.request(`/api/v1/reports/${reportId}/docx`)).arrayBuffer(),
    );
    // an edit must differ from the render, or the write proves nothing
    const edited = Buffer.concat([original, Buffer.from([0x00])]);

    const written = await app.request(`/api/v1/reports/${reportId}/docx`, {
      method: "PUT",
      headers: { "content-type": DOCX_MIME },
      body: edited,
    });
    expect(written.status).toBe(200);

    const read = Buffer.from(
      await (await app.request(`/api/v1/reports/${reportId}/docx`)).arrayBuffer(),
    );
    expect(read.byteLength).toBe(edited.byteLength);
  }, 20_000);

  it("rejects a body that is not a docx", async () => {
    await seedProject();
    const { reportId } = await generate();

    const put = (body: Uint8Array | string, contentType: string) =>
      app.request(`/api/v1/reports/${reportId}/docx`, {
        method: "PUT",
        headers: { "content-type": contentType },
        body,
      });

    expect((await put("not a docx at all", "text/plain")).status).toBe(415);
    expect((await put(new Uint8Array(0), "application/octet-stream")).status).toBe(400);
    // right mime, wrong magic — this is what keeps a stray upload out of storage
    expect((await put("plainly not a zip", DOCX_MIME)).status).toBe(400);
  }, 20_000);

  it("answers 400 for an id that is not a uuid", async () => {
    const res = await app.request("/api/v1/reports/not-a-uuid/docx");

    expect(res.status).toBe(400);
  });

  it("answers 404 for an unknown report", async () => {
    const res = await app.request(
      "/api/v1/reports/00000000-0000-4000-8000-000000000000/docx",
    );

    expect(res.status).toBe(404);
  });

  it("drops unsafe characters from the attachment filename", async () => {
    await seedProject();
    // a quote or a newline in the name would split the response header
    const { reportId } = await generate('Bad"Name\nX');
    await waitForRender(reportId);

    const res = await app.request(`/api/v1/reports/${reportId}/docx`);

    expect(res.headers.get("content-disposition")).toBe('attachment; filename="BadNameX.docx"');
  }, 20_000);
});

describe("report PDF", () => {
  it.skipIf(!sofficeAvailable)(
    "converts the stored document to a PDF",
    async () => {
      await seedProject();
      const { reportId } = await generate("Printable");
      await waitForRender(reportId);

      const res = await app.request(`/api/v1/reports/${reportId}/pdf`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toBe(
        'attachment; filename="Printable.pdf"',
      );

      // a PDF opens with its own magic, never the zip magic of the source
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.subarray(0, 4).toString()).toBe("%PDF");
    },
    60_000,
  );

  it("names the package to install when the converter is absent", async () => {
    const error = await convertDocxToPdf(
      new Uint8Array([0x50, 0x4b]),
      "/nonexistent/soffice",
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(503);
    expect((error as AppError).message).toContain("libreoffice-writer");
  });

  it("answers 404 for an unknown report", async () => {
    const res = await app.request(
      "/api/v1/reports/00000000-0000-4000-8000-000000000000/pdf",
    );

    expect(res.status).toBe(404);
  });

  it("answers 400 for an id that is not a uuid", async () => {
    const res = await app.request("/api/v1/reports/not-a-uuid/pdf");

    expect(res.status).toBe(400);
  });
});

describe("rename and delete", () => {
  it("renames a report", async () => {
    await seedProject();
    const { reportId } = await generate("Before");

    const res = await app.request(`/api/v1/reports/${reportId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "After" }),
    });

    expect(res.status).toBe(200);
    expect((await statusOf(reportId)).name).toBe("After");
  }, 20_000);

  it("answers 404 when renaming an unknown report", async () => {
    const res = await app.request(
      "/api/v1/reports/00000000-0000-4000-8000-000000000000",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Nope" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("drops the row and its stored document", async () => {
    await seedProject();
    const { reportId } = await generate();
    await waitForRender(reportId);

    const removed = await app.request(`/api/v1/reports/${reportId}`, { method: "DELETE" });
    expect(removed.status).toBe(200);

    expect((await app.request(`/api/v1/reports/${reportId}`)).status).toBe(404);
    expect((await app.request(`/api/v1/reports/${reportId}/docx`)).status).toBe(404);
  }, 20_000);

  it("answers 404 when deleting an unknown report", async () => {
    const res = await app.request(
      "/api/v1/reports/00000000-0000-4000-8000-000000000000",
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
  });
});
