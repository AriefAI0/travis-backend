// Clips for the "+ Images and clips" level: one merged .mkv per clip, plus its
// poster still.
//
// Merges run one at a time, because each one drives ffmpeg. A clip that failed
// still gets a Media row saying so, and the export ends ready_with_errors.
// flow: clip rows > merge (sequential) > poster still > zip entries

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { env } from "../../config/env";
import { runFfmpegBounded } from "../../lib/ffmpeg";
import { log } from "../../lib/logger";
import { minio } from "../../lib/minio_storage/clients";
import { listVideoClipRecordsByResultIds } from "../../db/repositories/video-clip.repository";
import { mergeClip, type RemuxResult } from "../recording/jobs/remux";
import type { MediaRow, MediaThumb } from "./package";

const THUMBNAIL_BOX = 160;
const POSTER_TIMEOUT_MS = 30_000;

export type ClipFile = {
  resultId: number;
  clipId: number;
  // zip entry name
  name: string;
  // the merged file on disk
  file: string;
  status: RemuxResult["status"];
  error: string | null;
};

export type ClipPlan = {
  files: ClipFile[];
  thumbs: Map<number, MediaThumb>;
  rows: MediaRow[];
  errors: string[];
};

// One poster still, scaled like every other thumbnail.
const makePoster = async (key: string, target: string, signal?: AbortSignal) => {
  const stream = await minio.getObject(env.BUCKET_MEDIA, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const source = `${target}.src`;
  await Bun.write(source, Buffer.concat(chunks));

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
    POSTER_TIMEOUT_MS,
    { signal },
  );
};

// flow: clip rows > merge in order > poster > entries and media rows
export const collectClips = async (
  resultTypes: { resultId: number; type: string }[],
  scratchDirectory: string,
  signal?: AbortSignal,
): Promise<ClipPlan> => {
  const files: ClipFile[] = [];
  const thumbs = new Map<number, MediaThumb>();
  const rows: MediaRow[] = [];
  const errors: string[] = [];

  const clips = await listVideoClipRecordsByResultIds(resultTypes.map((entry) => entry.resultId));
  if (clips.length === 0) return { files, thumbs, rows, errors };

  const typeOf = new Map(resultTypes.map((entry) => [entry.resultId, entry.type]));
  await mkdir(scratchDirectory, { recursive: true });

  // sequential on purpose: one merge at a time inside the clips lane
  for (const clip of clips) {
    if (signal?.aborted) break;

    const type = typeOf.get(clip.resultId) ?? "UNKNOWN";
    const name = `clips/${type}/${clip.resultId}_${clip.clipId}.mkv`;

    const merged = await mergeClip(clip.clipId, scratchDirectory, { signal });
    const ok = (merged.status === "ok" || merged.status === "partial") && merged.localFile !== null;

    rows.push({
      resultId: clip.resultId,
      type,
      kind: "clip",
      file: name,
      status: merged.status,
    });

    if (!ok) {
      if (merged.error) errors.push(`result ${clip.resultId} clip ${clip.clipId}: ${merged.error}`);
      continue;
    }

    files.push({
      resultId: clip.resultId,
      clipId: clip.clipId,
      name,
      file: merged.localFile!,
      status: merged.status,
      error: merged.error,
    });

    // the poster is a review aid; a missing one costs the thumbnail, not the clip
    if (clip.thumbnailKey) {
      const poster = path.join(scratchDirectory, `clip-${clip.clipId}.poster.jpg`);
      try {
        await makePoster(clip.thumbnailKey, poster, signal);
        thumbs.set(clip.resultId, { thumbnail: poster, target: name });
      } catch (error) {
        log.warn("clip poster failed", { clipId: clip.clipId, err: String(error) });
      }
    }
  }

  return { files, thumbs, rows, errors };
};
