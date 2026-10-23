// Merge a clip's stored segments into one .mkv.
//
// The segment set is the one playback serves: the playable ingest, its frozen
// final sequence, then the contiguous prefix. Every fetched segment is checked
// against its stored sha256 and size, so a truncated GET never reaches ffmpeg.
// The ladder falls back one step at a time and never reports a silent failure.
// flow: ingest > segments > cache > statfs > fetch > copy concat > gate >
//       split > re-encode > cache store

import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";

import { env } from "../../../config/env";
import { runFfmpegBounded, probeDurationSeconds } from "../../../lib/ffmpeg";
import { log } from "../../../lib/logger";
import { minio } from "../../../lib/minio_storage/clients";
import {
  findPlayableIngestRecord,
  listIngestSegmentRecords,
} from "../../../db/repositories/recording-ingest.repository";
import {
  dropClipCache,
  findClipCacheHit,
  storeClipCache,
} from "../../../db/services/clip-cache.service";
import { contiguousPrefix } from "../../playback-stream/hls";

// A clip merge is bounded by its own length, scaled from the phase 0 ladder
// timings: 1.2 s per clip minute to copy, 8 s per clip minute to encode.
const COPY_TIMEOUT_PER_MINUTE_MS = 3_000;
const ENCODE_TIMEOUT_PER_MINUTE_MS = 15_000;
const MIN_TIMEOUT_MS = 60_000;

// Fetch retries: 1 s, 4 s, 16 s. A late segment is usually a flushing writer.
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];

// Room left on the scratch volume beyond the clip's own bytes.
const SPACE_MARGIN_BYTES = 256 * 1024 * 1024;

// The gate: duration within 2% of the summed segment durations.
const DURATION_TOLERANCE = 0.02;

export type RemuxStatus = "ok" | "partial" | "skipped" | "failed";

export type RemuxResult = {
  status: RemuxStatus;
  // the stored .mkv, when one was produced
  key: string | null;
  localFile: string | null;
  sizeBytes: number;
  durationMs: number;
  // the ladder step that produced the file, for the log
  step: "cache" | "copy" | "split" | "encode" | null;
  error: string | null;
};

export type RemuxSegment = {
  sequence: number;
  objectKey: string;
  checksumSha256: string | null;
  sizeBytes: number | null;
  durationMs: number;
  discontinuity: boolean;
};

export type RemuxDeps = {
  pickIngest: (clipId: number) => ReturnType<typeof findPlayableIngestRecord>;
  listSegments: (ingestId: number, upTo: number | null) => Promise<RemuxSegment[]>;
  fetchSegment: (objectKey: string, destination: string) => Promise<void>;
  runFfmpeg: typeof runFfmpegBounded;
  probeDuration: (file: string) => Promise<number | null>;
  freeBytes: (directory: string) => Promise<number>;
  cacheHit: typeof findClipCacheHit;
  cacheStore: typeof storeClipCache;
  cacheDrop: typeof dropClipCache;
  putObject: (key: string, file: string) => Promise<void>;
};

