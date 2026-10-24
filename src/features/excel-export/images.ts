// Result images for the "+ Images" level: fetch both copies and name everything
// the way the zip ships it.
//
// Four fetches run at a time, so a lane never floods MinIO. A missing object
// becomes an error row, never a silent gap.
// flow: result ids > image summaries > 4-wide fetch > named files

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { env } from "../../config/env";
import { log } from "../../lib/logger";
import { minio } from "../../lib/minio_storage/clients";
import { imageEvidenceLeaves } from "../../lib/minio_storage/paths";
import { listResultImageSummariesByResultIds } from "../../db/services/result-media.service";
import type { MediaRow } from "./package";

// Fetches in flight per lane. Four keeps one lane busy without swamping MinIO.
const FETCH_CONCURRENCY = 4;
const FETCH_ATTEMPTS = 3;

export type ImageTarget = { resultId: number; type: string; folder: string };

export type ImageFile = {
  resultId: number;
  type: string;
  index: number;
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

// flow: summaries > plan files > fetch copies > media rows
export const collectImages = async (
  targets: ImageTarget[],
  scratchDirectory: string,
  signal?: AbortSignal,
): Promise<ImagePlan> => {
  const files: ImageFile[] = [];
  const errors: string[] = [];

  if (targets.length === 0) return { files, rows: [], errors };

  const summaries = await listResultImageSummariesByResultIds(
    targets.map((entry) => entry.resultId),
  );

  // plan first, so a naming clash shows before any byte moves
  for (const { resultId, type, folder } of targets) {
    const images = summaries.get(resultId) ?? [];
    images.forEach((image, index) => {
      const leaves = imageEvidenceLeaves(image.storageStem, image.imageId, image.contentType);
      const ext = leaves.raw.key.split(".").pop() ?? "png";
      const n = String(index + 1).padStart(2, "0");
      const stem = `images/${type}/${folder}/${n}`;
      const scratch = `${type}-${resultId}-${n}`;

      files.push({
        resultId,
        type,
        index: index + 1,
        raw: { key: leaves.raw.key, name: `${stem}.${ext}`, file: path.join(scratchDirectory, `${scratch}.${ext}`) },
        annotated: image.hasAnnotated
          ? {
              key: leaves.annotated.key,
              name: `${stem}_annotated.${ext}`,
              file: path.join(scratchDirectory, `${scratch}.annotated.${ext}`),
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
      if (signal?.aborted) return;
      try {
        // the annotated twin first: it is what the inspector signed off on.
        // An upload that landed empty or unreadable falls back to the raw copy
        // rather than costing the row its picture.
        if (file.annotated) {
          try {
            await download(file.annotated.key, file.annotated.file);
            // an upload that landed empty is as unusable as a missing one
            if ((await Bun.file(file.annotated.file).size) === 0) {
              throw new Error("empty annotated copy");
            }
          } catch {
            log.warn("excel export annotated copy unusable", {
              resultId: file.resultId,
              index: file.index,
            });
            file.annotated = null;
          }
        }
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
