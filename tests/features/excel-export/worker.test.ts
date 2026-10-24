import { beforeEach, describe, expect, it } from "bun:test";

import type { ExcelExportData } from "../../../src/db/services/excel-export-data.service";
import type { ExcelExportRow } from "../../../src/db/repositories/excel-export.repository";
import {
  createWorkerWake,
  excelWorkerDeps,
  mediaCellsFor,
  progressReporter,
  resetExcelWorkerDeps,
  resultTypesOf,
  runExcelExport,
} from "../../../src/features/excel-export/worker";
import { resultFolder } from "../../../src/features/excel-export/package";

// One GVI type with one reading, so a raw export ships a bare workbook.
const oneRow: ExcelExportData = {
  projectTitle: "Alpha",
  documentId: "DOC-1",
  sheets: [
    {
      type: "GVI",
      sheet: "GVI",
      columns: [],
      rows: [{ resultId: 5001, cells: {} }],
    },
  ],
};

const secondType = (data: ExcelExportData): ExcelExportData => ({
  ...data,
  sheets: [...data.sheets, { type: "CVI", sheet: "CVI", columns: [], rows: [{ resultId: 5002, cells: {} }] }],
});

const rowFor = (overrides: Partial<ExcelExportRow> = {}): ExcelExportRow =>
  ({
    id: "00000000-0000-0000-0000-000000000001",
    organizationId: 1,
    projectId: 1,
    ownerUserId: "user-1",
    types: ["GVI"],
    targets: ["partCode:300"],
    media: "raw",
    name: "",
    lane: "light",
    status: "running",
    phase: "",
    itemsTotal: 3,
    itemsDone: 0,
    bytesWritten: 0,
    attempts: 1,
    errors: [],
    packageKey: "excel-exports/light/one.xlsx",
    packageSize: null,
    requestHash: "hash",
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as ExcelExportRow;

// The worker stamps its own build time, so assert the shape, not one second.
const workbookPattern = (type: string): RegExp =>
  new RegExp(`/${type}/${type}_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}_UTC\\.xlsx$`);

let stored: Map<string, Buffer>;
let removed: string[];
let events: string[];
let packaged: string[];
let current: ExcelExportRow;

beforeEach(() => {
  resetExcelWorkerDeps();
  stored = new Map();
  removed = [];
  events = [];
  packaged = [];
  current = rowFor();

  excelWorkerDeps.read = async () => current;
  excelWorkerDeps.gather = async () => oneRow;
  excelWorkerDeps.build = async () => Buffer.from("workbook");
  excelWorkerDeps.package = async (key, entries) => {
    packaged = entries.map((entry) => entry.name);
    return { bytes: 42, key };
  };
  excelWorkerDeps.putObject = async (key, body) => void stored.set(key, body);
  excelWorkerDeps.removeObject = async (key) => {
    removed.push(key);
    stored.delete(key);
  };
  excelWorkerDeps.emit = (row) => void events.push(row.status);
  excelWorkerDeps.move = async (id, from, patch) => {
    if (current.id !== id || current.status !== from) return false;
    current = { ...current, ...patch } as ExcelExportRow;
    return true;
  };
});

describe("excel export worker", () => {
  it("runs a raw export to ready and stores the package", async () => {
    await runExcelExport(current);

    expect(current.status).toBe("ready");
    expect(current.packageSize).toBe(8);
    expect(stored.get("excel-exports/light/one.xlsx")?.toString()).toBe("workbook");
    expect(events).toContain("ready");
  });

  it("zips a named raw single-type export under its name", async () => {
    current = rowFor({ name: "Site B" });

    await runExcelExport(current);

    expect(current.status).toBe("ready");
    // the typed name gets its folder, so the package is a zip
    expect(stored.size).toBe(0);
    expect(packaged[0]).toBe("site_b/README.txt");
    expect(packaged.some((entry) => workbookPattern("GVI").test(entry))).toBe(true);
  });

  it("leaves a cancelling export cancelled and stores nothing", async () => {
    current = rowFor({ status: "cancelling" });

    await runExcelExport(current);

    expect(current.status).toBe("cancelled");
    expect(stored.size).toBe(0);
  });

  it("stops when the export was removed mid-run", async () => {
    excelWorkerDeps.move = async () => false;

    await runExcelExport(current);

    expect(removed).toEqual(["excel-exports/light/one.xlsx"]);
    expect(stored.size).toBe(0);
  });

  it("fails the row when the gather throws", async () => {
    excelWorkerDeps.gather = async () => {
      throw new Error("gather exploded");
    };

    await runExcelExport(current);

    expect(current.status).toBe("failed");
    expect(String((current.errors as { message: string }[])[0]?.message)).toContain("gather exploded");
  });

  it("packages an images export as a zip", async () => {
    current = rowFor({ media: "images", name: "Site B" });

    await runExcelExport(current);

    expect(current.status).toBe("ready");
    expect(current.packageSize).toBe(42);
    expect(stored.size).toBe(0);
    // the typed name names the root, never the workbook
    expect(packaged[0]).toBe("site_b/README.txt");
    expect(packaged.some((entry) => workbookPattern("GVI").test(entry))).toBe(true);
  });

  it("puts one workbook per type in a zip when two types ship", async () => {
    current = rowFor({ types: ["GVI", "CVI"], name: "Site B" });
    excelWorkerDeps.gather = async () => secondType(oneRow);

    await runExcelExport(current);

    // the typed name names the root only. Files take their build stamp.
    expect(current.status).toBe("ready");
    expect(packaged).toHaveLength(3);
    // everything sits inside one top folder, so Extract All stays tidy
    expect(packaged[0]).toBe("site_b/README.txt");
    expect(packaged.some((entry) => workbookPattern("GVI").test(entry))).toBe(true);
    expect(packaged.some((entry) => workbookPattern("CVI").test(entry))).toBe(true);
  });

  it("skips a type with no rows", async () => {
    current = rowFor({ types: ["GVI", "CVI"] });
    excelWorkerDeps.gather = async () => ({
      ...oneRow,
      sheets: [...oneRow.sheets, { type: "CVI", sheet: "CVI", columns: [], rows: [] }],
    });

    await runExcelExport(current);

    // one type with rows, so the bare workbook goes out and no zip is built
    expect(current.status).toBe("ready");
    expect(packaged).toHaveLength(0);
    expect(stored.size).toBe(1);
  });

  it("walks the phases and restores the result count at the end", async () => {
    const phases: { phase: string; done: number; total: number }[] = [];
    excelWorkerDeps.gather = async (...args) => {
      const onProgress = args[6];
      await onProgress?.(0, 2);
      await onProgress?.(1, 2);
      await onProgress?.(2, 2);
      return oneRow;
    };
    excelWorkerDeps.move = async (id, from, patch) => {
      if (current.id !== id || current.status !== from) return false;
      current = { ...current, ...patch } as ExcelExportRow;
      phases.push({
        phase: String(patch.phase),
        done: patch.itemsDone ?? 0,
        total: patch.itemsTotal ?? 0,
      });
      return true;
    };

    await runExcelExport(current);

    // the middle tick falls inside the one-second window, so it never writes
    expect(phases).toEqual([
      { phase: "results", done: 0, total: 2 },
      { phase: "results", done: 2, total: 2 },
      { phase: "packing", done: 2, total: 2 },
      { phase: "done", done: 2, total: 2 },
    ]);
  });

  it("reports a media phase even when no files ship", async () => {
    current = rowFor({ media: "images" });
    const phases: string[] = [];
    excelWorkerDeps.gather = async (...args) => {
      const onProgress = args[6];
      await onProgress?.(0, 1);
      await onProgress?.(1, 1);
      return oneRow;
    };
    excelWorkerDeps.move = async (id, from, patch) => {
      if (current.id !== id || current.status !== from) return false;
      current = { ...current, ...patch } as ExcelExportRow;
      phases.push(String(patch.phase));
      return true;
    };

    await runExcelExport(current);

    // no image rows exist, so media counts 0 of 0 and still shows
    expect(phases).toEqual(["results", "results", "media", "packing", "done"]);
    expect(current.itemsTotal).toBe(1);
    expect(current.itemsDone).toBe(1);
  });

  it("sends one progress event a second inside a phase", async () => {
    const report = progressReporter(current);

    await report.results(0, 3); // phase change: writes
    await report.results(1, 3); // inside the window: skipped
    await report.results(3, 3); // last item: writes

    expect(events).toHaveLength(2);
  });

  it("stops reporting once the row leaves running", async () => {
    const report = progressReporter(current);
    excelWorkerDeps.move = async () => false;

    await report.results(0, 2);
    await report.results(2, 2);

    // the lost CAS killed the reports, and nothing was emitted
    expect(events).toHaveLength(0);
  });

  it("names each result once when its sheet repeats it", () => {
    const repeated: ExcelExportData = {
      projectTitle: "Alpha",
      documentId: "DOC-1",
      sheets: [
        {
          type: "GVI",
          sheet: "GVI",
          columns: [],
          rows: [
            { resultId: 5001, cells: { task_code: "GVI-101", description: "Anode A-12, port leg" } },
            { resultId: 5001, cells: {} },
            { resultId: 5001, cells: {} },
            { resultId: 5002, cells: { task_code: "GVI-102", description: "Chord C-4" } },
          ],
        },
      ],
    };

    expect(resultTypesOf(repeated)).toEqual([
      { resultId: 5001, type: "GVI", folder: "5001_gvi-101_anode-a-12-port-leg" },
      { resultId: 5002, type: "GVI", folder: "5002_gvi-102_chord-c-4" },
    ]);
  });

  it("keeps a long result folder inside the Windows path budget", () => {
    const folder = resultFolder(1042, "GVI-101", "x".repeat(200));
    const longest = `CVI/images/${folder}/99_annotated.webp`;

    expect(folder.length).toBeLessThanOrEqual(4 + 1 + 7 + 1 + 40);
    expect(longest.length).toBeLessThan(160);
  });

  it("names a folder only for the media a result ships", () => {
    const targets = [{ resultId: 5001, type: "GVI" as const, folder: "5001_gvi-101_leg" }];

    const cells = mediaCellsFor(targets, new Map([[5001, 2]]), new Map());

    expect(cells.get(5001)).toEqual({
      imageFolder: "images/5001_gvi-101_leg",
      images: 2,
      clipFolder: "",
      clips: 0,
    });
  });
});

describe("worker wake", () => {
  // A kick lands while the claim query is still running: it must survive.
  it("keeps a kick that arrives during a claim", async () => {
    const wake = createWorkerWake(10_000);
    const seen = wake.version();

    wake.kick();
    await wake.wait(seen);

    expect(wake.version()).toBe(seen + 1);
  });

  it("wakes a lane already waiting on the queue", async () => {
    const wake = createWorkerWake(10_000);
    const seen = wake.version();
    const waiting = wake.wait(seen);

    wake.kick();
    await waiting;
  });

  // No kick: the bounded check re-reads the queue instead of spinning.
  it("checks the queue again when the fallback fires", async () => {
    const wake = createWorkerWake(5);
    const started = Date.now();

    await wake.wait(wake.version());

    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  });
});
