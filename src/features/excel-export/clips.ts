// Clips for the "+ Images and clips" level: one merged .mkv per clip.
//
// Merges run one at a time, because each one drives ffmpeg. A clip that failed
// still gets a Media row saying so, and the export ends ready_with_errors.
// flow: clip rows > merge (sequential) > zip entries

import { mkdir } from "node:fs/promises";

import { listVideoClipRecordsByResultIds } from "../../db/repositories/video-clip.repository";
import type { ProgressCallback } from "../../db/services/excel-export-data.service";
import { mergeClip, type RemuxResult } from "../recording/jobs/remux";
import type { MediaRow } from "./package";

export type ClipTarget = { resultId: number; type: string; folder: string };

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
  rows: MediaRow[];
  errors: string[];
};

// flow: clip rows > merge in order > entries and media rows
export const collectClips = async (
  targets: ClipTarget[],
  scratchDirectory: string,
  signal?: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<ClipPlan> => {
  const files: ClipFile[] = [];
  const rows: MediaRow[] = [];
  const errors: string[] = [];

  const clips = await listVideoClipRecordsByResultIds(targets.map((entry) => entry.resultId));
  // every clip counts, merged or failed, so the bar never stalls
  let mergedCount = 0;
  await onProgress?.(0, clips.length);
  if (clips.length === 0) return { files, rows, errors };

  const targetOf = new Map(targets.map((entry) => [entry.resultId, entry]));
  // clip order per result, so a failed merge leaves no name for the next one
  const numbered = new Map<number, number>();
  await mkdir(scratchDirectory, { recursive: true });

  // sequential on purpose: one merge at a time inside the clips lane
  for (const clip of clips) {
    if (signal?.aborted) break;

    const target = targetOf.get(clip.resultId);
    const type = target?.type ?? "UNKNOWN";
    const folder = target?.folder ?? String(clip.resultId);
    const count = (numbered.get(clip.resultId) ?? 0) + 1;
    numbered.set(clip.resultId, count);
    // inside the type's own folder: <TYPE>/clips/<result folder>/NN.mkv
    const name = `${type}/clips/${folder}/${String(count).padStart(2, "0")}.mkv`;

    const merged = await mergeClip(clip.clipId, scratchDirectory, { signal });
    const ok = (merged.status === "ok" || merged.status === "partial") && merged.localFile !== null;

    rows.push({
      resultId: clip.resultId,
      type,
      kind: "clip",
      file: name,
      status: merged.status,
    });

    mergedCount += 1;
    await onProgress?.(mergedCount, clips.length);

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
  }

  return { files, rows, errors };
};
