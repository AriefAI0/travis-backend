// Builds the bundled report template from the user's own Word file.
// Run: ~/.bun/bin/bun spike/create-template.ts
// flow: read source.docx > keep every part > rebuild document.xml > zip > self-check > write
//
// `spike/source.docx` is the branding source: the user's Word file, holding the
// letterhead, the styles, the theme and the report's placeholders. Replace that
// file when the branding changes, then run this again. Every part rides through
// verbatim except `word/document.xml`, which this file generates, so the fonts,
// the logo and the first-page borders keep the user's look exactly.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  sectionRegionTags,
  TYPE_ORDER,
  TYPE_TABLES,
  type InspectionType,
  type RegionSection,
} from "../src/features/reports/report-layout";

const require = createRequire(import.meta.url);
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const ImageModule = require("docxtemplater-image-module-free");

const SOURCE = new URL("./source.docx", import.meta.url);
const OUT_PATH = new URL("../src/features/reports/default-template.docx", import.meta.url);

// A4 portrait minus the 1134-twip side margins.
const TABLE_W = 11906 - 2268;

/* ---------- OOXML primitives ---------- */

const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type ParaOpts = { bold?: boolean; size?: number; align?: "left" | "center" };

// One paragraph holding one run. A tag never splits across runs.
const para = (text: string, opts: ParaOpts = {}) => {
  const rPr = [
    opts.bold ? "<w:b/>" : "",
    opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : "",
  ].join("");
  const pPr = opts.align ? `<w:pPr><w:jc w:val="${opts.align}"/></w:pPr>` : "";
  return `<w:p>${pPr}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
};

const colW = (cols: number) => Math.floor(TABLE_W / cols);

const cell = (cols: number, xml: string) =>
  `<w:tc><w:tcPr><w:tcW w:w="${colW(cols)}" w:type="dxa"/></w:tcPr>${xml}</w:tc>`;

const headRow = (cols: number, labels: string[]) =>
  `<w:tr><w:trPr><w:tblHeader/></w:trPr>${labels.map((l) => cell(cols, para(l, { bold: true }))).join("")}</w:tr>`;

const dataRow = (cols: number, tags: string[]) =>
  `<w:tr>${tags.map((t) => cell(cols, para(t))).join("")}</w:tr>`;

const BORDERS = ["top", "left", "bottom", "right", "insideH", "insideV"]
  .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`)
  .join("");

// A table must not touch the next table or end a block. Word merges two tables
// that touch, and a caret cannot land after a table that ends one, so every
// table carries this empty paragraph behind it.
const EMPTY_PARA = "<w:p/>";

// A fixed-width table. `rows` are pre-built <w:tr> strings. `bordered: false`
// drops the grid, so the contents list on the title page reads as text.
//
// No paragraph behind it: the gap belongs outside the region, so a user can type
// under the table and keep that text through a refresh. `regionBlock` adds it.
const tbl = (cols: number, rows: string[], bordered = true) =>
  `<w:tbl><w:tblPr><w:tblW w:w="${TABLE_W}" w:type="dxa"/>${bordered ? `<w:tblBorders>${BORDERS}</w:tblBorders>` : ""}<w:tblLayout w:type="fixed"/></w:tblPr>` +
  `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${colW(cols)}"/>`).join("")}</w:tblGrid>` +
  `${rows.join("")}</w:tbl>`;

// Header row plus one repeated data row. The loop tags sit in the outer cells
// of that same row: docxtemplater expands the pair to <w:tr> and drops the tags.
const loopTable = (cols: number, labels: string[], tags: string[], loop: string, bordered = true) => {
  const rowTags = [...tags];
  rowTags[0] = `{#${loop}}${rowTags[0]}`;
  rowTags[rowTags.length - 1] = `${rowTags[rowTags.length - 1]}{/${loop}}`;
  return tbl(cols, [headRow(cols, labels), dataRow(cols, rowTags)], bordered);
};

const sectionHeading = (text: string) => para(text, { bold: true, size: 26 });

