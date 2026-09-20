// Asynchronous thumbnails for a closed master: one poster frame plus a
// filmstrip. Best effort by construction — the HLS playlist is built from
// segment rows, so a still that never lands changes nothing about playback.
//
// No job row is kept. A closed master with no timeline rows is the whole
// signal, so a run that dies mid-flight simply runs again on the next boot.
// flow: closed master > sealed segments > local stills > dated keys > rows

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { env } from "../../../config/env";
import { log } from "../../../lib/logger";
import { minio } from "../../../lib/minio_storage/clients";
import { filmstripLeaf, posterLeaf } from "../../../lib/minio_storage/paths";
import {
  listMastersNeedingThumbnails,
  loadThumbnailSource,
  recordTimelineThumbnails,
  type TimelineThumbnailInsert,
  type ThumbnailSource,
} from "../../../db/services/recording-thumbnail.service";

// A still is a review aid, not an artifact: small enough to keep many.
const STILL_WIDTH = 320;
const POSTER_WIDTH = 1280;
const POSTER_AT_MS = 1_000;

// Seams the tests replace: where the source comes from, process execution,
// storage reads and writes, and where the rows land.
export type ThumbnailDeps = {
  loadSource: (masterVideoId: number) => Promise<ThumbnailSource | null>;
  runFfmpeg: (command: string, args: string[], timeoutMs: number) => Promise<void>;
  fetchSegment: (objectKey: string, destination: string) => Promise<void>;
  putObject: (key: string, body: Uint8Array) => Promise<void>;
  recordRows: (rows: TimelineThumbnailInsert[]) => Promise<number>;
};

// flow: spawn > collect stderr > kill at the deadline > settle once
export const runFfmpegBounded = (
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      // A hung encoder is killed, never waited on.
      child.kill("SIGKILL");
      settle(new Error(`ffmpeg exceeded ${timeoutMs}ms and was killed`));
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });
    child.on("error", (error) => settle(error));
    child.on("close", (code) =>
      code === 0 ? settle() : settle(new Error(`ffmpeg exited ${code}: ${stderr}`)),
    );
  });

const segmentPath = (directory: string, sequence: number): string =>
  path.join(directory, `segment-${String(sequence).padStart(10, "0")}.ts`);

const stillPath = (directory: string, label: string): string => path.join(directory, `${label}.jpg`);

// One frame per sampled segment, spread across the recording, capped.
export const filmstripSampleIndexes = (
  segmentCount: number,
  maxStills: number,
): number[] => {
  if (segmentCount <= 0 || maxStills <= 0) return [];
  const wanted = Math.min(segmentCount, maxStills);
  if (wanted === segmentCount) return Array.from({ length: segmentCount }, (_, index) => index);
  const step = segmentCount / wanted;
  return Array.from({ length: wanted }, (_, index) => Math.floor(index * step));
};

