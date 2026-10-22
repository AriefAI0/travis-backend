// Writes the tagged datasheet templates from the pristine vendor copies.
// Run: ~/.bun/bin/bun spike/build-datasheet-templates.ts
// flow: read _source > patch header tags > rebuild the data table > zip > write datasheets
//
// `templates/_source/` holds the five files as the user delivered them. Every
// part rides through verbatim except `word/document.xml`, which this file
// rewrites. Run it again after a vendor file changes, never against its own
// output. The runtime image copies `templates/datasheets` only.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PizZip = require("pizzip");

const SOURCE_DIR = new URL("../templates/_source/", import.meta.url);
const OUT_DIR = new URL("../templates/datasheets/", import.meta.url);

/* ---------- OOXML primitives ---------- */

const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const TAHOMA = '<w:rFonts w:ascii="Tahoma" w:hAnsi="Tahoma" w:cs="Tahoma"/>';
const rpr = (size = 16) => `<w:rPr>${TAHOMA}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;

// One text run. A tag never splits across runs.
const run = (text: string, size = 16) =>
  `<w:r>${rpr(size)}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

// A Word field with a cached value; both Word and LibreOffice recompute it.
const field = (instr: string) =>
  `<w:fldSimple w:instr="${instr}"><w:r>${rpr()}<w:t>1</w:t></w:r></w:fldSimple>`;

const borders = (first: boolean, last: boolean, header: boolean) =>
  "<w:tcBorders>" +
  `<w:top w:val="single" w:sz="${header ? 12 : 8}" w:space="0" w:color="000000"/>` +
  `<w:left w:val="single" w:sz="${first ? 12 : 6}" w:space="0" w:color="000000"/>` +
  `<w:bottom w:val="single" w:sz="${header ? 8 : 7}" w:space="0" w:color="000000"/>` +
  `<w:right w:val="single" w:sz="${last ? 12 : 6}" w:space="0" w:color="000000"/>` +
  "</w:tcBorders>";

type CellSpec = {
  w: number;
  text: string;
  span?: number;
  size?: number;
  vmerge?: "restart" | "continue";
  header?: boolean;
};

// One table cell; header cells carry the 10% grey of the vendor sheet.
const cell = (spec: CellSpec, first: boolean, last: boolean) => {
  const span = spec.span && spec.span > 1 ? `<w:gridSpan w:val="${spec.span}"/>` : "";
  const vmerge =
    spec.vmerge === "restart"
      ? '<w:vMerge w:val="restart"/>'
      : spec.vmerge === "continue"
        ? "<w:vMerge/>"
        : "";
  const shd = spec.header ? '<w:shd w:val="pct10" w:color="auto" w:fill="auto"/>' : "";
  const body = spec.text ? run(spec.text, spec.size) : "";
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${spec.w}" w:type="dxa"/>${span}${vmerge}` +
    `${borders(first, last, !!spec.header)}${shd}<w:vAlign w:val="center"/></w:tcPr>` +
    `<w:p><w:pPr><w:pStyle w:val="TableParagraph"/><w:spacing w:before="40"/>` +
    `<w:jc w:val="center"/></w:pPr>${body}</w:p></w:tc>`
  );
};

// One table row from its cells; the first and last carry the thick edge.
const row = (cells: CellSpec[]) =>
  `<w:tr>${cells.map((spec, i) => cell(spec, i === 0, i === cells.length - 1)).join("")}</w:tr>`;

