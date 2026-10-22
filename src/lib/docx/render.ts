// The one docxtemplater wiring both report paths share.
// flow: template + data > render > optional xml edit > zip
import { createRequire } from "node:module";
import { AppError } from "../error";

// Both ship CommonJS only, so one require form covers them.
const require = createRequire(import.meta.url);
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

// Pull docxtemplater's real error list out of its wrapper error. Its
// `explanation` names the exact tag, which is what a user needs to fix the
// template; `message` alone says only "Unclosed loop".
export const describeTemplateError = (err: unknown): string => {
  const errors = (
    err as {
      properties?: {
        errors?: { message?: string; properties?: { explanation?: string } }[];
      };
    }
  ).properties?.errors;
  if (errors?.length) {
    return errors
      .map((entry) => entry.properties?.explanation ?? entry.message ?? String(entry))
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
};

// A value the data never supplies keeps its placeholder in the page, so a user
// who opens the report sees which one is missing and can fix the template.
// docxtemplater's own fallback writes the word "undefined" there instead, which
// reads as a rendering fault rather than a gap in the template.
//
// A block tag is a different matter: `{#x}` with no `{/x}` cannot produce a
// document at all, so that still fails the render.
export const keepMissingPlaceholder = (part: { value?: string }) =>
  part?.value ? `{${part.value}}` : "";

// A datasheet is finished output, not an editable draft: a missing value reads
// as an empty cell.
export const blankMissingValue = () => "";

// docxtemplater cannot see a content control, so a table that closes a region
// looks to it like a table ending a block, and its `joinUncorrupt` step inserts
// a paragraph behind it — inside the region, where the next refresh would
// overwrite whatever a user typed. The gap belongs outside the region.
// flow: drop the inserted paragraph > the region ends with its table
export const dropInsertedGaps = (xml: string): string =>
  xml.replace(/<\/w:tbl><w:p\/><\/w:sdtContent>/g, "</w:tbl></w:sdtContent>");

// The image module stamps every drawing with the same id, and a row loop clones
// the drawing it repeats. OOXML wants one id per drawing, and Word repairs a
// document that repeats them.
export const renumberDrawingIds = (xml: string): string => {
  let next = 1;
  return xml
    .replace(/<wp:docPr id="\d+"/g, () => `<wp:docPr id="${next++}"`)
    .replace(/<pic:cNvPr id="\d+"/g, () => `<pic:cNvPr id="${next++}"`);
};

export type RenderTemplateOptions = {
  modules?: unknown[];
  // what a tag with no value renders as
  nullGetter?: (part: { value?: string }) => string;
  // rewrite word/document.xml after the render, before the zip is written
  editDocument?: (xml: string) => string;
};

// Fill a template with data and return the finished .docx.
export const renderTemplate = async (
  template: Buffer,
  data: unknown,
  options: RenderTemplateOptions = {},
): Promise<Buffer> => {
  // The constructor is inside the try because docxtemplater pairs its block tags
  // when it is built, not when it renders: an unclosed `{#x}` throws there, and
  // a raw throw would reach the client as a bare 500 with no reason in it.
  let doc: any;
  try {
    doc = new Docxtemplater(new PizZip(template), {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: options.nullGetter ?? keepMissingPlaceholder,
      // the v4 constructor takes modules here; attachModule() throws on it
      modules: options.modules ?? [],
    });

    // renderAsync, not render: the image module resolves tag values through a
    // promise path, and the sync one hands a promise straight to PizZip.
    await doc.renderAsync(data);
  } catch (err) {
    throw new AppError(
      500,
      "template_error",
      `The report template cannot be rendered: ${describeTemplateError(err)}`,
    );
  }

  const zip = doc.getZip();
  const page = zip.file("word/document.xml");
  if (page) {
    const xml = page.asText() as string;
    zip.file("word/document.xml", options.editDocument?.(xml) ?? renumberDrawingIds(xml));
  }

  return zip.generate({ type: "nodebuffer" }) as Buffer;
};
