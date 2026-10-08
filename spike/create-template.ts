// Builds the bundled report template docx from raw OOXML.
// Run: ~/.bun/bin/bun spike/create-template.ts
// flow: build parts > zip > self-check render > write file
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const ImageModule = require("docxtemplater-image-module-free");

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

// A bordered fixed-width table. `rows` are pre-built <w:tr> strings.
const tbl = (cols: number, rows: string[]) =>
  `<w:tbl><w:tblPr><w:tblW w:w="${TABLE_W}" w:type="dxa"/><w:tblBorders>${BORDERS}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>` +
  `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${colW(cols)}"/>`).join("")}</w:tblGrid>` +
  `${rows.join("")}</w:tbl>`;

// Header row plus one repeated data row. The loop tags sit in the outer cells
// of that same row: docxtemplater expands the pair to <w:tr> and drops the tags.
const loopTable = (cols: number, labels: string[], tags: string[], loop: string) => {
  const rowTags = [...tags];
  rowTags[0] = `{#${loop}}${rowTags[0]}`;
  rowTags[rowTags.length - 1] = `${rowTags[rowTags.length - 1]}{/${loop}}`;
  return tbl(cols, [headRow(cols, labels), dataRow(cols, rowTags)]);
};

const sectionHeading = (text: string) => para(text, { bold: true, size: 26 });

