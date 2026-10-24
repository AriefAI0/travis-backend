import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";

import { IDENTITY_COLUMNS, type ExcelExportData } from "../../../src/db/services/excel-export-data.service";
import { writeWorkbook } from "../../../src/features/excel-export/workbook";

const recorded = new Date("2026-10-01T08:30:00Z");

// One GVI row plus a flat CVI sheet with two readings
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
            task_code: "101",
            description: "Leg A",
            part_code: "P1",
            class: "normal",
            recorded,
            depth_el: 84.2,
            condition: "Good Condition",
          },
        },
      ],
    },
    {
      type: "CVI",
      sheet: "CVI",
      columns: [
        ...IDENTITY_COLUMNS,
        { key: "datum_reference", label: "Datum ref", type: "text" },
        { key: "clock_position", label: "Clock", type: "text" },
        { key: "ut_mm", label: "UT mm", type: "number" },
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
  it("writes the index and one sheet per type", async () => {
    const workbook = await read();
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Index", "GVI", "CVI", "Media"]);
  });

  it("keeps cell types: numbers, dates, and text", async () => {
    const workbook = await read();
    const sheet = workbook.getWorksheet("GVI")!;
    const header = sheet.getRow(1).values as unknown[];

    expect(header[1]).toBe("Result ID");
    expect(header[2]).toBe("Session");

    const depthColumn = (header as string[]).indexOf("Depth EL");
    const recordedColumn = (header as string[]).indexOf("Timestamp (UTC)");
    const row = sheet.getRow(2);

    expect(row.getCell(depthColumn).value).toBe(84.2);
    expect(row.getCell(recordedColumn).value).toBeInstanceOf(Date);
    expect(row.getCell(1).value).toBe(5001);
  });

  it("formats a date cell with its time", async () => {
    const workbook = await read();
    const sheet = workbook.getWorksheet("GVI")!;
    const header = sheet.getRow(1).values as unknown[];
    const recordedColumn = (header as string[]).indexOf("Timestamp (UTC)");

    expect(sheet.getRow(2).getCell(recordedColumn).numFmt).toBe("yyyy-mm-dd hh:mm:ss");
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
    expect(links).toContain("#'CVI'!A1");
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

  it("stacks three thumbnails and links the rest past them", async () => {
    // one real jpeg, reused: the cell placement is what this test checks
    const directory = await mkdtemp(path.join(tmpdir(), "workbook-thumb-"));
    const thumbnail = path.join(directory, "thumb.jpg");
    const made = Bun.spawn(
      ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x336699:size=160x120:d=1", "-frames:v", "1", thumbnail],
      { stdout: "pipe", stderr: "pipe" },
    );
    await made.exited;

    const thumbs = Array.from({ length: 5 }, (_, index) => ({
      thumbnail,
      target: `images/GVI/5001_${index + 1}.jpg`,
    }));

    const buffer = await writeWorkbook(data, {
      mediaLevel: "images",
      generatedAt: recorded,
      imageThumbs: new Map([[5001, thumbs]]),
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const sheet = workbook.getWorksheet("GVI")!;
    const header = sheet.getRow(1).values as unknown[];
    const imagesColumn = (header as string[]).indexOf("Images");
    expect(imagesColumn).toBeGreaterThan(0);

    const cell = sheet.getRow(2).getCell(imagesColumn).value as { text?: string } | null;
    expect(cell?.text).toBe("+2 more (5)");
    // three anchors placed, the other two only linked
    expect(sheet.getImages()).toHaveLength(3);
  }, 30_000);

  it("keeps every sheet name inside the 31 character limit", async () => {
    const workbook = await read();
    for (const sheet of workbook.worksheets) {
      expect(sheet.name.length).toBeLessThanOrEqual(31);
    }
  });
});