const defaultDeps: RemuxDeps = {
  pickIngest: (clipId) => findPlayableIngestRecord({ kind: "clip", id: clipId }),
  listSegments: async (ingestId, upTo) =>
    (await listIngestSegmentRecords(ingestId, upTo)).map((row) => ({
      sequence: row.sequence,
      objectKey: row.objectKey,
      checksumSha256: row.checksumSha256,
      sizeBytes: row.sizeBytes,
      durationMs: row.durationMs,
      discontinuity: row.discontinuity,
    })),
  fetchSegment: async (objectKey, destination) => {
    const stream = await minio.getObject(env.BUCKET_MEDIA, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    await Bun.write(destination, Buffer.concat(chunks));
  },
  runFfmpeg: runFfmpegBounded,
  probeDuration: (file) => probeDurationSeconds(file),
  freeBytes: async (directory) => {
    const info = await statfs(directory);
    return info.bavail * info.bsize;
  },
  cacheHit: findClipCacheHit,
  cacheStore: storeClipCache,
  cacheDrop: dropClipCache,
  putObject: async (key, file) => {
    const body = Buffer.from(await Bun.file(file).arrayBuffer());
    await minio.putObject(env.BUCKET_MEDIA, key, body, body.length, {
      "Content-Type": "video/x-matroska",
    });
  },
};

// The tests swap these; production and the suite read the same shape.
export const remuxDeps: RemuxDeps = { ...defaultDeps };
export const resetRemuxDeps = () => Object.assign(remuxDeps, defaultDeps);

const timeoutFor = (durationMs: number, perMinuteMs: number) =>
  Math.max(MIN_TIMEOUT_MS, Math.ceil((durationMs / 60_000) * perMinuteMs));

const sha256Of = async (file: string) =>
  createHash("sha256").update(Buffer.from(await Bun.file(file).arrayBuffer())).digest("hex");

// flow: fetch > sha256 + size check > retry on mismatch > drop on final failure
const fetchWithCheck = async (
  segment: RemuxSegment,
  destination: string,
  deps: RemuxDeps,
): Promise<boolean> => {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await deps.fetchSegment(segment.objectKey, destination);
      const size = (await stat(destination)).size;
      if (segment.sizeBytes !== null && size !== segment.sizeBytes) {
        throw new Error(`size ${size} != ${segment.sizeBytes}`);
      }
      if (segment.checksumSha256) {
        const digest = await sha256Of(destination);
        if (digest !== segment.checksumSha256) throw new Error("sha256 mismatch");
      }
      return true;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        log.warn("segment fetch failed for good", { sequence: segment.sequence, err: String(error) });
        await rm(destination, { force: true });
        return false;
      }
      await Bun.sleep(delay);
    }
  }
  return false;
};

// Join the .ts files byte for byte, then remux without touching the codec.
const copyConcat = async (
  files: string[],
  joinedTs: string,
  target: string,
  durationMs: number,
  deps: RemuxDeps,
  signal?: AbortSignal,
) => {
  const sink = Bun.file(joinedTs).writer();
  for (const file of files) {
    for await (const chunk of Bun.file(file).stream()) sink.write(chunk);
  }
  await sink.end();

  return deps.runFfmpeg(
    env.FFMPEG_PATH,
    ["-y", "-v", "warning", "-i", joinedTs, "-c", "copy", target],
    timeoutFor(durationMs, COPY_TIMEOUT_PER_MINUTE_MS),
    { signal },
  );
};

// The gate: the file must decode and its duration must match the segment sum.
const passesGate = async (file: string, expectedMs: number, deps: RemuxDeps) => {
  const duration = await deps.probeDuration(file);
  if (duration === null) return { ok: false, durationMs: 0 };
  const expected = expectedMs / 1000;
  const within = expected === 0 || Math.abs(duration - expected) / expected <= DURATION_TOLERANCE;
  return { ok: within, durationMs: Math.round(duration * 1000) };
};

const empty = (status: RemuxStatus, error: string | null = null): RemuxResult => ({
  status,
  key: null,
  localFile: null,
  sizeBytes: 0,
  durationMs: 0,
  step: null,
  error,
});

