import { createRequire } from "node:module";
import type { DbOrTx } from "../../db/client";
import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { log } from "../../lib/logger";
import { minio } from "../../lib/minio_storage/clients";
import {
  gatherReportData,
  type ReportItem,
  type ReportSection,
  type ReportTemplateData,
} from "../../db/services/report-data.service";
import { sectionRegionTags } from "./report-layout";

// All three ship CommonJS only, so one require form covers them. The image
// module must be required by its installed name: the older
// `open-docxtemplater-image-module` it was forked from is not in the tree.
const require = createRequire(import.meta.url);
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const ImageModule = require("docxtemplater-image-module-free");

// The box one picture fits inside, in pixels: the module sizes in pixels and
// takes no other unit. A smaller picture keeps its own size.
const MAX_WIDTH_PX = 480;
const MAX_HEIGHT_PX = 360;

// Candidates per section: the evidence image, then the clip still.
const MAX_CANDIDATES = 2;

// One picture, ready for the page.
type ReportPicture = { data: Buffer; width: number; height: number };

// What the template reads for a section's picture.
type RenderSection = Omit<ReportSection, "image_keys"> & {
  image: string | null;
  has_image: boolean;
};

type RenderData = Omit<ReportTemplateData, "items"> & {
  items: (Omit<ReportItem, "sections"> & { sections: RenderSection[] })[];
};

// Object key of a project's uploaded template.
export const reportTemplateKey = (projectId: number) => `reports/templates/${projectId}.docx`;

