import { createRequire } from "node:module";
import type { DbOrTx } from "../../db/client";
import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { minio } from "../../lib/minio_storage/clients";
import {
  gatherReportData,
  NO_IMAGE,
  type ReportTemplateData,
} from "../../db/services/report.service";

// All three ship CommonJS only, so one require form covers them. The image
// module must be required by its installed name: the older
// `open-docxtemplater-image-module` it was forked from is not in the tree.
const require = createRequire(import.meta.url);
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const ImageModule = require("docxtemplater-image-module-free");

// 1x1 transparent PNG. A result with no image still gets a valid picture, so
// the image module never throws on an empty tag value.
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// Fixed cell size in pixels; the module takes no other unit.
const IMAGE_SIZE_PX = 200;
const IMAGE_HEIGHT_PX = 150;

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

// Whether the project has its own uploaded template, and when it was stored.
// flow: stat the key > any miss = bundled default in play
export const templateStatus = async (projectId: number) => {
  try {
    const stat = await minio.statObject(env.BUCKET_MEDIA, reportTemplateKey(projectId));
    return { custom: true, updatedAt: stat.lastModified?.toISOString() ?? null };
  } catch {
    return { custom: false, updatedAt: null };
  }
};

// One evidence image by object key. A miss is not fatal: a report with one
// blank picture beats no report at all.
const loadImage = async (objectKey: string): Promise<Buffer> => {
  if (!objectKey) {
    return TRANSPARENT_PNG;
  }

  try {
    const stream = await minio.getObject(env.BUCKET_MEDIA, objectKey);
    return await drainStream(stream);
  } catch {
    return TRANSPARENT_PNG;
  }
};

// Every distinct image key the template will ask for.
const collectImageKeys = (data: ReportTemplateData) => {
  const keys = new Set<string>();
  for (const item of data.items) {
    for (const section of item.sections) {
      // the sentinel is not a real object and never gets fetched
      if (section.image && section.image !== NO_IMAGE) keys.add(section.image);
    }
  }
  return keys;
};

// Fetch every image once, in parallel, so rendering never waits on MinIO.
// flow: keys > parallel gets > key map
const prefetchImages = async (keys: Iterable<string>) => {
  const entries = await Promise.all(
    [...keys].map(async (key) => [key, await loadImage(key)] as const),
  );
  return new Map(entries);
};

// Pull docxtemplater's real error list out of its wrapper error.
const describeTemplateError = (err: unknown): string => {
  const errors = (err as { properties?: { errors?: { message?: string }[] } }).properties?.errors;
  if (errors?.length) {
    return errors.map((entry) => entry.message ?? String(entry)).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
};

// Fill a template with gathered data and return the finished .docx.
// flow: prefetch images > wire image module > render
export const renderReport = async (
  template: Buffer,
  data: ReportTemplateData,
): Promise<Buffer> => {
  // one parallel MinIO batch replaces a round-trip per image tag
  const imageMap = await prefetchImages(collectImageKeys(data));

  const imageModule = new ImageModule({
    centered: false,
    fileType: "docx",
    // async to match what the module resolves under renderAsync; the map is
    // already in memory, so this never touches the network
    getImage: async (key: string) => imageMap.get(key) ?? TRANSPARENT_PNG,
    getSize: () => [IMAGE_SIZE_PX, IMAGE_HEIGHT_PX],
  });

  const doc = new Docxtemplater(new PizZip(template), {
    paragraphLoop: true,
    linebreaks: true,
    // the v4 constructor takes modules here; attachModule() throws on it
    modules: [imageModule],
  });

  try {
    // renderAsync, not render: the image module resolves tag values through a
    // promise path, and the sync one hands a promise straight to PizZip.
    await doc.renderAsync(data);
  } catch (err) {
    throw new AppError(500, "template_error", describeTemplateError(err));
  }

  return doc.getZip().generate({ type: "nodebuffer" }) as Buffer;
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