// One content control per generated section, tagged from the data. A refresh
// finds the region it rewrites by this tag, and leaves everything outside it
// alone. The tag is a value, never a position, so a re-render names the same
// regions. Word and the browser editor both keep it through a save.
//
// The tag value is the constant `region`, not data. docxtemplater substitutes
// inside `<w:t>` text runs only, and a raw-XML tag needs a `<w:p>`, so neither
// form reaches a `w:sdtPr` attribute. `renderReport` writes the real tag into
// each placeholder region afterwards, in the order the sections rendered.
const REGION_PLACEHOLDER = "region";
const regionControl = (body: string) =>
  `<w:sdt><w:sdtPr><w:tag w:val="${REGION_PLACEHOLDER}"/></w:sdtPr><w:sdtContent>${body}</w:sdtContent></w:sdt>`;

// One region, then the gap that follows it. The gap sits outside every region,
// so text typed into it belongs to the user and a refresh leaves it alone.
const regionBlock = (body: string) => `${regionControl(body)}${EMPTY_PARA}`;

// Wrap one type's tables in a boolean block. A false flag drops the whole box,
// so a single template serves every inspection type.
//
// Each table gets its own region. The heading rides inside the first one, so a
// refresh restores it too.
const conditional = (type: InspectionType) =>
  para(`{#is${type}}`) +
  TABLES[type]
    .map((table, index) =>
      regionBlock((index === 0 ? sectionHeading(`${type} Results`) : "") + table),
    )
    .join("") +
  para(`{/is${type}}`);

/* ---------- per-type blocks ---------- */

