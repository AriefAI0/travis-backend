// Turn gathered excel rows into the workbook the user opens.
//
// The workbook is the UI: the Index links to every sheet, and each sheet holds
// typed cells so sorting and filtering work on the value, not its text.
// flow: gathered data > index + one sheet per type + media > xlsx

import ExcelJS from "exceljs";

import {
  IDENTITY_COLUMNS,
  type ExcelCell,
  type ExcelColumn,
  type ExcelExportData,
  type ExcelRow,
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

// One thumbnail, and the zip-relative file it opens.
export type MediaThumb = { thumbnail: string; target: string };

export type WorkbookOptions = {
  mediaLevel: MediaLevel;
  mediaRows?: MediaRow[];
  generatedAt?: Date;
  // thumbnails by result id. Absent means this sheet gets no media columns.
  imageThumbs?: Map<number, MediaThumb[]>;
  clipThumbs?: Map<number, MediaThumb>;
};

// Excel caps a row at 409 pt; three 120 px thumbnails stay inside it.
const THUMB_HEIGHT_PX = 120;
const THUMB_WIDTH_PX = 160;
const MAX_THUMBS = 3;
const THUMB_ROW_HEIGHT_PT = 300;

const IMAGE_COLUMN: ExcelColumn = { key: "__images", label: "Images", type: "text" };
const CLIP_COLUMN: ExcelColumn = { key: "__clips", label: "Clips", type: "text" };

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

// Stack thumbnails inside one cell, each linked to its file. Past three, the
// cell carries a "+N" link to the Media sheet instead, because a fourth image
// would push the row past Excel's 409 pt ceiling.
const placeThumbs = (
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  columnIndex: number,
  thumbs: MediaThumb[],
  cell: ExcelJS.Cell,
) => {
  if (thumbs.length === 0) return;

  if (thumbs.length > MAX_THUMBS) {
    cell.value = {
      text: `+${thumbs.length - MAX_THUMBS} more (${thumbs.length})`,
      hyperlink: "#'Media'!A1",
    };
  }

  thumbs.slice(0, MAX_THUMBS).forEach((thumb, index) => {
    const imageId = workbook.addImage({ filename: thumb.thumbnail, extension: "jpeg" });
    sheet.addImage(imageId, {
      tl: { col: columnIndex - 1 + 0.02, row: rowNumber - 1 + index / MAX_THUMBS },
      br: { col: columnIndex - 1 + 0.4, row: rowNumber - 1 + (index + 1) / MAX_THUMBS },
      editAs: "oneCell",
      hyperlinks: { hyperlink: thumb.target },
    } as unknown as ExcelJS.ImageRange & { hyperlinks: ExcelJS.ImageHyperlinkValue });
  });

  sheet.getRow(rowNumber).height = THUMB_ROW_HEIGHT_PT;
};

// A data sheet: header plus one row per reading, in gather order.
const addDataSheet = (
  workbook: ExcelJS.Workbook,
  name: string,
  columns: ExcelColumn[],
  rows: ExcelRow[],
  options: WorkbookOptions,
) => {
  const withMedia = Boolean(options.imageThumbs || options.clipThumbs);
  const allColumns = withMedia ? [...columns, IMAGE_COLUMN, CLIP_COLUMN] : columns;

  const sheet = workbook.addWorksheet(sheetName(name));
  layOut(sheet, allColumns);

  const imageIndex = allColumns.indexOf(IMAGE_COLUMN) + 1;
  const clipIndex = allColumns.indexOf(CLIP_COLUMN) + 1;
  const seenResults = new Set<number>();

  for (const row of rows) {
    const added = sheet.addRow(allColumns.map((column) => cellValue(row.cells[column.key])));

    // a date cell needs its format, else Excel hides the time
    allColumns.forEach((column, index) => {
      const cell = added.getCell(index + 1);
      if (column.type === "date" && cell.value instanceof Date) cell.numFmt = DATE_FMT;
    });

    // flat rows repeat a result: its thumbnails land on the first row only
    const firstRow = !seenResults.has(row.resultId);
    seenResults.add(row.resultId);

    const rowNumber = sheet.rowCount;
    if (firstRow && options.imageThumbs) {
      placeThumbs(
        workbook,
        sheet,
        rowNumber,
        imageIndex,
        options.imageThumbs.get(row.resultId) ?? [],
        sheet.getRow(rowNumber).getCell(imageIndex),
      );
    }
    if (firstRow && options.clipThumbs) {
      const clip = options.clipThumbs.get(row.resultId);
      if (clip) {
        placeThumbs(workbook, sheet, rowNumber, clipIndex, [clip], sheet.getRow(rowNumber).getCell(clipIndex));
      }
    }
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

// Index first, then one sheet per type, Media last.
export const buildWorkbook = (data: ExcelExportData, options: WorkbookOptions) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "travis";
  workbook.created = options.generatedAt ?? new Date();

  const mediaRows = options.mediaRows ?? [];

  // the index goes first so it opens on the first tab
  const index = addIndexSheet(workbook, data, options, mediaRows.length);

  for (const typeSheet of data.sheets) {
    addDataSheet(workbook, typeSheet.sheet, typeSheet.columns, typeSheet.rows, options);
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