// flow: cache > space > fetch > copy > gate > split > encode > store
export const mergeClip = async (
  clipId: number,
  scratchRoot: string,
  options: { signal?: AbortSignal; deps?: RemuxDeps } = {},
): Promise<RemuxResult> => {
  const deps = options.deps ?? remuxDeps;
  const signal = options.signal;

  const ingest = await deps.pickIngest(clipId);
  if (!ingest) return empty("skipped", "no ingest");

  // closed: stop at the frozen final sequence. open: prefix only, partial.
  const open = ingest.closedAt === null;
  const upTo = open ? null : (ingest.finalSequence ?? -1);
  const rows = await deps.listSegments(ingest.ingestId, upTo);
  // the same prefix rule playback applies, keeping this row's own fields
  const inPrefix = new Set(contiguousPrefix(rows).map((row) => row.sequence));
  const segments = rows.filter((row) => inPrefix.has(row.sequence));
  if (segments.length === 0) return empty("skipped", "no segments");

  const gapped = !open && segments.length < rows.length;
  const durationMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);

  // a closed, whole ingest may already have a merged file
  const cached = await deps.cacheHit(ingest.ingestId, segments.length);
  if (cached) {
    return {
      status: "ok",
      key: cached.key,
      localFile: null,
      sizeBytes: cached.sizeBytes,
      durationMs,
      step: "cache",
      error: null,
    };
  }

  const directory = path.join(scratchRoot, `clip-${clipId}-${Date.now()}`);
  await mkdir(directory, { recursive: true });

  try {
    const needed = segments.reduce((sum, segment) => sum + (segment.sizeBytes ?? 0), 0);
    if (needed > 0 && (await deps.freeBytes(scratchRoot)) < needed * 2 + SPACE_MARGIN_BYTES) {
      return empty("failed", "not enough scratch space");
    }

    const files: string[] = [];
    for (const [index, segment] of segments.entries()) {
      if (signal?.aborted) throw Object.assign(new Error("merge aborted"), { name: "AbortError" });
      const destination = path.join(directory, `${String(index).padStart(5, "0")}.ts`);
      if (!(await fetchWithCheck(segment, destination, deps))) {
        // a hole in the middle is a partial clip; nothing past it is playable
        return empty("partial", `segment ${segment.sequence} never arrived`);
      }
      files.push(destination);
    }

    const target = path.join(directory, "clip.mkv");
    const joined = path.join(directory, "joined.ts");
    await copyConcat(files, joined, target, durationMs, deps, signal);

    let step: RemuxResult["step"] = "copy";
    let gated = await passesGate(target, durationMs, deps);

    // a second timeline in one file: split at the seam and copy each half
    if (!gated.ok) {
      const half = Math.max(1, Math.floor(files.length / 2));
      const firstTs = path.join(directory, "part-a.ts");
      const secondTs = path.join(directory, "part-b.ts");
      await copyConcat(files.slice(0, half), firstTs, path.join(directory, "part-a.mkv"), durationMs / 2, deps, signal);
      await copyConcat(files.slice(half), secondTs, path.join(directory, "part-b.mkv"), durationMs / 2, deps, signal);

      await deps.runFfmpeg(
        env.FFMPEG_PATH,
        [
          "-y", "-v", "warning",
          "-i", path.join(directory, "part-a.mkv"),
          "-i", path.join(directory, "part-b.mkv"),
          "-c", "copy",
          target,
        ],
        timeoutFor(durationMs, COPY_TIMEOUT_PER_MINUTE_MS),
        { signal },
      );

      step = "split";
      gated = await passesGate(target, durationMs, deps);
    }

    // last resort: re-encode. Slower, but it always produces a playable file.
    if (!gated.ok) {
      const encoded = path.join(directory, "encoded.mkv");
      await deps.runFfmpeg(
        env.FFMPEG_PATH,
        [
          "-y", "-v", "warning",
          "-i", joined,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-threads", "2",
          "-c:a", "aac",
          encoded,
        ],
        timeoutFor(durationMs, ENCODE_TIMEOUT_PER_MINUTE_MS),
        { signal },
      );
      await Bun.write(target, Bun.file(encoded));
      step = "encode";
      gated = await passesGate(target, durationMs, deps);
    }

    if (!gated.ok) return empty("failed", "no ladder step produced a playable file");

    const sizeBytes = (await stat(target)).size;
    const key = `${ingest.keyPrefix}/exports/merged-${segments.length}.mkv`;
    await deps.putObject(key, target);

    // an open or gapped ingest is not a whole clip, so it never enters the cache
    if (!open && !gapped) {
      await deps.cacheStore({
        ingestId: ingest.ingestId,
        segmentCount: segments.length,
        objectKey: key,
        sizeBytes,
      });
    }

    return {
      status: open || gapped ? "partial" : "ok",
      key,
      localFile: target,
      sizeBytes,
      durationMs: gated.durationMs,
      step,
      error: open ? "ingest still open" : gapped ? "segments missing" : null,
    };
  } catch (error) {
    await deps.cacheDrop(ingest.ingestId).catch(() => {});
    return empty("failed", String(error).slice(-2_000));
  }
};

// Scratch cleanup: a finished merge leaves nothing behind but the file it ships.
export const clearClipScratch = async (directory: string) => {
  const entries = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(entries.map((entry) => rm(path.join(directory, entry), { recursive: true, force: true })));
};
