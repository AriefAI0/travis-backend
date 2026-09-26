// Thumbnails for a recording, written while it runs.
//
// One still per grid point (see thumbnail-grid.ts), taken from the segment that
// covers it. A closed master additionally gets its poster frame. Best effort by
// construction — the HLS playlist is built from segment rows, so a still that
// never lands changes nothing about playback.
//
// flow: due grid points > fetch those segments > local stills > dated keys > rows

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { env } from "../../../config/env";
import { log } from "../../../lib/logger";
import { minio } from "../../../lib/minio_storage/clients";
import { filmstripLeafV2, posterLeafV2 } from "../../../lib/minio_storage/paths";
import {
  listClipsNeedingThumbnails,
  listMastersNeedingThumbnails,
  loadClipStillSource,
  loadThumbnailSource,
  recordClipStill,
  recordTimelineThumbnails,
  type ClipStillSource,
  type ThumbnailSource,
  type TimelineThumbnailInsert,
} from "../../../db/services/recording-thumbnail.service";
import { dueSamples } from "./thumbnail-grid";

// A still is a review aid, not an artifact: small enough to keep many.
const STILL_WIDTH = 320;
const POSTER_WIDTH = 1280;
const POSTER_AT_MS = 1_000;

// Seams the tests replace: where the source comes from, process execution,
// storage reads and writes, and where the rows land.
export type ThumbnailDeps = {
  loadSource: (sessionId: number) => Promise<ThumbnailSource | null>;
  loadClipSource: (clipId: number) => Promise<ClipStillSource | null>;
  runFfmpeg: (command: string, args: string[], timeoutMs: number) => Promise<void>;
  fetchSegment: (objectKey: string, destination: string) => Promise<void>;
  putObject: (key: string, body: Uint8Array) => Promise<void>;
  recordRows: (rows: TimelineThumbnailInsert[]) => Promise<number>;
  recordClipStill: (clipId: number, thumbnailKey: string) => Promise<void>;
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

const defaultDeps: ThumbnailDeps = {
  loadSource: loadThumbnailSource,
  loadClipSource: loadClipStillSource,
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
  recordClipStill: (clipId, thumbnailKey) => recordClipStill(clipId, thumbnailKey),
};

// Masters and clips waiting or running. Observability only: the sets are the
// whole state, and no row records it.
export const pendingThumbnailJobs = (): number =>
  queued.size + clipQueued.size + inFlight.size + clipInFlight.size;

// Tests only: the queue is module state shared by every importer, so one file's
// in-flight job would otherwise decide another file's counts.
export const resetThumbnailQueue = (): void => {
  queued.clear();
  inFlight.clear();
  clipQueued.clear();
  clipInFlight.clear();
};

export type ThumbnailJobResult = {
  sessionId: number;
  posterStored: boolean;
  stills: number;
  skipped: boolean;
};

export type ClipStillJobResult = {
  clipId: number;
  stillStored: boolean;
  skipped: boolean;
};

// One still from one segment, scaled to `width`. Returns null when no frame
// could be read, which is a skip and never an error.
//
// Two rules, both learned from real segments:
// - The offset seeks on the OUTPUT side (`-i` first). An input seek into a TS
//   segment can land past the last frame and produce nothing at all, which
//   fails the encoder rather than returning a frame.
// - A segment that yields no frame at the offset falls back to its first frame.
//   A segment stopped mid-write reports a duration its frames do not reach
//   (measured: 1733 ms reported, 1233 ms of video), so the offset the grid asks
//   for can sit beyond the content.
const writeStill = async (
  deps: ThumbnailDeps,
  directory: string,
  segmentFile: string,
  label: string,
  width: number,
  atMs: number,
): Promise<Uint8Array | null> => {
  const file = stillPath(directory, label);

  for (const offsetMs of atMs > 0 ? [atMs, 0] : [0]) {
    try {
      await deps.runFfmpeg(
        env.FFMPEG_PATH,
        [
          "-y",
          "-i", segmentFile,
          ...(offsetMs > 0 ? ["-ss", String(offsetMs / 1000)] : []),
          "-frames:v", "1",
          // one image, not a sequence: a strict build refuses the write without it
          "-update", "1",
          "-vf", `scale=${width}:-2`,
          file,
        ],
        env.FFMPEG_TIMEOUT_MS,
      );

      const body = await readFile(file).catch(() => null);

      if (body !== null && body.byteLength > 0) {
        return new Uint8Array(body);
      }
    } catch (error) {
      // Only worth reporting when the fallback does not save it; a short tail
      // segment failing its offset is routine.
      if (offsetMs === 0) {
        log.warn("thumbnail still failed", {
          label,
          err: String(error).slice(0, 200),
        });
      }
    }
  }

  return null;
};

// flow: source > due points > fetch those segments > stills > dated keys > rows
export const runThumbnailJob = async (
  sessionId: number,
  deps: ThumbnailDeps = defaultDeps,
): Promise<ThumbnailJobResult> => {
  const source = await deps.loadSource(sessionId);
  if (!source) {
    return { sessionId, posterStored: false, stills: 0, skipped: true };
  }

  const due = dueSamples(
    source.segments,
    source.existingTimestamps,
    env.THUMBNAIL_SAMPLE_BASE_MS,
    env.THUMBNAIL_MAX_SAMPLES,
  );
  const posterDue = source.closed;

  if (due.length === 0 && !posterDue) {
    return { sessionId, posterStored: false, stills: 0, skipped: true };
  }

  const directory = await mkdtemp(path.join(tmpdir(), `travis-thumb-${sessionId}-`));
  try {
    // Every run reads exactly the segments its due points land in: no pass over
    // the whole recording for a still nobody asked for.
    const bySequence = new Map(source.segments.map((row) => [row.sequence, row]));
    const startBySequence = new Map<number, number>();
    const wanted = new Set(due.map((row) => row.sequence));
    let segmentStartMs = 0;

    for (const segment of source.segments) {
      startBySequence.set(segment.sequence, segmentStartMs);
      segmentStartMs += segment.durationMs;
    }

    if (posterDue && source.segments[0]) {
      wanted.add(source.segments[0].sequence);
    }

    for (const sequence of wanted) {
      const segment = bySequence.get(sequence);
      if (segment) {
        await deps.fetchSegment(segment.objectKey, segmentPath(directory, sequence));
      }
    }

    const stored: Array<{ timestampMs: number; body: Uint8Array }> = [];

    for (const sample of due) {
      const sampleStartMs = startBySequence.get(sample.sequence);
      if (sampleStartMs === undefined) continue;

      const body = await writeStill(
        deps,
        directory,
        segmentPath(directory, sample.sequence),
        `still-${sample.timestampMs}`,
        STILL_WIDTH,
        // offset inside its own segment, so the frame is the grid point
        sample.timestampMs - sampleStartMs,
      );

      if (body) stored.push({ timestampMs: sample.timestampMs, body });
    }

    // The poster is the closed recording's face, taken from its first segment.
    let posterStored = false;

    if (posterDue && source.segments[0]) {
      const first = source.segments[0];
      const posterBody = await writeStill(
        deps,
        directory,
        segmentPath(directory, first.sequence),
        "poster",
        POSTER_WIDTH,
        POSTER_AT_MS,
      );

      if (posterBody) {
        const leaf = posterLeafV2(source.keyPrefix);
        await deps.putObject(leaf.key, posterBody);
        posterStored = true;
      }
    }

    for (const still of stored) {
      const leaf = filmstripLeafV2(source.keyPrefix, still.timestampMs);
      await deps.putObject(leaf.key, still.body);
    }

    // Rows land last and together: a run that dies before this leaves none,
    // which is what makes the boot scan a complete retry signal.
    const rows = stored.map((still) => ({
      sessionId,
      timestampMs: still.timestampMs,
      storageStem: filmstripLeafV2(source.keyPrefix, still.timestampMs).key,
      width: STILL_WIDTH,
      height: 0,
      sizeBytes: still.body.byteLength,
    }));
    await deps.recordRows(rows);

    log.info("master thumbnails stored", { sessionId, posterStored, stills: rows.length });
    return { sessionId, posterStored, stills: rows.length, skipped: false };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
};

// One card still per clip, taken from its first sealed segment.
export const runClipStillJob = async (
  clipId: number,
  deps: ThumbnailDeps = defaultDeps,
): Promise<ClipStillJobResult> => {
  const source = await deps.loadClipSource(clipId);
  if (!source) {
    return { clipId, stillStored: false, skipped: true };
  }

  const directory = await mkdtemp(path.join(tmpdir(), `travis-clip-still-${clipId}-`));
  try {
    const file = segmentPath(directory, 0);
    await deps.fetchSegment(source.firstSegmentObjectKey, file);

    const body = await writeStill(deps, directory, file, "clip", STILL_WIDTH, 0);
    if (!body) {
      return { clipId, stillStored: false, skipped: false };
    }

    const leaf = posterLeafV2(source.keyPrefix);
    await deps.putObject(leaf.key, body);
    await deps.recordClipStill(clipId, leaf.key);

    log.info("clip still stored", { clipId });
    return { clipId, stillStored: true, skipped: false };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
};

/* =========================================================
   QUEUE
   Bounded and in-process: one job at a time by default so
   FFmpeg never competes with itself for the machine.
========================================================= */

const queued = new Set<number>();
const inFlight = new Set<number>();
const clipQueued = new Set<number>();
const clipInFlight = new Set<number>();

// Running is what the in-flight sets hold: a counter would drift the moment a
// job settles outside a reset.
const runningCount = (): number => inFlight.size + clipInFlight.size;

// Fire-and-forget. A master already waiting is dropped: that one run will see
// whatever has arrived by the time it picks up. A master already running is
// queued again, because the run in flight derived its due set before this
// segment landed and would otherwise leave the tail unfilled.
export const enqueueThumbnails = (sessionId: number, deps?: ThumbnailDeps): void => {
  if (queued.has(sessionId)) return;
  queued.add(sessionId);
  void pump(deps);
};

export const enqueueClipStill = (clipId: number, deps?: ThumbnailDeps): void => {
  if (clipQueued.has(clipId)) return;
  clipQueued.add(clipId);
  void pump(deps);
};

const pump = async (deps?: ThumbnailDeps): Promise<void> => {
  while (runningCount() < env.FFMPEG_CONCURRENCY) {
    // Never two runs for one target: a requeue waits for its own run to settle.
    const nextMaster = [...queued].find((id) => !inFlight.has(id));
    const nextClip = nextMaster === undefined ? [...clipQueued].find((id) => !clipInFlight.has(id)) : undefined;

    if (nextMaster === undefined && nextClip === undefined) return;

    if (nextMaster !== undefined) {
      queued.delete(nextMaster);
      inFlight.add(nextMaster);
    } else {
      clipQueued.delete(nextClip!);
      clipInFlight.add(nextClip!);
    }

    const job =
      nextMaster !== undefined
        ? runThumbnailJob(nextMaster, deps)
        : runClipStillJob(nextClip!, deps);

    void job
      .catch((error) => {
        // Best effort: playback reads segment rows, never this table.
        log.warn("thumbnail job failed", {
          sessionId: nextMaster,
          clipId: nextClip,
          err: String(error).slice(0, 200),
        });
      })
      .finally(() => {
        if (nextMaster !== undefined) {
          inFlight.delete(nextMaster);
        } else {
          clipInFlight.delete(nextClip!);
        }

        void pump(deps);
      });
  }
};

// Boot scan: every recording whose grid is not filled. Cheap, safe to repeat,
// and the reason no job row is needed.
export const sweepMissingThumbnails = async (deps?: ThumbnailDeps): Promise<number> => {
  const masters = await listMastersNeedingThumbnails();

  for (const sessionId of masters) {
    enqueueThumbnails(sessionId, deps);
  }

  const clips = await listClipsNeedingThumbnails();

  for (const clipId of clips) {
    enqueueClipStill(clipId, deps);
  }

  if (masters.length > 0 || clips.length > 0) {
    log.info("thumbnail sweep queued recordings", {
      masters: masters.length,
      clips: clips.length,
    });
  }

  return masters.length + clips.length;
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