// One row per result, except CVI/DVI and MGI which repeat the parent fields
// down each child row. Word cannot nest a loop inside a table row.
//
// One entry per table, in the order the type renders them. The list length must
// equal TYPE_TABLES for that type, or the renderer would hand a tag to the wrong
// region; the self-check asserts it.
const TABLES: Record<InspectionType, string[]> = {
  GVI: [loopTable(
    7,
    ["KP Range", "Depth/El", "GVI CP", "GVI UT", "Condition", "Remarks", "Recorded"],
    ["{kp_range}", "{depth_el}", "{gvi_cp}", "{gvi_ut}", "{condition}", "{remarks}", "{recorded}"],
    "rows",
  )],
  CP: [loopTable(
    10,
    ["Anode Type", "Voltage (mV)", "Depletion", "Width", "Height", "Length", "Widest Pit", "Deepest Pit", "Remarks", "Recorded"],
    ["{anode_type}", "{voltage_mv}", "{depletion}", "{anode_width}", "{anode_height}", "{anode_length}", "{widest_pit}", "{deepest_pit}", "{remarks}", "{recorded}"],
    "rows",
  )],
  FMD: [loopTable(
    7,
    ["Depth/El", "Initial", "Add. 1", "Add. 2", "Add. 3", "Remarks", "Recorded"],
    ["{depth_el}", "{initial_attempt}", "{additional_attempt_1}", "{additional_attempt_2}", "{additional_attempt_3}", "{remarks}", "{recorded}"],
    "rows",
  )],
  SCOUR: [loopTable(
    7,
    ["Exposed Pile", "Exposed Height", "Height Leg 1", "Height Midpoint", "Height Leg 2", "Remarks", "Recorded"],
    ["{exposed_pile}", "{exposed_pile_height}", "{height_leg1}", "{height_midpoint}", "{height_leg2}", "{remarks}", "{recorded}"],
    "rows",
  )],
  CVI: [loopTable(
    6,
    ["Datum Reference", "Member Type", "CP (mV)", "Clock Position", "UT (mm)", "Findings"],
    ["{datum_reference}", "{member_type}", "{cp_potential_mv}", "{clock_position}", "{ut_mm}", "{findings}"],
    "rows",
  )],
  DVI: [loopTable(
    6,
    ["Datum Reference", "Member Type", "CP (mV)", "Clock Position", "UT (mm)", "Findings"],
    ["{datum_reference}", "{member_type}", "{cp_potential_mv}", "{clock_position}", "{ut_mm}", "{findings}"],
    "rows",
  )],
  MGI: [loopTable(
    7,
    ["No MG Observed", "Criteria", "Growth Type", "Species", "Coverage %", "Thickness (mm)", "Remarks"],
    ["{no_mg_observed}", "{criteria_preset}", "{growth_type}", "{species}", "{coverage_percent}", "{thickness_mm}", "{remarks}"],
    "rows",
  )],

  // BSI carries 24 columns, so it splits over four tables.
  BSI: [
    loopTable(
      8,
      ["Clamp Type", "Depth/El", "Bolt/Nut Qty", "Outboard CP", "CP Anomaly Rec.", "Hinge Pin", "Hinge Bolt/Nut Qty", "Liners"],
      ["{clamp_type}", "{depth_el}", "{clamp_bolt_nut_quantity}", "{outboard_clamp_cp}", "{cp_anomaly_recommendation}", "{hinge_pin}", "{hinge_bolt_nut_quantity}", "{liners}"],
      "rows",
    ),
    loopTable(
      5,
      ["Inboard Gap", "Est. Gap", "Inboard Alignment", "Misaligned Position", "Inboard Anomaly Rec."],
      ["{inboard_gap_condition}", "{inboard_estimate_gap}", "{inboard_alignment_condition}", "{inboard_misaligned_position}", "{inboard_anomaly_recommendation}"],
      "rows",
    ),
    loopTable(
      5,
      ["Outboard Gap", "Est. Gap", "Outboard Alignment", "Misaligned Position", "Outboard Anomaly Rec."],
      ["{outboard_gap_condition}", "{outboard_estimate_gap}", "{outboard_alignment_condition}", "{outboard_misaligned_position}", "{outboard_anomaly_recommendation}"],
      "rows",
    ),
    loopTable(
      6,
      ["Clamp Missing Bolts", "Clamp Missing Washers", "Hinge Missing Bolts", "Hinge Missing Washers", "Remarks", "Recorded"],
      ["{clamp_missing_bolts}", "{clamp_missing_washers}", "{hinge_missing_bolts}", "{hinge_missing_washers}", "{remarks}", "{recorded}"],
      "rows",
    ),
  ],

  // CGB is one row per result.
  CGB: [loopTable(
    6,
    ["Movement", "Movement Remark", "Debris", "Debris Type", "Remarks", "Recorded"],
    ["{movement}", "{movement_remark}", "{debris}", "{debris_type}", "{remarks}", "{recorded}"],
    "rows",
  )],

  // RISER splits over two tables so no row carries thirteen columns.
  RISER: [
    loopTable(
      5,
      ["Touchdown Distance", "Bend to Mudbrace", "Bend Height", "Coating Status", "Coating Condition"],
      ["{touchdown_distance}", "{mudbrace_distance}", "{bend_height}", "{coating_status}", "{coating_condition}"],
      "rows",
    ),
    loopTable(
      8,
      ["Knee Brace", "Debris", "Debris Type", "Anomaly", "Recommendation", "Restricted Access", "Remarks", "Recorded"],
      ["{knee_brace}", "{debris}", "{debris_type}", "{anomaly}", "{recommendation}", "{restricted_access}", "{remarks}", "{recorded}"],
      "rows",
    ),
  ],

  // CAISSON splits into the condition block and the CP/pipe block.
  CAISSON: [
    loopTable(
      7,
      ["Visual Damage", "Visual Note", "Debris Present", "Debris Note", "Grating Present", "Blockage", "Grating Note"],
      ["{visual_damage}", "{visual_damage_note}", "{debris_present}", "{debris_note}", "{grating_present}", "{grating_blockage}", "{grating_note}"],
      "rows",
    ),
    loopTable(
      5,
      ["Associated Pipes", "Pipes Note", "CP Readings", "Remarks", "Recorded"],
      ["{associated_pipes}", "{associated_pipes_note}", "{cp_readings}", "{remarks}", "{recorded}"],
      "rows",
    ),
  ],

  // SEABED is one row per survey line.
  SEABED: [loopTable(
    6,
    ["Range (m)", "Fixes", "Debris", "Debris Type", "Remarks", "Recorded"],
    ["{range_meters}", "{fixes}", "{debris}", "{debris_type}", "{remarks}", "{recorded}"],
    "rows",
  )],

  // PIPELINE repeats the parent fields down one row per finding.
  PIPELINE: [loopTable(
    8,
    ["Location", "Depth/El", "Orientation", "Category", "Damage Type", "Debris Type", "Remarks", "Recorded"],
    ["{location}", "{depth_el}", "{orientation}", "{pipeline_category}", "{pipeline_damage}", "{pipeline_debris}", "{remarks}", "{recorded}"],
    "rows",
  )],
};

