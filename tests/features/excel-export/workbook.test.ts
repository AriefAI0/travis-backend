import { describe, expect, it } from "bun:test";
import ExcelJS from "exceljs";

import { IDENTITY_COLUMNS, type ExcelExportData } from "../../../src/db/services/excel-export-data.service";
import { writeWorkbook } from "../../../src/features/excel-export/workbook";

const recorded = new Date("2026-10-01T08:30:00Z");

// One GVI row plus one CVI row with a child list
const data: ExcelExportData = {
  projectTitle: "Alpha",
  documentId: "DOC-1",
  sheets: [
    {
      type: "GVI",
      sheet: "GVI",
      columns: [
        ...IDENTITY_COLUMNS,
        { key: "depth_el", label: "Depth EL", type: "number" },
        { key: "condition", label: "Condition", type: "text" },
      ],
      rows: [
        {
          resultId: 5001,
          cells: {
            result_id: 5001,
            session: "Run 1",
            task_group: "100",
            task_code: "101",
            description: "Leg A",
            type_code: "T1",
            part_code: "P1",
            class: "normal",
            remarks: "",
            recorded,
            depth_el: 84.2,
            condition: "Good Condition",
          },
        },
      ],
      children: [],
    },
    {
      type: "CVI",
      sheet: "CVI",
      columns: [...IDENTITY_COLUMNS, { key: "datum_reference", label: "Datum ref", type: "text" }],
      rows: [
        {
          resultId: 5003,
          cells: { result_id: 5003, session: "Run 1", recorded, datum_reference: "D-1" },
        },
      ],
      children: [
        {
          key: "positions",
          label: "CVI positions",
          columns: [
            { key: "clock_position", label: "Clock", type: "text" },
            { key: "ut_mm", label: "UT mm", type: "number" },
          ],
          rows: [{ resultId: 5003, cells: { clock_position: "12:00", ut_mm: 19.8 } }],
        },
      ],
    },
  ],
};

const read = async () => {
  const buffer = await writeWorkbook(data, { mediaLevel: "raw", generatedAt: recorded });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
};

describe("excel workbook", () => {
  it("writes the index, one sheet per type, one per child list, and media", async () => {
    const workbook = await read();
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Index",
      "GVI",
      "CVI",
      "CVI positions",
      "Media",
    ]);
  });

  it("keeps cell types: numbers, dates, and text", async () => {
    const workbook = await read();
    const sheet = workbook.getWorksheet("GVI")!;
    const header = sheet.getRow(1).values as unknown[];

    expect(header[1]).toBe("Result ID");
    expect(header[2]).toBe("Session");

    const depthColumn = (header as string[]).indexOf("Depth EL");
    const recordedColumn = (header as string[]).indexOf("Recorded");
    const row = sheet.getRow(2);

    expect(row.getCell(depthColumn).value).toBe(84.2);
    expect(row.getCell(recordedColumn).value).toBeInstanceOf(Date);
    expect(row.getCell(1).value).toBe(5001);
  });

  it("freezes the identity columns and filters every header", async () => {
    const workbook = await read();
    const sheet = workbook.getWorksheet("GVI")!;

    expect(sheet.views?.[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();
  });

  it("links the index row to its sheet", async () => {
    const workbook = await read();
    const index = workbook.getWorksheet("Index")!;
    const links: string[] = [];

    index.eachRow((row) => {
      const value = row.getCell(1).value as { hyperlink?: string } | null;
      if (value && typeof value === "object" && value.hyperlink) links.push(value.hyperlink);
    });

    expect(links).toContain("#'GVI'!A1");
    expect(links).toContain("#'CVI positions'!A1");
  });

  it("notes that the zip must be extracted when media ships", async () => {
    const buffer = await writeWorkbook(data, { mediaLevel: "images", generatedAt: recorded });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const text = workbook
      .getWorksheet("Index")!
      .getSheetValues()
      .flat()
      .filter((cell): cell is string => typeof cell === "string")
      .join(" ");

    expect(text).toContain("Extract the zip");
  });

  it("keeps every sheet name inside the 31 character limit", async () => {
    const workbook = await read();
    for (const sheet of workbook.worksheets) {
      expect(sheet.name.length).toBeLessThanOrEqual(31);
    }
  });
});
