import { describe, expect, it } from "bun:test";
import ExcelJS from "exceljs";

import { IDENTITY_COLUMNS, type ExcelSheet } from "../../../src/db/services/excel-export-data.service";
import { typeFilename, writeTypeWorkbook } from "../../../src/features/excel-export/workbook";

const recorded = new Date("2026-10-01T08:30:00Z");

const gvi: ExcelSheet = {
  type: "GVI",
  sheet: "GVI",
  columns: [
    ...IDENTITY_COLUMNS,
    { key: "depth_el", label: "Depth EL (-)", type: "number" },
    { key: "condition", label: "Condition", type: "text" },
  ],
  rows: [
    {
      resultId: 5001,
      cells: {
        result_id: 5001,
        session: "Run 1",
        task_code: "101",
        description: "Leg A",
        part_code: "P1",
        class: "Normal",
        recorded,
        depth_el: 84.2,
        condition: "Good Condition",
      },
    },
  ],
};

const cvi: ExcelSheet = {
  type: "CVI",
  sheet: "CVI",
  columns: [
    ...IDENTITY_COLUMNS,
    { key: "datum_reference", label: "Datum Reference", type: "text" },
    { key: "clock_position", label: "Clock position", type: "text" },
    { key: "ut_mm", label: "UT Value (mm)", type: "number" },
  ],
  rows: [
    {
      resultId: 5003,
      cells: {
        result_id: 5003,
        session: "Run 1",
        recorded,
        datum_reference: "D-1",
        clock_position: "12:00",
        ut_mm: 19.8,
      },
    },
    {
      resultId: 5003,
      cells: { result_id: 5003, session: "Run 1", recorded, datum_reference: "D-1", clock_position: "3:00" },
    },
  ],
};

const read = async (sheet: ExcelSheet) => {
  const buffer = await writeTypeWorkbook(sheet, { generatedAt: recorded });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
};

describe("excel workbook", () => {
  it("writes one sheet named the type", async () => {
    const workbook = await read(gvi);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["GVI"]);
  });

  it("keeps every reading of a result as its own row", async () => {
    const workbook = await read(cvi);
    const sheet = workbook.getWorksheet("CVI")!;

    expect(sheet.rowCount).toBe(3);
    expect(sheet.getRow(2).getCell(1).value).toBe(5003);
    expect(sheet.getRow(3).getCell(1).value).toBe(5003);
  });

  it("keeps cell types: numbers, dates, and text", async () => {
    const workbook = await read(gvi);
    const sheet = workbook.getWorksheet("GVI")!;
    const header = sheet.getRow(1).values as unknown[];

    expect(header[1]).toBe("Result ID");
    expect(header[2]).toBe("Session");

    const depthColumn = (header as string[]).indexOf("Depth EL (-)");
    const recordedColumn = (header as string[]).indexOf("Timestamp (UTC)");
    const row = sheet.getRow(2);

    expect(row.getCell(depthColumn).value).toBe(84.2);
    expect(row.getCell(recordedColumn).value).toBeInstanceOf(Date);
    expect(row.getCell(1).value).toBe(5001);
  });

  it("formats a date cell with its time", async () => {
    const workbook = await read(gvi);
    const sheet = workbook.getWorksheet("GVI")!;
    const header = sheet.getRow(1).values as unknown[];
    const recordedColumn = (header as string[]).indexOf("Timestamp (UTC)");

    expect(sheet.getRow(2).getCell(recordedColumn).numFmt).toBe("yyyy-mm-dd hh:mm:ss");
  });

  it("freezes the identity columns and filters every header", async () => {
    const workbook = await read(gvi);
    const sheet = workbook.getWorksheet("GVI")!;

    expect(sheet.views?.[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();
  });

  it("holds no picture and no hyperlink", async () => {
    const workbook = await read(cvi);
    const sheet = workbook.getWorksheet("CVI")!;

    expect(sheet.getImages()).toHaveLength(0);
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        const value = cell.value as { hyperlink?: string } | null;
        expect(value === null || typeof value !== "object" || !value.hyperlink).toBe(true);
      });
    });
  });

  it("names the file after the type, so two can open at once", () => {
    expect(typeFilename("GVI", "Travity Field A", recorded)).toBe("GVI_travity_field_a_2026-10-01.xlsx");
    expect(typeFilename("CVI", "Travity Field A", recorded)).not.toBe(
      typeFilename("GVI", "Travity Field A", recorded),
    );
  });
});