/* ---------- document ---------- */

// The source document, taken apart. Its root element keeps Word's own namespace
// declarations, and its section properties ride through whole, so the first-page
// borders and the margins stay the user's. Only the body between them is built.
const sourceZip = new PizZip(await Bun.file(SOURCE).arrayBuffer());
const sourceDoc = sourceZip.file("word/document.xml").asText() as string;

const BODY_OPEN = "<w:body>";
const bodyAt = sourceDoc.indexOf(BODY_OPEN);
const sectAt = sourceDoc.lastIndexOf("<w:sectPr");
assert.ok(bodyAt > 0 && sectAt > bodyAt, "the source document has no body or no section properties");

const DOC_TAIL = sourceDoc.slice(sectAt);

// Word declares the prefixes its own drawings use, which is not the set the
// image module injects. That module writes <w:drawing><wp:inline>...
// <a:graphic><pic:pic> into the rendered document and expects the root to
// declare those prefixes. Word tolerates an undeclared prefix; strict readers
// reject the whole document with "undeclared-prefix", so the editor cannot open
// the report. Add the ones the source root leaves out.
const DRAWING_NAMESPACES: Record<string, string> = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  a14: "http://schemas.microsoft.com/office/drawing/2010/main",
};

const ROOT_OPEN = Object.entries(DRAWING_NAMESPACES).reduce(
  (root, [prefix, uri]) =>
    root.includes(`xmlns:${prefix}=`)
      ? root
      : root.replace("<w:document", `<w:document xmlns:${prefix}="${uri}"`),
  sourceDoc.slice(0, bodyAt + BODY_OPEN.length),
);

// The intro block ends with its own page break. Split it off, so the counts and
// the contents list land on the title page and the first result starts the page
// after it. The break stays where the user drew it.
const splitIntro = (body: string) => {
  const breaks = body.match(/<w:br w:type="page"\/>/g) ?? [];
  assert.equal(breaks.length, 1, `the intro block holds ${breaks.length} page breaks, not 1`);
  const at = body.indexOf('<w:br w:type="page"/>');
  const start = Math.max(body.lastIndexOf("<w:p ", at), body.lastIndexOf("<w:p>", at));
  const end = body.indexOf("</w:p>", at) + "</w:p>".length;
  assert.ok(start > 0 && end > start, "the page break sits in no paragraph");
  return { intro: body.slice(0, start), pageBreak: body.slice(start, end) };
};

const { intro: INTRO, pageBreak: PAGE_BREAK } = splitIntro(
  sourceDoc.slice(bodyAt + BODY_OPEN.length, sectAt),
);

// The title page tail: the counts, then a contents list built from the same
// items the content zone loops. The heading rides inside `has_index`, so an
// empty report shows no heading over an empty table.
const INTRO_TAIL =
  para(`Targets inspected: {total_targets}`, { size: 28, align: "center" }) +
  para(`Results recorded: {total_results}`, { size: 28, align: "center" }) +
  para("{#has_index}") +
  para("Report Contents", { bold: true, size: 28, align: "center" }) +
  loopTable(2, ["Target", "Inspection Types"], ["{index_label}", "{index_types}"], "index", false) +
  para("{/has_index}");

// The three zones. Each is a boolean block, so the shape of the document is
// data, not a fixed layout: a zone the generator turns off leaves nothing
// behind, and a zone it never supplies cannot drop silently.
const CONTENT =
  para("{#content}") +
  para("{#items}") +
  tbl(5, [
    headRow(5, ["Task Group", "Task Code", "Description", "Type Code", "Part Code"]),
    dataRow(5, ["{task_group}", "{task_code}", "{description}", "{type_code}", "{part_code}"]),
  ]) +
  para("{#sections}") +
  // The picture is generated content, so it carries its own region and a
  // refresh can replace a picture whose evidence changed. A section without a
  // picture draws no frame at all: an empty box reads as a defect, which is what
  // `has_image` tells the two cases apart.
  //
  // The empty paragraph sits inside this region and nowhere else. It keeps the
  // region's content valid when there is no picture, and it doubles as the gap
  // between the picture and the first table.
  regionControl(
    para("{#has_image}") +
      para("{%image}", { align: "center" }) +
      para("{/has_image}") +
      EMPTY_PARA,
  ) +
  TYPE_ORDER.map(conditional).join("") +
  para("{/sections}") +
  para("{/items}") +
  para("{/content}");

