// Turn gathered excel rows into the workbook the user opens.
//
// The workbook is the UI: the Index links to every sheet, and each sheet holds
// typed cells so sorting and filtering work on the value, not its text.
// flow: gathered data > index + main sheets + child sheets + media > xlsx

import ExcelJS from "exceljs";

import {
  IDENTITY_COLUMNS,
  type ExcelCell,
  type ExcelColumn,
  type ExcelExportData,
  type ExcelRow,
  type ExcelSheet,
} from "../../db/services/excel-export-data.service";

export type MediaLevel = "raw" | "images" | "clips";

// `travity_field_a_2026-10-23.xlsx`: the project and the day, safe as a name.
export const exportFilename = (
  projectTitle: string,
  media: MediaLevel,
  day = new Date(),
): string => {
  const stem =
    projectTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "export";
  return `${stem}_${day.toISOString().slice(0, 10)}.${media === "raw" ? "xlsx" : "zip"}`;
};

// One line of the Media sheet: a file that shipped with the workbook.
export type MediaRow = {
  resultId: number;
  type: string;
  kind: "image" | "clip";
  file: string;
  status: string;
};

export type WorkbookOptions = {
  mediaLevel: MediaLevel;
  mediaRows?: MediaRow[];
  generatedAt?: Date;
};

// Excel refuses a sheet name past 31 chars and forbids these characters.
const sheetName = (name: string) =>
  name.replace(/[\\/*?:[\]]/g, "-").slice(0, 31);

// Column width from the heading, with a floor for the type's values.
const widthFor = (column: ExcelColumn) => Math.min(40, Math.max(10, column.label.length + 4));

// Header cells, widths, and the autofilter over the full header range.
const layOut = (sheet: ExcelJS.Worksheet, columns: ExcelColumn[]) => {
  sheet.columns = columns.map((column) => ({
    header: column.label,
    key: column.key,
    width: widthFor(column),
    outlineLevel: column.group ? 1 : undefined,
  }));
  sheet.views = [{ state: "frozen", xSplit: Math.min(IDENTITY_COLUMNS.length, columns.length), ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(1, columns.length) },
  };
  sheet.getRow(1).font = { bold: true };
};

// One typed cell. Empty stays empty, so Excel shows a blank, not a zero.
const cellValue = (value: ExcelCell | undefined) =>
  value === null || value === undefined ? null : value;

// A data sheet: header plus one row per result, in gather order.
const addDataSheet = (
  workbook: ExcelJS.Workbook,
  name: string,
  columns: ExcelColumn[],
  rows: ExcelRow[],
) => {
  const sheet = workbook.addWorksheet(sheetName(name));
  layOut(sheet, columns);

  for (const row of rows) {
    sheet.addRow(columns.map((column) => cellValue(row.cells[column.key])));
  }

  return sheet;
};

// The Index: what every sheet holds, with a link that jumps to it.
const addIndexSheet = (
  workbook: ExcelJS.Workbook,
  data: ExcelExportData,
  options: WorkbookOptions,
  mediaCount: number,
) => {
  const sheet = workbook.addWorksheet("Index");
  sheet.columns = [
    { header: "Sheet", key: "sheet", width: 26 },
    { header: "Rows", key: "rows", width: 10 },
    { header: "Media files", key: "media", width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };

  const title = sheet.addRow([data.projectTitle]);
  title.font = { bold: true, size: 14 };
  sheet.addRow([`Document ${data.documentId || "-"}`]);
  sheet.addRow([`Generated ${(options.generatedAt ?? new Date()).toISOString()}`]);
  sheet.addRow([]);

  for (const typeSheet of data.sheets) {
    const row = sheet.addRow({
      sheet: typeSheet.sheet,
      rows: typeSheet.rows.length,
      media: mediaCount,
    });
    row.getCell(1).value = { text: typeSheet.sheet, hyperlink: `#'${typeSheet.sheet}'!A1` };

    for (const child of typeSheet.children) {
      const childRow = sheet.addRow({
        sheet: `  ${child.label}`,
        rows: child.rows.length,
        media: "",
      });
      childRow.getCell(1).value = {
        text: child.label,
        hyperlink: `#'${sheetName(child.label)}'!A1`,
      };
    }
  }

  sheet.addRow([]);
  if (options.mediaLevel !== "raw") {
    // the links are relative, so the workbook only works after extraction
    const note = sheet.addRow([
      "Extract the zip before opening this workbook: image and clip links point to files beside it.",
    ]);
    note.font = { italic: true };
  }
  if (mediaCount === 0 && options.mediaLevel !== "raw") {
    sheet.addRow(["No media shipped with this export."]).font = { italic: true };
  }

  return sheet;
};

// The Media sheet: every file the export carried, keyed by result.
const addMediaSheet = (workbook: ExcelJS.Workbook, rows: MediaRow[]) => {
  const sheet = workbook.addWorksheet("Media");
  sheet.columns = [
    { header: "Result ID", key: "resultId", width: 12 },
    { header: "Type", key: "type", width: 12 },
    { header: "Kind", key: "kind", width: 10 },
    { header: "File", key: "file", width: 48 },
    { header: "Status", key: "status", width: 14 },
  ];
  layOut(sheet, [
    { key: "resultId", label: "Result ID", type: "number" },
    { key: "type", label: "Type", type: "text" },
    { key: "kind", label: "Kind", type: "text" },
    { key: "file", label: "File", type: "text" },
    { key: "status", label: "Status", type: "text" },
  ]);

  for (const row of rows) {
    sheet.addRow([row.resultId, row.type, row.kind, row.file, row.status]);
  }

  return sheet;
};

// Index first, then one sheet per type, one per child list, Media last.
export const buildWorkbook = (data: ExcelExportData, options: WorkbookOptions) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "travis";
  workbook.created = options.generatedAt ?? new Date();

  const mediaRows = options.mediaRows ?? [];

  // the index goes first so it opens on the first tab
  const index = addIndexSheet(workbook, data, options, mediaRows.length);

  for (const typeSheet of data.sheets as ExcelSheet[]) {
    addDataSheet(workbook, typeSheet.sheet, typeSheet.columns, typeSheet.rows);
    for (const child of typeSheet.children) {
      addDataSheet(workbook, child.label, child.columns, child.rows);
    }
  }

  addMediaSheet(workbook, mediaRows);

  // Excel opens the first sheet; the index is the map, so keep it active
  index.getRow(1).alignment = { vertical: "middle" };
  return workbook;
};

// The finished file, ready for the zip.
export const writeWorkbook = async (
  data: ExcelExportData,
  options: WorkbookOptions,
): Promise<Buffer> => {
  const workbook = buildWorkbook(data, options);
  return Buffer.from(await workbook.xlsx.writeBuffer());
};