const defaultDeps: ThumbnailDeps = {
  loadSource: loadThumbnailSource,
  runFfmpeg: runFfmpegBounded,
  fetchSegment: async (objectKey, destination) => {
    const stream = await minio.getObject(env.BUCKET_MEDIA, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    await writeFile(destination, Buffer.concat(chunks));
  },
  putObject: async (key, body) => {
    await minio.putObject(env.BUCKET_MEDIA, key, Buffer.from(body), body.byteLength, {
      "Content-Type": "image/jpeg",
    });
  },
  recordRows: (rows) => recordTimelineThumbnails(rows),
};

// Masters waiting or running. Observability only: the sets are the whole
// state, and no row records it.
export const pendingThumbnailJobs = (): number => queued.size + inFlight.size;

export type ThumbnailJobResult = {
  masterVideoId: number
  posterStored: boolean
  stills: number
  skipped: boolean
}

// flow: source > temp dir > segments > poster + stills > dated keys > rows
export const runThumbnailJob = async (
  masterVideoId: number,
  deps: ThumbnailDeps = defaultDeps,
): Promise<ThumbnailJobResult> => {
  const source = await deps.loadSource(masterVideoId);
  if (!source) {
    return { masterVideoId, posterStored: false, stills: 0, skipped: true };
  }

  const directory = await mkdtemp(path.join(tmpdir(), `travis-thumb-${masterVideoId}-`));
  try {
    // Every run reads exactly the segments it will use: no pass over the
    // whole recording for a still nobody asked for.
    const wanted = filmstripSampleIndexes(source.segments.length, env.THUMBNAIL_MAX_STILLS);
    const used = wanted.map((index) => source.segments[index]!);
    for (const segment of used) {
      await deps.fetchSegment(segment.objectKey, segmentPath(directory, segment.sequence));
    }

    const stored: Array<{ timestampMs: number; body: Uint8Array }> = [];
    for (const index of wanted) {
      const segment = source.segments[index]!;
      const file = stillPath(directory, `still-${segment.sequence}`);
      const offsetMs = source.segments
        .slice(0, index)
        .reduce((total, row) => total + row.durationMs, 0);
      try {
        await deps.runFfmpeg(
          env.FFMPEG_PATH,
          [
            "-y",
            "-i", segmentPath(directory, segment.sequence),
            "-frames:v", "1",
            "-vf", `scale=${STILL_WIDTH}:-2`,
            file,
          ],
          env.FFMPEG_TIMEOUT_MS,
        );
        stored.push({ timestampMs: offsetMs, body: new Uint8Array(await readFile(file)) });
      } catch (error) {
        // One still failing must not cost the others, and must never touch
        // playback: the playlist does not read this table.
        log.warn("thumbnail still failed", {
          masterVideoId,
          sequence: segment.sequence,
          err: String(error).slice(0, 200),
        });
      }
    }

    // The poster reads the first segment: the frame a review card wants.
    let posterStored = false;
    const first = source.segments[0];
    if (first) {
      const posterFile = stillPath(directory, "poster");
      try {
        await deps.runFfmpeg(
          env.FFMPEG_PATH,
          [
            "-y",
            "-ss", String(POSTER_AT_MS / 1000),
            "-i", segmentPath(directory, first.sequence),
            "-frames:v", "1",
            "-vf", `scale=${POSTER_WIDTH}:-2`,
            posterFile,
          ],
          env.FFMPEG_TIMEOUT_MS,
        );
        const leaf = posterLeaf(source.scope, masterVideoId);
        await deps.putObject(leaf.key, new Uint8Array(await readFile(posterFile)));
        posterStored = true;
      } catch (error) {
        log.warn("poster frame failed", { masterVideoId, err: String(error).slice(0, 200) });
      }
    }

    for (const still of stored) {
      const leaf = filmstripLeaf(source.scope, masterVideoId, still.timestampMs);
      await deps.putObject(leaf.key, still.body);
    }

    // Rows land last and together: a run that dies before this leaves none,
    // which is what makes the boot scan a complete retry signal.
    const rows = stored.map((still) => ({
      masterVideoId,
      timestampMs: still.timestampMs,
      storageStem: filmstripLeaf(source.scope, masterVideoId, still.timestampMs).key,
      width: STILL_WIDTH,
      height: 0,
      sizeBytes: still.body.byteLength,
    }));
    await deps.recordRows(rows);

    log.info("master thumbnails stored", { masterVideoId, posterStored, stills: rows.length });
    return { masterVideoId, posterStored, stills: rows.length, skipped: false };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
};

/* =========================================================
   QUEUE
   Bounded and in-process: one master at a time by default so
   FFmpeg never competes with itself for the machine.
========================================================= */

const queued = new Set<number>();
const inFlight = new Set<number>();
let running = 0;

// Fire-and-forget. A master already queued or already running is dropped: one
// close means one job, and a repeat close has nothing new to describe.
export const enqueueThumbnails = (masterVideoId: number, deps?: ThumbnailDeps): void => {
  if (queued.has(masterVideoId) || inFlight.has(masterVideoId)) return;
  queued.add(masterVideoId);
  void pump(deps);
};

const pump = async (deps?: ThumbnailDeps): Promise<void> => {
  while (running < env.FFMPEG_CONCURRENCY && queued.size > 0) {
    const [next] = queued;
    queued.delete(next!);
    inFlight.add(next!);
    running += 1;
    void runThumbnailJob(next!, deps)
      .catch((error) => {
        // Best effort: playback reads segment rows, never this table.
        log.warn("thumbnail job failed", { masterVideoId: next, err: String(error).slice(0, 200) });
      })
      .finally(() => {
        running -= 1;
        inFlight.delete(next!);
        void pump(deps);
      });
  }
};

// Boot scan: closed masters with no timeline rows. Cheap, safe to repeat, and
// the reason no job row is needed.
export const sweepMissingThumbnails = async (deps?: ThumbnailDeps): Promise<number> => {
  const missing = await listMastersNeedingThumbnails();
  for (const masterVideoId of missing) {
    enqueueThumbnails(masterVideoId, deps);
  }
  if (missing.length > 0) {
    log.info("thumbnail sweep queued closed masters", { count: missing.length });
  }
  return missing.length;
};

let sweepStarted = false;

// Fire-and-forget at boot; never blocks serving.
export const startThumbnailSweep = (): void => {
  if (sweepStarted) return;
  sweepStarted = true;
  void sweepMissingThumbnails().catch((error) => {
    log.warn("thumbnail sweep failed", { err: String(error).slice(0, 200) });
  });
};