// Sign-off. Static lines, inside a named zone so the closing page is a block of
// its own rather than whatever follows the last result.
const CLOSING =
  para("{#closing}") +
  para("Prepared by: ______________________", { size: 28 }) +
  para("Approved by: ______________________", { size: 28 }) +
  para("{/closing}");

const DOCUMENT_XML =
  ROOT_OPEN + INTRO + INTRO_TAIL + PAGE_BREAK + CONTENT + CLOSING + DOC_TAIL;

// Assemble the zip. Every part of the source rides through verbatim except the
// document body this file generates, and each keeps its own timestamp so
// regenerating the template only changes the file when its content changes.
const buildTemplate = async () => {
  const zip = new PizZip();
  for (const [name, file] of Object.entries(sourceZip.files)) {
    const part = file as { dir: boolean; date: Date; asUint8Array: () => Uint8Array };
    if (part.dir || name === "word/document.xml") continue;
    zip.file(name, part.asUint8Array(), { date: part.date });
  }
  zip.file("word/document.xml", DOCUMENT_XML);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
};

/* ---------- self-check ---------- */

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// Fill the template with a payload and return word/document.xml.
// renderAsync mirrors production, where getImage is async, and so does the
// nullGetter: a tag the payload misses stays visible rather than reading
// "undefined", which is what lets the checks below catch one.
const renderWith = async (buffer: Buffer, data: unknown): Promise<string> => {
  const imageModule = new ImageModule({
    centered: false,
    fileType: "docx",
    getImage: async () => TRANSPARENT_PNG,
    getSize: () => [200, 150],
  });
  const doc = new Docxtemplater(new PizZip(buffer), {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: (part: { value?: string }) => (part?.value ? `{${part.value}}` : ""),
    modules: [imageModule],
  });
  await doc.renderAsync(data);
  return doc.getZip().files["word/document.xml"].asText();
};

const flags = (on: InspectionType) =>
  Object.fromEntries(TYPE_ORDER.map((type) => [`is${type}`, type === on]));

