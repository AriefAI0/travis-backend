// Turn one gathered type into the workbook the user opens.
//
// Each inspection type ships its own workbook, so it opens on one sheet. The
// cells stay typed, so sorting and filtering work on the value, not its text.
// flow: gathered sheet > typed rows > xlsx buffer

import ExcelJS from "exceljs";

import {
  type ExcelCell,
  type ExcelColumn,
  type ExcelRow,
  type ExcelSheet,
} from "../../db/services/excel-export-data.service";

export type MediaLevel = "raw" | "images" | "clips";

// The project and the day, safe as a file name. Names the zip and the one
// top folder inside it.
export const exportStem = (projectTitle: string, day: Date): string => {
  const stem =
    projectTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "export";
  return `${stem}_${day.toISOString().slice(0, 10)}`;
};

// `travity_field_a_2026-10-24.xlsx` or `.zip`: the whole export's name.
export const exportFilename = (
  projectTitle: string,
  media: MediaLevel,
  day = new Date(),
): string => `${exportStem(projectTitle, day)}.${media === "raw" ? "xlsx" : "zip"}`;

// `GVI_travity_field_a_2026-10-24.xlsx`: the type leads, because Excel refuses
// to open two files with one name at once.
export const typeFilename = (type: string, projectTitle: string, day = new Date()): string =>
  `${type}_${exportStem(projectTitle, day)}.xlsx`;

export type WorkbookOptions = {
  generatedAt?: Date;
  // absent on a raw export: no media ships, so no media columns
  media?: Map<number, MediaCells>;
};

// A result's shipped media, as the sheet names it. A path runs from the
// workbook, which sits beside the images and clips folders.
export type MediaCells = {
  imageFolder: string;
  images: number;
  clipFolder: string;
  clips: number;
};

// Plain folder references close the sheet. No link, no picture.
const MEDIA_COLUMNS: ExcelColumn[] = [
  { key: "image_folder", label: "Images folder", type: "text" },
  { key: "images", label: "Images", type: "number" },
  { key: "clip_folder", label: "Clips folder", type: "text" },
  { key: "clips", label: "Clips", type: "number" },
];

// Excel refuses a sheet name past 31 chars and forbids these characters.
const sheetName = (name: string) =>
  name.replace(/[\\/*?:[\]]/g, "-").slice(0, 31);

// Column width from the heading, with a floor for the type's values.
const widthFor = (column: ExcelColumn) => Math.min(40, Math.max(10, column.label.length + 4));

// Excel shows only the day without this, and the reading time matters.
const DATE_FMT = "yyyy-mm-dd hh:mm:ss";

// Header cells, widths, and the autofilter over the full header range.
const layOut = (sheet: ExcelJS.Worksheet, columns: ExcelColumn[]) => {
  sheet.columns = columns.map((column) => ({
    header: column.label,
    key: column.key,
    width: widthFor(column),
  }));
  // no column split: the sheet reads as one flat table (user, 2026-10-24)
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(1, columns.length) },
  };
  sheet.getRow(1).font = { bold: true };
};

// One typed cell. Empty stays empty, so Excel shows a blank, not a zero.
const cellValue = (value: ExcelCell | undefined) =>
  value === null || value === undefined ? null : value;

// A data sheet: header plus one row per reading, in gather order.
const addDataSheet = (
  workbook: ExcelJS.Workbook,
  name: string,
  columns: ExcelColumn[],
  rows: ExcelRow[],
) => {
  const sheet = workbook.addWorksheet(sheetName(name));
  layOut(sheet, columns);

  for (const row of rows) {
    const added = sheet.addRow(columns.map((column) => cellValue(row.cells[column.key])));

    // a date cell needs its format, else Excel hides the time
    columns.forEach((column, index) => {
      const cell = added.getCell(index + 1);
      if (column.type === "date" && cell.value instanceof Date) cell.numFmt = DATE_FMT;
    });
  }

  return sheet;
};

// One type's workbook: a single sheet, named the type.
export const writeTypeWorkbook = async (
  sheet: ExcelSheet,
  options: WorkbookOptions = {},
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "travis";
  workbook.created = options.generatedAt ?? new Date();

  const media = options.media;
  const columns = media ? [...sheet.columns, ...MEDIA_COLUMNS] : sheet.columns;
  // every row of a result names its folders, so a filter never hides them
  const rows = media
    ? sheet.rows.map((row) => {
        const cells = media.get(row.resultId);
        return cells
          ? {
              ...row,
              cells: {
                ...row.cells,
                image_folder: cells.imageFolder,
                images: cells.images,
                clip_folder: cells.clipFolder,
                clips: cells.clips,
              },
            }
          : row;
      })
    : sheet.rows;

  addDataSheet(workbook, sheet.sheet, columns, rows);
  return Buffer.from(await workbook.xlsx.writeBuffer());
};