const grid = (widths: number[]) =>
  `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;

type RowRange = { depth: number; start: number; end: number; xml: string };

// Every table row in document order, with the depth it sits at: a row inside a
// nested table is depth 1. A regex alone stops at the first `</w:tr>`.
const scanRows = (xml: string): RowRange[] => {
  const rows: RowRange[] = [];
  const open: number[] = [];
  const re = /<w:tr(?=[ >])|<\/w:tr>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[0] === "</w:tr>") {
      const start = open.pop();
      assert(start !== undefined, "unbalanced </w:tr>");
      rows.push({ depth: open.length, start, end: m.index + m[0].length, xml: xml.slice(start, m.index + m[0].length) });
    } else {
      open.push(m.index);
    }
  }
  return rows.sort((a, b) => a.start - b.start);
};

/* ---------- document.xml edits ---------- */

// Replace the run content of the paragraph holding `needle`, keeping its pPr.
const setCellText = (xml: string, needle: string, runs: string) => {
  const at = xml.indexOf(needle);
  assert(at !== -1, `cell text not found: ${needle}`);
  const start = xml.lastIndexOf("<w:tc>", at);
  const end = xml.indexOf("</w:tc>", at);
  const cellXml = xml.slice(start, end);
  const pStart = cellXml.indexOf("<w:p ");
  const pOpenEnd = cellXml.indexOf(">", pStart) + 1;
  const pClose = cellXml.indexOf("</w:p>", pOpenEnd);
  const pPrStart = cellXml.indexOf("<w:pPr>", pOpenEnd);
  const hasPr = pPrStart !== -1 && pPrStart < pClose;
  const pPrEnd = hasPr ? cellXml.indexOf("</w:pPr>", pPrStart) + "</w:pPr>".length : -1;
  assert(!cellXml.includes("</w:p>", pClose + 6), `cell ${needle} holds two paragraphs`);
  const rebuilt =
    cellXml.slice(0, pOpenEnd) +
    (hasPr ? cellXml.slice(pPrStart, pPrEnd) : "") +
    runs +
    "</w:p>" +
    cellXml.slice(pClose + 6);
  return xml.slice(0, start) + rebuilt + xml.slice(end);
};

// Rewrite each cell of one row, in order.
const mapRowCells = (target: string, rewrite: (cellXml: string, i: number) => string) => {
  let i = 0;
  return target.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (cellXml) => rewrite(cellXml, i++));
};

// Same pPr trick as setCellText, for a cell already in hand.
const withText = (cellXml: string, runs: string) => {
  const pStart = cellXml.indexOf("<w:p ");
  const pOpenEnd = cellXml.indexOf(">", pStart) + 1;
  const pClose = cellXml.indexOf("</w:p>", pOpenEnd);
  const pPrStart = cellXml.indexOf("<w:pPr>", pOpenEnd);
  const hasPr = pPrStart !== -1 && pPrStart < pClose;
  const pPrEnd = hasPr ? cellXml.indexOf("</w:pPr>", pPrStart) + "</w:pPr>".length : -1;
  return (
    cellXml.slice(0, pOpenEnd) +
    (hasPr ? cellXml.slice(pPrStart, pPrEnd) : "") +
    runs +
    "</w:p>" +
    cellXml.slice(pClose + 6)
  );
};

// Swap the column grid and the header/data rows of the table holding `needle`.
// Everything above the header row (the sheet header cells) stays untouched.
const rebuildTable = (xml: string, needle: string, widths: number[], rows: string[]) => {
  const at = xml.indexOf(needle);
  assert(at !== -1, `table not found: ${needle}`);
  const tableStart = xml.lastIndexOf("<w:tbl>", at);
  const tableEnd = xml.indexOf("</w:tbl>", at) + "</w:tbl>".length;
  const gridStart = xml.indexOf("<w:tblGrid>", tableStart);
  const gridEnd = xml.indexOf("</w:tblGrid>", gridStart) + "</w:tblGrid>".length;

  const headerRow = scanRows(xml).find(
    (candidate) => candidate.depth === 0 && candidate.start > tableStart && candidate.xml.includes(needle),
  );
  assert(headerRow, `header row not found: ${needle}`);

  return (
    xml.slice(0, gridStart) +
    grid(widths) +
    xml.slice(gridEnd, headerRow.start) +
    rows.join("") +
    "</w:tbl>" +
    xml.slice(tableEnd)
  );
};

/* ---------- header ---------- */

// Fill the four header fields the locked design allows; everything else blank.
const patchHeader = (xml: string, kind: string) => {
  let out = setCellText(
    xml,
    "Sheet:",
    run("Sheet: ") + field(" PAGE ") + run(" of ") + field(" NUMPAGES "),
  );
  out = setCellText(out, kind === "gvi" ? "Report" : "Report No.:", run("Report No.: {ReportNo}"));
  out = setCellText(out, "Date:", run("Date: {Date}"));
  if (kind === "cp_anode") {
    out = setCellText(out, "Client :", run("Client : {Client}"));
    out = setCellText(
      out,
      "DVD/Recording Ref. No.:",
      run("DVD/Recording Ref. No.: {Session}"),
    );
  }
  return out;
};

/* ---------- GVI ---------- */

// Five fixed columns; the single blank row repeats per result.
const patchGvi = (xml: string) => {
  const rows = scanRows(xml);
  assert.equal(rows.length, 7, "gvi: expected 7 rows");
  const last = rows[6]!;
  const tags = ["{component_id}", "{component_type}", "{depth_el}", "{condition}", "{remarks}"];
  const patched = mapRowCells(last.xml, (cellXml, i) =>
    withText(
      cellXml,
      run(i === 0 ? `{#rows}${tags[0]}` : i === 4 ? `${tags[4]}{/rows}` : tags[i]!),
    ),
  );
  return xml.slice(0, last.start) + patched + xml.slice(last.end);
};