// One representative row per type, keys matching the template tags.
const ROW_FOR: Record<InspectionType, Record<string, string>> = {
  GVI: { kp_range: "KP1", depth_el: "1.5", gvi_cp: "2", gvi_ut: "3", condition: "GOOD", remarks: "gvi-remark", recorded: "2026-10-09" },
  CP: { anode_type: "AL", voltage_mv: "900", depletion: "20", anode_width: "1", anode_height: "2", anode_length: "3", widest_pit: "4", deepest_pit: "5", remarks: "cp-remark", recorded: "2026-10-09" },
  FMD: { depth_el: "1.5", initial_attempt: "PASS", additional_attempt_1: "PASS", additional_attempt_2: "FAIL", additional_attempt_3: "PASS", remarks: "fmd-remark", recorded: "2026-10-09" },
  SCOUR: { exposed_pile: "YES", exposed_pile_height: "0.5", height_leg1: "1", height_midpoint: "2", height_leg2: "3", remarks: "scour-remark", recorded: "2026-10-09" },
  CVI: { datum_reference: "D1", member_type: "LEG", cp_potential_mv: "-800", clock_position: "12:00", ut_mm: "9.5", findings: "cvi-finding" },
  DVI: { datum_reference: "D2", member_type: "BRACE", cp_potential_mv: "-810", clock_position: "3:00", ut_mm: "9.6", findings: "dvi-finding" },
  MGI: { no_mg_observed: "0", criteria_preset: "DNV", growth_type: "HARD", species: "Barnacle", coverage_percent: "40", thickness_mm: "12", remarks: "mgi-remark" },
  BSI: { clamp_type: "C1", depth_el: "2", clamp_bolt_nut_quantity: "8", outboard_clamp_cp: "1", cp_anomaly_recommendation: "none", hinge_pin: "YES", hinge_bolt_nut_quantity: "4", liners: "NO", inboard_gap_condition: "OK", inboard_estimate_gap: "1", inboard_alignment_condition: "OK", inboard_misaligned_position: "na", inboard_anomaly_recommendation: "inb-rec", outboard_gap_condition: "OK", outboard_estimate_gap: "2", outboard_alignment_condition: "OK", outboard_misaligned_position: "na", outboard_anomaly_recommendation: "outb-rec", clamp_missing_bolts: "1,2", clamp_missing_washers: "3", hinge_missing_bolts: "", hinge_missing_washers: "", remarks: "bsi-remark", recorded: "2026-10-09" },
  CGB: { movement: "YES", movement_remark: "moved", debris: "NO", debris_type: "n/a", remarks: "cgb-remark", recorded: "2026-10-09" },
  RISER: { touchdown_distance: "1.5", mudbrace_distance: "2.5", bend_height: "3.5", coating_status: "Present", coating_condition: "Good", knee_brace: "YES", debris: "NO", debris_type: "n/a", anomaly: "NO", recommendation: "riser-rec", restricted_access: "NO", remarks: "riser-remark", recorded: "2026-10-09" },
  CAISSON: { visual_damage: "NO", visual_damage_note: "vd-note", debris_present: "YES", debris_note: "deb-note", grating_present: "YES", grating_blockage: "25-50%", grating_note: "gr-note", associated_pipes: "P-1", associated_pipes_note: "pipes-note", cp_readings: "-900", remarks: "ci-remark", recorded: "2026-10-09" },
  SEABED: { range_meters: "12.5", fixes: "F-1", debris: "YES", debris_type: "HARD", remarks: "seabed-remark", recorded: "2026-10-09" },
  PIPELINE: { location: "KP-1", depth_el: "2.5", orientation: "12_oclock", pipeline_category: "damage", pipeline_damage: "CRACK", pipeline_debris: "hard", remarks: "pi-remark", recorded: "2026-10-09" },
};

const section = (on: InspectionType) => ({
  inspection_type: on,
  // the target the section hangs off; the renderer builds region tags from it
  target_key: "description:1",
  // the tag value is the object key; the renderer reads it from MinIO
  image: `evidence/${on}.png`,
  has_image: true,
  ...flags(on),
  rows: [ROW_FOR[on]],
});

// The zone switches and the title-page numbers, as `gatherReportData` supplies
// them. `has_index` guards the contents table: an empty row loop would leave a
// table with no rows behind, which Word reads as a damaged file.
const base = {
  project_title: "Bridge A",
  project_id: 1,
  document_id: "DOC-1",
  generated_at: "2026-10-09",
  content: true,
  closing: true,
  total_targets: 1,
  total_results: 1,
  has_index: true,
  index: [{ index_label: "Desc", index_types: "GVI, CVI" }],
};

// Every type at once: the widest path through the template.
const fullPayload = {
  ...base,
  items: [{
    task_group: "G1", task_code: "T1", description: "Desc", type_code: "TC", part_code: "PC",
    sections: TYPE_ORDER.map(section),
  }],
};

// One type only: proves a false flag drops its block.
const singlePayload = {
  ...base,
  items: [{
    task_group: "G1", task_code: "T1", description: "Desc", type_code: "TC", part_code: "PC",
    sections: [section("MGI")],
  }],
};

// A three-row loop: proves the row repeats and leaves no stray rows.
const multiRowPayload = {
  ...base,
  items: [{
    task_group: "G1", task_code: "T1", description: "Desc", type_code: "TC", part_code: "PC",
    sections: [{ ...section("GVI"), rows: [ROW_FOR.GVI, ROW_FOR.GVI, ROW_FOR.GVI] }],
  }],
};

// No picture anywhere: proves a section draws no frame when it has none.
const noImagePayload = {
  ...base,
  items: [{
    task_group: "G1", task_code: "T1", description: "Desc", type_code: "TC", part_code: "PC",
    sections: [{ ...section("MGI"), image: null, has_image: false }],
  }],
};

