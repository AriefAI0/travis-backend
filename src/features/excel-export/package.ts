// Stream a STORE zip into MinIO without holding it in memory.
//
// Entries go in the order the reader needs them: the README first, media next,
// the workbook last. Nothing is compressed — images and video are already
// compressed, and STORE keeps the zip buildable at a flat memory cost.
// flow: entries > yazl stream > counted > putObject (multipart, partSize)

import { Readable, Transform } from "node:stream";

import yazl from "yazl";

import { env } from "../../config/env";
import { buildMinioClient } from "../../lib/minio_storage/clients";

// Measured on 200 MiB of entries: 16 MiB parts peak at 33 MiB of RSS growth,
// 64 MiB parts at 185 MiB. minio-js buffers a part plus its copies.
const UPLOAD_PART_SIZE = 16 * 1024 * 1024;

// The packager's own client; the shared one stays as it is.
const packager = () => buildMinioClient(env.MINIO_ENDPOINT, env.MINIO_ACCESS_KEY, env.MINIO_SECRET_KEY, UPLOAD_PART_SIZE);

export type PackageEntry = {
  // path inside the zip
  name: string;
  // produced on demand, so the zip can stream one entry at a time
  open: () => Readable;
};

export type PackageResult = { bytes: number; key: string };

// One file the export carried: a line the README can report.
export type MediaRow = {
  resultId: number;
  type: string;
  kind: "image" | "clip";
  file: string;
  status: string;
};

// A still for a clip, and the zip-relative file it shows.
export type MediaThumb = { thumbnail: string; target: string };

// A file built in memory, such as one type's workbook.
export const bufferEntry = (name: string, body: Buffer): PackageEntry => ({
  name,
  open: () => Readable.from([body]),
});

// A plain-text entry, written straight into the zip.
export const textEntry = (name: string, body: string): PackageEntry => ({
  name,
  open: () => Readable.from([Buffer.from(body, "utf8")]),
});

// A file on disk as a zip entry that never loads whole.
export const fileEntry = (name: string, path: string): PackageEntry => ({
  name,
  open: () => Readable.from(Bun.file(path).stream()),
});

// flow: zip file > add each entry as a stream > upload > count the bytes
export const writePackage = async (
  key: string,
  entries: PackageEntry[],
  options: { signal?: AbortSignal; partSize?: number } = {},
): Promise<PackageResult> => {
  const zip = new yazl.ZipFile();
  let bytes = 0;

  for (const entry of entries) {
    // the production call shape: a stream, no size, stored as is
    zip.addReadStream(entry.open(), entry.name, { compress: false });
  }
  zip.end();

  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(null, chunk);
    },
  });

  // neither stream may surface an unhandled 'error' event
  zip.outputStream.on("error", () => {});
  counted.on("error", () => {});

  const abortReason = () => Object.assign(new Error("package aborted"), { name: "AbortError" });
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });

  const client = options.partSize
    ? buildMinioClient(env.MINIO_ENDPOINT, env.MINIO_ACCESS_KEY, env.MINIO_SECRET_KEY, options.partSize)
    : packager();

  // flow: abort > stop the source > let the upload settle > remove every trace
  // Ending the stream is what minio-js understands: a destroyed one leaves its
  // part reader waiting forever.
  const onAbort = () => {
    const source = zip.outputStream as unknown as Readable;
    source.unpipe(counted);
    source.destroy();
    counted.end();
    rejectAbort(abortReason());
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort);

  const upload = client.putObject(env.BUCKET_MEDIA, key, zip.outputStream.pipe(counted), undefined, {
    "Content-Type": "application/zip",
  });

  try {
    await Promise.race([upload, aborted]);
    return { bytes, key };
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      // the truncated upload still settles; remove after it, never before
      await upload.catch(() => {});
      await client.removeObject(env.BUCKET_MEDIA, key).catch(() => {});
    }
    // an aborted upload leaves parts behind; they are never resumable here
    await client.removeIncompleteUpload(env.BUCKET_MEDIA, key).catch(() => {});
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
};

// The note that ships inside every zip, before any media.
export const readmeEntry = (lines: string[]): PackageEntry =>
  textEntry("README.txt", `${lines.join("\n")}\n`);