/* ---------- CP-ANODE ---------- */

const CP_ANODE_WIDTHS = [1700, 1250, 900, 1000, 850, 850, 850, 950, 950, 1332];

const buildCpAnode = (xml: string) => {
  const header: CellSpec[] = [
    "COMPONENT ID",
    "ANODE TYPE",
    "CP (mV)",
    "DEPLETION (%)",
    "WIDTH (mm)",
    "HEIGHT (mm)",
    "LENGTH (mm)",
    "WIDEST PIT (mm)",
    "DEEPEST PIT (mm)",
    "REMARKS",
  ].map((text, i) => ({ w: CP_ANODE_WIDTHS[i]!, text, header: true }));

  const tags = [
    "component_id",
    "anode_type",
    "voltage_mv",
    "depletion",
    "anode_width",
    "anode_height",
    "anode_length",
    "widest_pit",
    "deepest_pit",
    "remarks",
  ];
  const data = tags.map((tag, i) => ({
    w: CP_ANODE_WIDTHS[i]!,
    text: i === 0 ? `{#rows}{${tag}}` : i === tags.length - 1 ? `{${tag}}{/rows}` : `{${tag}}`,
  }));

  return rebuildTable(xml, "COMPONENT", CP_ANODE_WIDTHS, [row(header), row(data)]);
};

/* ---------- CP-MEMBER (renders CVI results) ---------- */

const CP_MEMBER_WIDTHS = [2000, 1000, 1600, 990, 990, 990, 990, 2015];

const buildCpMember = (xml: string) => {
  const fixed = (text: string, i: number, vmerge: CellSpec["vmerge"]): CellSpec => ({
    w: CP_MEMBER_WIDTHS[i]!,
    text,
    vmerge,
    header: true,
  });

  const head: CellSpec[] = [
    fixed("COMPONENT ID", 0, "restart"),
    fixed("CP (mV)", 1, "restart"),
    fixed("NOMINAL WALL THICKNESS (mm)", 2, "restart"),
    { w: 3960, text: "CLOCK POSITION (UT mm)", span: 4, header: true },
    fixed("REMARKS", 7, "restart"),
  ];

  const clock = ["12 o'clock", "3 o'clock", "6 o'clock", "9 o'clock"].map((text, i) => ({
    w: CP_MEMBER_WIDTHS[3 + i]!,
    text,
    header: true,
  }));

  const sub: CellSpec[] = [
    fixed("", 0, "continue"),
    fixed("", 1, "continue"),
    fixed("", 2, "continue"),
    ...clock,
    fixed("", 7, "continue"),
  ];

  const tags = [
    "component_id",
    "cp_mv",
    "wall_mm",
    "clock_12",
    "clock_3",
    "clock_6",
    "clock_9",
    "remarks",
  ];
  const data = tags.map((tag, i) => ({
    w: CP_MEMBER_WIDTHS[i]!,
    text: i === 0 ? `{#rows}{${tag}}` : i === tags.length - 1 ? `{${tag}}{/rows}` : `{${tag}}`,
  }));

  return rebuildTable(xml, "COMPONENT", CP_MEMBER_WIDTHS, [row(head), row(sub), row(data)]);
};

/* ---------- FMD ---------- */

const FMD_WIDTHS = [1900, 1400, 850, 600, 600, 600, 600, 600, 600, 600, 600, 1625];

const buildFmd = (xml: string) => {
  const fixed = (text: string, i: number, vmerge: CellSpec["vmerge"]): CellSpec => ({
    w: FMD_WIDTHS[i]!,
    text,
    vmerge,
    header: true,
  });

  const attempts = ["Initial", "Additional 1", "Additional 2", "Additional 3"].map(
    (text, i) => ({ w: 1200, text, span: 2, header: true, size: 14 }),
  );

  const head: CellSpec[] = [
    fixed("COMPONENT ID", 0, "restart"),
    fixed("COMPONENT TYPE", 1, "restart"),
    fixed("EL (-)m", 2, "restart"),
    ...attempts,
    fixed("REMARKS", 11, "restart"),
  ];

  const pair = ["Flooded", "Dry"].map((text) => ({ w: 600, text, header: true, size: 14 }));
  const sub: CellSpec[] = [
    fixed("", 0, "continue"),
    fixed("", 1, "continue"),
    fixed("", 2, "continue"),
    ...[0, 1, 2, 3].flatMap(() => pair.map((spec) => ({ ...spec }))),
    fixed("", 11, "continue"),
  ];

  const tags = [
    "component_id",
    "component_type",
    "depth_el",
    "initial_flooded",
    "initial_dry",
    "add1_flooded",
    "add1_dry",
    "add2_flooded",
    "add2_dry",
    "add3_flooded",
    "add3_dry",
    "remarks",
  ];
  const data = tags.map((tag, i) => ({
    w: FMD_WIDTHS[i]!,
    text: i === 0 ? `{#rows}{${tag}}` : i === tags.length - 1 ? `{${tag}}{/rows}` : `{${tag}}`,
  }));

  return rebuildTable(xml, "COMPONENT", FMD_WIDTHS, [row(head), row(sub), row(data)]);
};