// The intro's own tables and logo come from the user's file, so the checks below
// read their counts from it rather than restating the branding.
const INTRO_ROWS = (INTRO.match(/<w:tr[ >]/g) ?? []).length;
const INTRO_DRAWINGS = (INTRO.match(/<w:drawing>/g) ?? []).length;

// Rows in a rendered document: the intro's tables, the contents list (a header
// plus one row), the item header table (a header plus one row), and each type
// table (a header row plus one row per result row). Read from the payload, so
// each case states only what it varies.
const rowsFor = (payload: typeof fullPayload) =>
  INTRO_ROWS +
  2 +
  payload.items.length * 2 +
  payload.items.reduce(
    (total, item) =>
      total +
      item.sections.reduce(
        (sum, s) => sum + TYPE_TABLES[s.inspection_type as InspectionType] * (1 + s.rows.length),
        0,
      ),
    0,
  );

// The regions a payload renders, in document order. The renderer names each
// placeholder after the section it holds, and it reads the same list, so this
// is the contract between the two.
const expectedRegions = (payload: { items: { sections: RegionSection[] }[] }) =>
  payload.items.flatMap((item) => item.sections.flatMap((section) => sectionRegionTags(section)));

// Region placeholders in a rendered document, in order. The renderer replaces
// each with a real tag: a mismatch means a tag would land on the wrong region.
const assertRegions = (xml: string, expected: string[]) => {
  const regions = xml.match(/<w:tag w:val="region"\/>/g) ?? [];
  assert.equal(
    regions.length,
    expected.length,
    `expected ${expected.length} regions, rendered ${regions.length}`,
  );
};

