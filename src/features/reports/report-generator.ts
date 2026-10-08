import { createRequire } from "node:module";
import type { DbOrTx } from "../../db/client";
import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { minio } from "../../lib/minio_storage/clients";
import { gatherReportData } from "./report-data";

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
const loadTemplate = async (projectId: number): Promise<Buffer> => {
  try {
    const stream = await minio.getObject(env.BUCKET_MEDIA, reportTemplateKey(projectId));
    return await drainStream(stream);
  } catch {
    const bundled = Bun.file(new URL("./default-template.docx", import.meta.url));
    return Buffer.from(await bundled.arrayBuffer());
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

// Pull docxtemplater's real error list out of its wrapper error.
const describeTemplateError = (err: unknown): string => {
  const errors = (err as { properties?: { errors?: { message?: string }[] } }).properties?.errors;
  if (errors?.length) {
    return errors.map((entry) => entry.message ?? String(entry)).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
};

// Fill a project's report template and return the finished .docx.
// flow: load template + data > wire image module > render > zip bytes
export const generateReport = async (
  projectId: number,
  database?: DbOrTx,
): Promise<Buffer> => {
  const [template, data] = await Promise.all([
    loadTemplate(projectId),
    gatherReportData(projectId, database),
  ]);

  const imageModule = new ImageModule({
    centered: false,
    fileType: "docx",
    getImage: loadImage,
    getSize: () => [IMAGE_SIZE_PX, IMAGE_HEIGHT_PX],
  });

  const doc = new Docxtemplater(new PizZip(template), {
    paragraphLoop: true,
    linebreaks: true,
    // the v4 constructor takes modules here; attachModule() throws on it
    modules: [imageModule],
  });

  try {
    // renderAsync, not render: getImage reads MinIO and returns a promise,
    // and the sync path would hand that promise straight to PizZip.
    await doc.renderAsync(data);
  } catch (err) {
    throw new AppError(500, "template_error", describeTemplateError(err));
  }

  return doc.getZip().generate({ type: "nodebuffer" }) as Buffer;
};
