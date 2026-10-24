import { beforeEach, describe, expect, it } from "bun:test";

import type { ExcelExportData } from "../../../src/db/services/excel-export-data.service";
import type { ExcelExportRow } from "../../../src/db/repositories/excel-export.repository";
import {
  emitProgress,
  excelWorkerDeps,
  mediaCellsFor,
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
    current = rowFor({ media: "images" });

    await runExcelExport(current);

    expect(current.status).toBe("ready");
    expect(current.packageSize).toBe(42);
    expect(stored.size).toBe(0);
  });

  it("puts one workbook per type in a zip when two types ship", async () => {
    current = rowFor({ types: ["GVI", "CVI"] });
    excelWorkerDeps.gather = async () => secondType(oneRow);

    await runExcelExport(current);

    const day = new Date().toISOString().slice(0, 10);
    const root = `alpha_${day}`;

    expect(current.status).toBe("ready");
    expect(packaged).toHaveLength(3);
    // everything sits inside one top folder, so Extract All stays tidy
    expect(packaged[0]).toBe(`${root}/README.txt`);
    expect(packaged).toContain(`${root}/GVI/GVI_alpha_${day}.xlsx`);
    expect(packaged).toContain(`${root}/CVI/CVI_alpha_${day}.xlsx`);
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

  it("throttles progress but always sends the terminal status", async () => {
    // its own id, so the throttle clock of another test cannot affect it
    const row = rowFor({ id: "00000000-0000-0000-0000-00000000beef" });

    emitProgress(row);
    emitProgress(row);
    expect(events).toHaveLength(1);

    excelWorkerDeps.emit(row, "modify");
    expect(events).toHaveLength(2);
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