// Run the checks, then write the file.
const main = async () => {
  const template = await buildTemplate();

  // Every source part must survive, or Word finds a relationship with no target.
  const parts = new PizZip(template).files;
  assert.equal(
    Object.keys(parts).length,
    Object.keys(sourceZip.files).length,
    "the generated template lost a part",
  );
  assert.equal(
    parts["word/media/image1.jpeg"].asUint8Array().length,
    sourceZip.files["word/media/image1.jpeg"].asUint8Array().length,
    "the logo did not ride through",
  );

  const full = await renderWith(template, fullPayload);
  if (Bun.env.DUMP) await Bun.write("/tmp/rendered.xml", full);
  for (const type of TYPE_ORDER) {
    assert.ok(full.includes(`${type} Results`), `missing ${type} block`);
  }
  // The title page comes first, its own page break follows, then the results.
  const firstResult = full.indexOf("GVI Results");
  assert.ok(full.indexOf("Project ID:") < firstResult, "the intro block did not render first");
  assert.equal((full.match(/<w:br w:type="page"\/>/g) ?? []).length, 1, "wrong page break count");
  assert.ok(full.indexOf("Report Contents") < firstResult, "the contents list is not on the title page");
  assert.ok(full.indexOf("Prepared by:") > firstResult, "the sign-off block is not after the results");
  assert.ok(full.includes("Targets inspected: 1"), "the target count did not render");
  assert.ok(full.includes("Results recorded: 1"), "the result count did not render");
  assert.ok(full.includes("Desc"), "an index row did not render");
  for (const marker of ["KP1", "cp-remark", "fmd-remark", "scour-remark", "cvi-finding", "dvi-finding", "Barnacle", "outb-rec", "cgb-remark", "riser-rec", "gr-note", "seabed-remark", "pi-remark"]) {
    assert.ok(full.includes(marker), `missing value ${marker}`);
  }
  assert.equal((full.match(/<w:tr[ >]/g) ?? []).length, rowsFor(fullPayload), "unexpected row count");
  assert.equal(
    (full.match(/<w:drawing>/g) ?? []).length,
    TYPE_ORDER.length + INTRO_DRAWINGS,
    "wrong image count",
  );
  assert.ok(!full.includes("{/"), "closing tag left in output");
  assert.ok(!/\{[#/%]/.test(full), "template tag left in output");
  assert.ok(!full.includes("{region}"), "the region tag never rendered");
  // A placeholder the payload does not supply stays visible rather than reading
  // "undefined", so this catches a template tag the payload has outgrown.
  const unsupplied = full.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? [];
  assert.equal(unsupplied.length, 0, `values the payload never fills: ${unsupplied.join(", ")}`);
  assertRegions(full, expectedRegions(fullPayload));

  // The template's tables and the renderer's region list must agree, or a tag
  // lands on the wrong region.
  for (const type of TYPE_ORDER) {
    assert.equal(
      TABLES[type].length,
      TYPE_TABLES[type],
      `${type} lays out ${TABLES[type].length} tables but the layout says ${TYPE_TABLES[type]}`,
    );
  }

  const single = await renderWith(template, singlePayload);
  assert.ok(single.includes("MGI Results"), "MGI block dropped");
  for (const type of TYPE_ORDER.filter((t) => t !== "MGI")) {
    assert.ok(!single.includes(`${type} Results`), `${type} block not dropped`);
  }
  assertRegions(single, expectedRegions(singlePayload));

  const multi = await renderWith(template, multiRowPayload);
  assert.equal(
    (multi.match(/<w:tr[ >]/g) ?? []).length,
    rowsFor(multiRowPayload),
    "the GVI row loop did not repeat",
  );

  const noImage = await renderWith(template, noImagePayload);
  assert.equal(
    (noImage.match(/<w:drawing>/g) ?? []).length,
    INTRO_DRAWINGS,
    "a section with no picture still drew one",
  );
  // the picture region is still there, and still holds something
  assertRegions(noImage, expectedRegions(noImagePayload));
  assert.ok(
    !/<w:sdtContent><\/w:sdtContent>/.test(noImage),
    "a region rendered with no content",
  );

  // A count that does not match must fail the check, not pass quietly.
  assert.throws(
    () => assertRegions(full, expectedRegions(fullPayload).slice(1)),
    "a wrong count passed",
  );

  // Word merges two tables that touch, and a caret cannot land after a table
  // that ends a block. Each table therefore ends its own region, and every
  // region is followed by a paragraph the user can type into — that paragraph
  // sits outside the region, so a refresh leaves it alone.
  //
  //
  // docxtemplater inserts its own <w:p/> behind each table, since it cannot see
  // the content control that closes the region. `renderReport` removes it, and
  // the generator test checks that. This render is the raw template.
  assert.ok(!/<\/w:tbl><w:tbl>/.test(full), "two tables touch: Word merges them");
  assert.ok(!/<\/w:tbl>(?!<w:p)/.test(full), "a table has no paragraph behind it");
  assert.ok(!/<\/w:sdtContent>(?!<\/w:sdt>)/.test(full), "a region ends before its content does");
  // A region is followed by the gap paragraph, or by the next region where the
  // gap is already inside the picture region. Never by a table.
  assert.ok(
    !/<\/w:sdt>(?!<w:p|<w:sdt)/.test(full),
    "a region is followed by neither a paragraph nor another region",
  );
  // The body closes with a paragraph, never a table: a table cannot end a body.
  assert.ok(
    /(?:<\/w:p>|<w:p[^>]*\/>)\s*<w:sectPr[\s>]/.test(full),
    "the body does not end with a paragraph",
  );

  // The image module injects <w:drawing><wp:inline> markup and expects the
  // document root to declare the drawing namespaces, the way Word's own files
  // do. Word tolerates an undeclared prefix; strict readers reject the whole
  // document with "undeclared-prefix", so the editor cannot open the report.
  const rootTag = full.match(/<w:document\b[^>]*>/)?.[0];
  assert.ok(rootTag, "rendered output has no <w:document> root");
  for (const prefix of ["w", "r", "wp", "a", "pic", "a14"]) {
    assert.ok(
      new RegExp(`xmlns:${prefix}=`).test(rootTag),
      `xmlns:${prefix} missing from the document root`,
    );
  }
  // xml: is implicitly bound and needs no declaration
  for (const used of new Set([...full.matchAll(/<\/?([A-Za-z0-9_.-]+):/g)].map((m) => m[1]!))) {
    if (used === "xml") continue;
    assert.ok(
      new RegExp(`xmlns:${used}=`).test(rootTag),
      `output uses the ${used}: prefix but the root never declares it`,
    );
  }

  await Bun.write(OUT_PATH, template);
  console.log(`checks passed > wrote ${OUT_PATH.pathname} (${template.length} bytes)`);
};

await main();