// Wrap one type's tables in a boolean block. A false flag drops the whole box,
// so a single template serves every inspection type.
const conditional = (type: string, body: string) =>
  `${para(`{#is${type}}`)}${sectionHeading(`${type} Results`)}${body}${para(`{/is${type}}`)}`;

/* ---------- per-type blocks ---------- */

// One row per result, except CVI/DVI and MGI which repeat the parent fields
// down each child row. Word cannot nest a loop inside a table row.
const BLOCKS: Record<string, string> = {
  GVI: loopTable(
    7,
    ["KP Range", "Depth/El", "GVI CP", "GVI UT", "Condition", "Remarks", "Recorded"],
    ["{kp_range}", "{depth_el}", "{gvi_cp}", "{gvi_ut}", "{condition}", "{remarks}", "{recorded}"],
    "rows",
  ),
  CP: loopTable(
    10,
    ["Anode Type", "Voltage (mV)", "Depletion", "Width", "Height", "Length", "Widest Pit", "Deepest Pit", "Remarks", "Recorded"],
    ["{anode_type}", "{voltage_mv}", "{depletion}", "{anode_width}", "{anode_height}", "{anode_length}", "{widest_pit}", "{deepest_pit}", "{remarks}", "{recorded}"],
    "rows",
  ),
  FMD: loopTable(
    7,
    ["Depth/El", "Initial", "Add. 1", "Add. 2", "Add. 3", "Remarks", "Recorded"],
    ["{depth_el}", "{initial_attempt}", "{additional_attempt_1}", "{additional_attempt_2}", "{additional_attempt_3}", "{remarks}", "{recorded}"],
    "rows",
  ),
  SCOUR: loopTable(
    7,
    ["Exposed Pile", "Exposed Height", "Height Leg 1", "Height Midpoint", "Height Leg 2", "Remarks", "Recorded"],
    ["{exposed_pile}", "{exposed_pile_height}", "{height_leg1}", "{height_midpoint}", "{height_leg2}", "{remarks}", "{recorded}"],
    "rows",
  ),
  CVI: loopTable(
    6,
    ["Datum Reference", "Member Type", "CP (mV)", "Clock Position", "UT (mm)", "Findings"],
    ["{datum_reference}", "{member_type}", "{cp_potential_mv}", "{clock_position}", "{ut_mm}", "{findings}"],
    "rows",
  ),
  DVI: loopTable(
    6,
    ["Datum Reference", "Member Type", "CP (mV)", "Clock Position", "UT (mm)", "Findings"],
    ["{datum_reference}", "{member_type}", "{cp_potential_mv}", "{clock_position}", "{ut_mm}", "{findings}"],
    "rows",
  ),
  MGI: loopTable(
    7,
    ["No MG Observed", "Criteria", "Growth Type", "Species", "Coverage %", "Thickness (mm)", "Remarks"],
    ["{no_mg_observed}", "{criteria_preset}", "{growth_type}", "{species}", "{coverage_percent}", "{thickness_mm}", "{remarks}"],
    "rows",
  ),
};

// BSI carries 24 columns, so it splits over four tables.
BLOCKS.BSI =
  loopTable(
    8,
    ["Clamp Type", "Depth/El", "Bolt/Nut Qty", "Outboard CP", "CP Anomaly Rec.", "Hinge Pin", "Hinge Bolt/Nut Qty", "Liners"],
    ["{clamp_type}", "{depth_el}", "{clamp_bolt_nut_quantity}", "{outboard_clamp_cp}", "{cp_anomaly_recommendation}", "{hinge_pin}", "{hinge_bolt_nut_quantity}", "{liners}"],
    "rows",
  ) +
  loopTable(
    5,
    ["Inboard Gap", "Est. Gap", "Inboard Alignment", "Misaligned Position", "Inboard Anomaly Rec."],
    ["{inboard_gap_condition}", "{inboard_estimate_gap}", "{inboard_alignment_condition}", "{inboard_misaligned_position}", "{inboard_anomaly_recommendation}"],
    "rows",
  ) +
  loopTable(
    5,
    ["Outboard Gap", "Est. Gap", "Outboard Alignment", "Misaligned Position", "Outboard Anomaly Rec."],
    ["{outboard_gap_condition}", "{outboard_estimate_gap}", "{outboard_alignment_condition}", "{outboard_misaligned_position}", "{outboard_anomaly_recommendation}"],
    "rows",
  ) +
  loopTable(
    6,
    ["Clamp Missing Bolts", "Clamp Missing Washers", "Hinge Missing Bolts", "Hinge Missing Washers", "Remarks", "Recorded"],
    ["{clamp_missing_bolts}", "{clamp_missing_washers}", "{hinge_missing_bolts}", "{hinge_missing_washers}", "{remarks}", "{recorded}"],
    "rows",
  );

// Emission order across the whole document.
const TYPE_ORDER = ["GVI", "CVI", "DVI", "MGI", "CP", "FMD", "SCOUR", "BSI"];

/* ---------- document ---------- */

const BODY =
  para("Inspection Report", { bold: true, size: 32, align: "center" }) +
  para("{project_title}", { bold: true, size: 26, align: "center" }) +
  para("Document ID: {document_id}", { align: "center" }) +
  para("Project ID: {project_id}", { align: "center" }) +
  para("Generated: {generated_at}", { align: "center" }) +
  para("{#items}") +
  tbl(5, [
    headRow(5, ["Task Group", "Task Code", "Description", "Type Code", "Part Code"]),
    dataRow(5, ["{task_group}", "{task_code}", "{description}", "{type_code}", "{part_code}"]),
  ]) +
  para("{#sections}") +
  para("{%image}", { align: "center" }) +
  TYPE_ORDER.map((type) => conditional(type, BLOCKS[type])).join("") +
  para("{/sections}") +
  para("{/items}");

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${BODY}
<w:sectPr>
<w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>
</w:sectPr>
</w:body>
</w:document>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Default Extension="jpg" ContentType="image/jpeg"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`;

// Assemble the zip parts.
const buildTemplate = () => {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("word/document.xml", DOCUMENT_XML);
  zip.file("word/_rels/document.xml.rels", DOC_RELS);
  zip.file("word/styles.xml", STYLES);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
};

/* ---------- self-check ---------- */

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// Fill the template with a payload and return word/document.xml.
// renderAsync mirrors production, where getImage is async.
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
    modules: [imageModule],
  });
  await doc.renderAsync(data);
  return doc.getZip().files["word/document.xml"].asText();
};

const flags = (on: string) =>
  Object.fromEntries(TYPE_ORDER.map((type) => [`is${type}`, type === on]));

// One representative row per type, keys matching the template tags.
const ROW_FOR: Record<string, Record<string, string>> = {
  GVI: { kp_range: "KP1", depth_el: "1.5", gvi_cp: "2", gvi_ut: "3", condition: "GOOD", remarks: "gvi-remark", recorded: "2026-10-09" },
  CP: { anode_type: "AL", voltage_mv: "900", depletion: "20", anode_width: "1", anode_height: "2", anode_length: "3", widest_pit: "4", deepest_pit: "5", remarks: "cp-remark", recorded: "2026-10-09" },
  FMD: { depth_el: "1.5", initial_attempt: "PASS", additional_attempt_1: "PASS", additional_attempt_2: "FAIL", additional_attempt_3: "PASS", remarks: "fmd-remark", recorded: "2026-10-09" },
  SCOUR: { exposed_pile: "YES", exposed_pile_height: "0.5", height_leg1: "1", height_midpoint: "2", height_leg2: "3", remarks: "scour-remark", recorded: "2026-10-09" },
  CVI: { datum_reference: "D1", member_type: "LEG", cp_potential_mv: "-800", clock_position: "12:00", ut_mm: "9.5", findings: "cvi-finding" },
  DVI: { datum_reference: "D2", member_type: "BRACE", cp_potential_mv: "-810", clock_position: "3:00", ut_mm: "9.6", findings: "dvi-finding" },
  MGI: { no_mg_observed: "0", criteria_preset: "DNV", growth_type: "HARD", species: "Barnacle", coverage_percent: "40", thickness_mm: "12", remarks: "mgi-remark" },
  BSI: { clamp_type: "C1", depth_el: "2", clamp_bolt_nut_quantity: "8", outboard_clamp_cp: "1", cp_anomaly_recommendation: "none", hinge_pin: "YES", hinge_bolt_nut_quantity: "4", liners: "NO", inboard_gap_condition: "OK", inboard_estimate_gap: "1", inboard_alignment_condition: "OK", inboard_misaligned_position: "na", inboard_anomaly_recommendation: "inb-rec", outboard_gap_condition: "OK", outboard_estimate_gap: "2", outboard_alignment_condition: "OK", outboard_misaligned_position: "na", outboard_anomaly_recommendation: "outb-rec", clamp_missing_bolts: "1,2", clamp_missing_washers: "3", hinge_missing_bolts: "", hinge_missing_washers: "", remarks: "bsi-remark", recorded: "2026-10-09" },
};

const section = (on: string) => ({
  inspection_type: on,
  image: "none",
  ...flags(on),
  rows: [ROW_FOR[on]],
});

const base = {
  project_title: "Bridge A",
  project_id: 1,
  document_id: "DOC-1",
  generated_at: "2026-10-09",
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

// Tables in a fully rendered document: item header (2) plus two rows per
// type block, BSI contributing four blocks.
const EXPECTED_ROWS = 2 + 2 * (TYPE_ORDER.length - 1) + 8;

// Run the checks, then write the file.
const main = async () => {
  const template = buildTemplate();

  const full = await renderWith(template, fullPayload);
  if (Bun.env.DUMP) await Bun.write("/tmp/rendered.xml", full);
  for (const type of TYPE_ORDER) {
    assert.ok(full.includes(`${type} Results`), `missing ${type} block`);
  }
  for (const marker of ["KP1", "cp-remark", "fmd-remark", "scour-remark", "cvi-finding", "dvi-finding", "Barnacle", "outb-rec"]) {
    assert.ok(full.includes(marker), `missing value ${marker}`);
  }
  assert.equal((full.match(/<w:tr>/g) ?? []).length, EXPECTED_ROWS, "unexpected row count");
  assert.equal((full.match(/<w:drawing>/g) ?? []).length, TYPE_ORDER.length, "wrong image count");
  assert.ok(!full.includes("{/"), "closing tag left in output");
  assert.ok(!/\{[#/%]/.test(full), "template tag left in output");

  const single = await renderWith(template, singlePayload);
  assert.ok(single.includes("MGI Results"), "MGI block dropped");
  for (const type of TYPE_ORDER.filter((t) => t !== "MGI")) {
    assert.ok(!single.includes(`${type} Results`), `${type} block not dropped`);
  }

  const multi = await renderWith(template, multiRowPayload);
  assert.equal((multi.match(/<w:tr>/g) ?? []).length, 6, "GVI row loop did not repeat");

  await Bun.write(OUT_PATH, template);
  console.log(`checks passed > wrote ${OUT_PATH.pathname} (${template.length} bytes)`);
};

await main();
