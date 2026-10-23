// Result images for the "+ Images" level: fetch both copies, scale one
// thumbnail, and name everything the way the zip ships it.
//
// Four fetches run at a time and one ffmpeg at a time, so a lane never floods
// MinIO or the CPU. A missing object becomes an error row, never a silent gap.
// flow: result ids > image summaries > 4-wide fetch > 160 px jpeg > names

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { env } from "../../config/env";
import { runFfmpegBounded } from "../../lib/ffmpeg";
import { log } from "../../lib/logger";
import { minio } from "../../lib/minio_storage/clients";
import { imageEvidenceLeaves } from "../../lib/minio_storage/paths";
import { listResultImageSummariesByResultIds } from "../../db/services/result-media.service";
import type { MediaRow } from "./workbook";

// Fetches in flight per lane. Four keeps one lane busy without swamping MinIO.
const FETCH_CONCURRENCY = 4;
const FETCH_ATTEMPTS = 3;

// One ffmpeg per lane: the caller runs collectImages once at a time.
const THUMBNAIL_BOX = 160;
const THUMBNAIL_TIMEOUT_MS = 30_000;

export type ImageFile = {
  resultId: number;
  type: string;
  index: number;
  // the file the cell links to: the annotated copy when it exists
  target: string;
  thumbnail: string;
  raw: { key: string; name: string; file: string };
  annotated: { key: string; name: string; file: string } | null;
};

export type ImagePlan = {
  files: ImageFile[];
  rows: MediaRow[];
  errors: string[];
};

const attempt = async <T>(work: () => Promise<T>, attempts = FETCH_ATTEMPTS): Promise<T> => {
  let lastError: unknown;
  for (let index = 0; index < attempts; index++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      // a missing object will not appear on a retry
      const code = (error as { code?: string }).code;
      if (code === "NoSuchKey" || code === "NotFound") break;
      await Bun.sleep(250 * (index + 1));
    }
  }
  throw lastError;
};

// One object to disk, four at a time across the caller's item list.
const mapLimit = async <T>(items: T[], limit: number, work: (item: T) => Promise<void>) => {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await work(item);
    }
  });
  await Promise.all(runners);
};

const download = async (key: string, destination: string) => {
  await attempt(async () => {
    const stream = await minio.getObject(env.BUCKET_MEDIA, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    await Bun.write(destination, Buffer.concat(chunks));
  });
};

// One ffmpeg per image: scale inside a 160 px box, JPEG out. webp lands here too
// because Excel reads a JPEG and refuses a webp drawing part.
const makeThumbnail = async (source: string, target: string, signal?: AbortSignal) => {
  await runFfmpegBounded(
    env.FFMPEG_PATH,
    [
      "-y", "-v", "error",
      "-i", source,
      "-vf", `scale=${THUMBNAIL_BOX}:${THUMBNAIL_BOX}:force_original_aspect_ratio=decrease`,
      "-frames:v", "1",
      "-f", "image2",
      target,
    ],
    THUMBNAIL_TIMEOUT_MS,
    { signal },
  );
};

// flow: summaries > plan files > fetch copies > thumbnails > media rows
export const collectImages = async (
  resultTypes: { resultId: number; type: string }[],
  scratchDirectory: string,
  signal?: AbortSignal,
): Promise<ImagePlan> => {
  const files: ImageFile[] = [];
  const errors: string[] = [];

  if (resultTypes.length === 0) return { files, rows: [], errors };

  const summaries = await listResultImageSummariesByResultIds(
    resultTypes.map((entry) => entry.resultId),
  );

  // plan first, so a naming clash shows before any byte moves
  for (const { resultId, type } of resultTypes) {
    const images = summaries.get(resultId) ?? [];
    images.forEach((image, index) => {
      const leaves = imageEvidenceLeaves(image.storageStem, image.imageId, image.contentType);
      const ext = leaves.raw.key.split(".").pop() ?? "png";
      const stem = `images/${type}/${resultId}_${index + 1}`;

      files.push({
        resultId,
        type,
        index: index + 1,
        target: `${stem}${image.hasAnnotated ? "_annotated" : ""}.${ext}`,
        thumbnail: path.join(scratchDirectory, `${type}-${resultId}-${index + 1}.thumb.jpg`),
        raw: { key: leaves.raw.key, name: `${stem}.${ext}`, file: path.join(scratchDirectory, `${type}-${resultId}-${index + 1}.${ext}`) },
        annotated: image.hasAnnotated
          ? {
              key: leaves.annotated.key,
              name: `${stem}_annotated.${ext}`,
              file: path.join(scratchDirectory, `${type}-${resultId}-${index + 1}.annotated.${ext}`),
            }
          : null,
      });
    });
  }

  await mkdir(scratchDirectory, { recursive: true });

  // a failed file is dropped by index, so one bad image never hides its result
  const failed = new Set<number>();

  await mapLimit(
    files.map((file, index) => ({ file, index })),
    FETCH_CONCURRENCY,
    async ({ file, index }) => {
      try {
        // the annotated twin first: it is what the inspector signed off on.
        // An upload that landed empty or unreadable falls back to the raw copy
        // rather than costing the row its picture.
        let thumbed = false;
        if (file.annotated) {
          try {
            await download(file.annotated.key, file.annotated.file);
            await makeThumbnail(file.annotated.file, file.thumbnail, signal);
            thumbed = true;
          } catch {
            log.warn("excel export annotated copy unusable", {
              resultId: file.resultId,
              index: file.index,
            });
          }
        }

        if (!thumbed) {
          await download(file.raw.key, file.raw.file);
          await makeThumbnail(file.raw.file, file.thumbnail, signal);
          // the cell links to what actually shipped
          file.target = file.raw.name;
          file.annotated = null;
          return;
        }

        // both copies ship, so the raw half is fetched either way
        await download(file.raw.key, file.raw.file);
      } catch (error) {
        failed.add(index);
        errors.push(`result ${file.resultId} image ${file.index}: ${String(error)}`);
        log.warn("excel export image failed", { resultId: file.resultId, index: file.index });
      }
    },
  );

  const kept = files.filter((_, index) => !failed.has(index));

  const rows: MediaRow[] = kept.flatMap((file) => {
    const main: MediaRow = {
      resultId: file.resultId,
      type: file.type,
      kind: "image",
      file: file.raw.name,
      status: "ok",
    };
    return file.annotated
      ? [main, { ...main, file: file.annotated.name }]
      : [main];
  });

  return { files: kept, rows, errors };
};
