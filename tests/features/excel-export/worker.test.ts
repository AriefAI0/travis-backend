import { beforeEach, describe, expect, it } from "bun:test";

import type { ExcelExportData } from "../../../src/db/services/excel-export-data.service";
import type { ExcelExportRow } from "../../../src/db/repositories/excel-export.repository";
import {
  emitProgress,
  excelWorkerDeps,
  resetExcelWorkerDeps,
  runExcelExport,
} from "../../../src/features/excel-export/worker";

const emptyData: ExcelExportData = { projectTitle: "Alpha", documentId: "DOC-1", sheets: [] };

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
let current: ExcelExportRow;

beforeEach(() => {
  resetExcelWorkerDeps();
  stored = new Map();
  removed = [];
  events = [];
  current = rowFor();

  excelWorkerDeps.read = async () => current;
  excelWorkerDeps.gather = async () => emptyData;
  excelWorkerDeps.build = async () => Buffer.from("workbook");
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

  it("fails a media level no phase can build yet", async () => {
    current = rowFor({ media: "clips", lane: "clips" });

    await runExcelExport(current);

    expect(current.status).toBe("failed");
    expect(stored.size).toBe(0);
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
});