// Drain a MinIO object stream into one Buffer.
const drainStream = async (stream: AsyncIterable<Buffer | Uint8Array>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

// The project's uploaded template, else the bundled default.
// flow: try MinIO > on any miss read the bundled file
export const loadTemplate = async (projectId: number): Promise<Buffer> => {
  try {
    const stream = await minio.getObject(env.BUCKET_MEDIA, reportTemplateKey(projectId));
    return await drainStream(stream);
  } catch {
    const bundled = Bun.file(new URL("./default-template.docx", import.meta.url));
    return Buffer.from(await bundled.arrayBuffer());
  }
};

// Read one picture and fit it to the box, keeping its shape.
//
// Every picture is encoded back to PNG on purpose: the image module names each
// part `image_generated_N.png` and declares `image/png` whatever the bytes are,
// so a JPEG or WebP still would arrive mislabelled. Evidence comes from the
// app as PNG, JPEG or WebP.
//
// A miss returns null, and the caller tries the section's next candidate.
// flow: object > decode > scale to fit > PNG
const loadPicture = async (objectKey: string): Promise<ReportPicture | null> => {
  try {
    const bytes = await drainStream(await minio.getObject(env.BUCKET_MEDIA, objectKey));
    const meta = await new Bun.Image(bytes).metadata();

    // never enlarge: a 320-wide still stays 320 wide
    const scale = Math.min(MAX_WIDTH_PX / meta.width, MAX_HEIGHT_PX / meta.height, 1);
    const width = Math.max(1, Math.round(meta.width * scale));
    const height = Math.max(1, Math.round(meta.height * scale));

    return { data: await new Bun.Image(bytes).resize(width, height).png().toBuffer(), width, height };
  } catch (err) {
    log.warn("report picture unavailable", { objectKey, err: String(err) });
    return null;
  }
};

// Pair every section with the first candidate picture that loads.
//
// One batch per candidate position, so a section whose own evidence image is
// there costs a single read, and the clip still is only fetched when that
// misses.
// flow: first candidates in parallel > misses try their next
const resolvePictures = async (sections: ReportSection[]) => {
  const pictures = new Map<string, ReportPicture>();
  const chosen = new Map<ReportSection, string | null>();

  for (let depth = 0; depth < MAX_CANDIDATES; depth++) {
    const pending = sections.filter(
      (section) => !chosen.has(section) && section.image_keys.length > depth,
    );
    if (pending.length === 0) break;

    const keys = [
      ...new Set(pending.map((section) => section.image_keys[depth]!).filter((key) => !pictures.has(key))),
    ];
    const loaded = await Promise.all(
      keys.map(async (key) => [key, await loadPicture(key)] as const),
    );
    for (const [key, picture] of loaded) {
      if (picture) pictures.set(key, picture);
    }

    for (const section of pending) {
      const key = section.image_keys[depth]!;
      if (pictures.has(key)) chosen.set(section, key);
    }
  }

  for (const section of sections) {
    if (!chosen.has(section)) chosen.set(section, null);
  }

  return { pictures, chosen };
};

// Pull docxtemplater's real error list out of its wrapper error. Its
// `explanation` names the exact tag, which is what a user needs to fix the
// template; `message` alone says only "Unclosed loop".
const describeTemplateError = (err: unknown): string => {
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
const keepMissingPlaceholder = (part: { value?: string }) =>
  part?.value ? `{${part.value}}` : "";

// The template writes this constant for every region, and the renderer replaces
// each with the tag of the section it holds.
const REGION_TAG = /<w:tag w:val="region"\/>/g;

// A region tag is data, but it lands in an XML attribute.
const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// Name each rendered region after the section it holds.
//
// The template cannot carry the tag itself: docxtemplater substitutes inside
// `<w:t>` text runs only, and a raw-XML tag needs a `<w:p>`, so no form reaches
// a `w:sdtPr` attribute. The template writes the placeholder `region` instead,
// and this assigns the real tag in document order, which is the order the
// sections rendered. A count that differs means a tag would land on the wrong
// region, so it fails the render rather than writing a document a refresh would
// then rewrite in the wrong place.
// flow: count placeholders > match against sections > replace in order
const tagRegions = (xml: string, regions: string[]): string => {
  const found = (xml.match(REGION_TAG) ?? []).length;
  if (found !== regions.length) {
    throw new AppError(
      500,
      "region_mismatch",
      `${found} regions rendered for ${regions.length} sections`,
    );
  }

  let index = 0;
  return xml.replace(REGION_TAG, () => {
    const tag = escapeAttribute(regions[index++]!);
    return `<w:tag w:val="${tag}"/>`;
  });
};

// docxtemplater cannot see a content control, so a table that closes a region
// looks to it like a table ending a block, and its `joinUncorrupt` step inserts
// a paragraph behind it — inside the region, where the next refresh would
// overwrite whatever a user typed. The gap belongs outside the region, and
// `regionBlock` already puts one there.
// flow: drop the inserted paragraph > the region ends with its table
const dropInsertedGaps = (xml: string): string =>
  xml.replace(/<\/w:tbl><w:p\/><\/w:sdtContent>/g, "</w:tbl></w:sdtContent>");

// The image module stamps every drawing with the same id. OOXML wants one id
// per drawing, and Word repairs a document that repeats them.
const renumberDrawingIds = (xml: string): string => {
  let next = 1;
  return xml
    .replace(/<wp:docPr id="\d+"/g, () => `<wp:docPr id="${next++}"`)
    .replace(/<pic:cNvPr id="\d+"/g, () => `<pic:cNvPr id="${next++}"`);
};


// Fill a template with gathered data and return the finished .docx.
// flow: load pictures > wire image module > render > renumber drawings
export const renderReport = async (
  template: Buffer,
  data: ReportTemplateData,
): Promise<Buffer> => {
  const sections = data.items.flatMap((item) => item.sections);
  const { pictures, chosen } = await resolvePictures(sections);

  // the template reads `image` and `has_image`, not the candidate list
  const filled: RenderData = {
    ...data,
    items: data.items.map((item) => ({
      ...item,
      sections: item.sections.map((section): RenderSection => {
        const { image_keys, ...rest } = section;
        const image = chosen.get(section) ?? null;
        return { ...rest, image, has_image: image !== null };
      }),
    })),
  };

  const imageModule = new ImageModule({
    centered: false,
    fileType: "docx",
    // async to match what the module resolves under renderAsync; the map is
    // already in memory, so this never touches the network
    getImage: async (key: string) => {
      const picture = pictures.get(key);
      if (!picture) {
        // unreachable: a tag only renders when resolvePictures chose a key
        throw new Error(`no picture loaded for ${key}`);
      }
      return picture.data;
    },
    // the module hands the tag value back, which is the object key
    getSize: (_image: Buffer, key: string) => {
      const picture = pictures.get(key);
      return picture ? [picture.width, picture.height] : [1, 1];
    },
  });

  // The constructor is inside the try because docxtemplater pairs its block tags
  // when it is built, not when it renders: an unclosed `{#x}` throws there, and
  // a raw throw would reach the client as a bare 500 with no reason in it.
  let doc: any;
  try {
    doc = new Docxtemplater(new PizZip(template), {
      paragraphLoop: true,
      linebreaks: true,
      // a tag the data never fills stays visible, never "undefined"
      nullGetter: keepMissingPlaceholder,
      // the v4 constructor takes modules here; attachModule() throws on it
      modules: [imageModule],
    });

    // renderAsync, not render: the image module resolves tag values through a
    // promise path, and the sync one hands a promise straight to PizZip.
    await doc.renderAsync(filled);
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
    // one tag per picture and per table, in the order the template renders them
    const regions = sections.flatMap((section) => sectionRegionTags(section));
    const named = tagRegions(page.asText() as string, regions);
    zip.file("word/document.xml", renumberDrawingIds(dropInsertedGaps(named)));
  }

  return zip.generate({ type: "nodebuffer" }) as Buffer;
};

// A project's template and data. Both report paths start here, so the template
// lookup and its bundled fallback stay in one place.
export const loadReportInputs = async (projectId: number, database?: DbOrTx) => {
  const [template, data] = await Promise.all([
    loadTemplate(projectId),
    gatherReportData(projectId, database),
  ]);

  return { template, data };
};

// Render a project's report in this process.
export const generateReport = async (
  projectId: number,
  database?: DbOrTx,
): Promise<Buffer> => {
  const { template, data } = await loadReportInputs(projectId, database);
  return renderReport(template, data);
};