/* ---------- SCOUR ---------- */

// The outer row repeats per result, so the drawing clones with it.
const patchScour = (xml: string) => {
  const rows = scanRows(xml);
  const outerRow = rows.find((candidate) => candidate.depth === 0 && candidate.xml.includes("<w:drawing"));
  assert(outerRow, "scour: outer row not found");
  const outer = outerRow.xml;

  // nested table rows: Location, Dim A/B/C, Exp. Piles, Height
  const nested = rows
    .filter((candidate) => candidate.depth === 1)
    .map((candidate) => candidate.xml);
  assert.equal(nested.length, 6, "scour: expected 6 nested rows");

  const legCells = mapRowCells(nested[0]!, (cellXml, i) =>
    i === 0
      ? cellXml
      : withText(cellXml, run(i === 1 ? "Leg : {location_leg1}" : "Leg : {location_leg2}", 18)),
  );

  const dim = (index: number, tag: string) =>
    mapRowCells(nested[index]!, (cellXml, i) => (i === 0 ? cellXml : withText(cellXml, run(`{${tag}}`, 18))));

  const legs = (index: number, left: string, right: string) =>
    mapRowCells(nested[index]!, (cellXml, i) =>
      i === 0 ? cellXml : withText(cellXml, run(i === 1 ? `{${left}}` : `{${right}}`, 18)),
    );

  const patchedNested = [
    legCells,
    dim(1, "dim_a"),
    dim(2, "dim_b"),
    dim(3, "dim_c"),
    legs(4, "exp_leg1", "exp_leg2"),
    legs(5, "height_exp_leg1", "height_exp_leg2"),
  ];

  let rebuilt = outer;
  for (let i = 0; i < nested.length; i++) rebuilt = rebuilt.replace(nested[i]!, patchedNested[i]!);

  // open the loop inside the picture paragraph, close it after the nested table
  rebuilt = rebuilt.replace(
    /(<w:p [^>]*>)(<w:pPr>[\s\S]*?<\/w:pPr>)/,
    `$1$2${run("{#scour_rows}")}`,
  );
  // the cell keeps an empty paragraph after the nested table: close the loop there
  const tail = "</w:pPr></w:p></w:tc></w:tr>";
  const closeAt = rebuilt.lastIndexOf(tail);
  assert(closeAt !== -1, "scour: closing paragraph not found");
  rebuilt = rebuilt.slice(0, closeAt) + `</w:pPr>${run("{/scour_rows}")}</w:p></w:tc></w:tr>` + rebuilt.slice(closeAt + tail.length);
  assert(rebuilt.includes("{#scour_rows}") && rebuilt.includes("{/scour_rows}"), "scour: loop tags missing");

  return xml.slice(0, outerRow.start) + rebuilt + xml.slice(outerRow.end);
};

/* ---------- build ---------- */

const BUILDERS: Record<string, (xml: string) => string> = {
  gvi: patchGvi,
  cp_anode: buildCpAnode,
  cp_member: buildCpMember,
  fmd: buildFmd,
  scour: patchScour,
};

for (const [kind, build] of Object.entries(BUILDERS)) {
  const zip = new PizZip(await Bun.file(new URL(`${kind}.docx`, SOURCE_DIR)).arrayBuffer());
  const document = zip.file("word/document.xml")!.asText();
  const patched = build(patchHeader(document, kind));

  // the tags survive the zip round trip, and no placeholder collides
  zip.file("word/document.xml", patched);
  const out = zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
  await Bun.write(new URL(`${kind}.docx`, OUT_DIR), out);
  console.log(`${kind}: ${document.length} > ${patched.length} bytes`);
}
