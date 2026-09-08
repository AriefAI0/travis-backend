import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "minio";

import { env } from "../../../config/env";
import { db, type DbOrTx } from "../../../db/client";
import { log } from "../../../lib/logger";
import { minio } from "../../../lib/minio_storage/clients";
import { v2PlaybackPrefix, v2SegmentLeaf } from "../../../lib/minio_storage/paths";
import { listRecordingSegments } from "../../../db/repositories/recording-upload.repository";
import { lookupRecordingUpload } from "../../../db/services/recording-upload.service";
import {
  claimNextRecordingFinalizeJob,
  completeRecordingFinalizeJob,
  deferRecordingFinalizeJob,
  failRecordingFinalizeJob,
  markStaleRecordingsInterrupted,
  renewRecordingFinalizeLease,
  RECOVERY_DEBOUNCE_SECONDS,
  scheduleRecordingFinalize,
} from "../../../db/services/recording-finalize.service";
import type { recordingUpload } from "../../../db/schema";

const POLL_MS = 1000;
const RENEW_EVERY_MS = 15_000;
const DEFER_ACTIVE_MS = 15_000; // capture still running
const DEFER_RANGE_MS = 30_000; // declared range not fully stored yet
const DEFER_EMPTY_MS = 30_000; // interrupted take with nothing stored yet

export type FinalizeProcessResult = {
  status: "idle" | "completed" | "deferred" | "failed";
  jobId?: string;
  detail?: string;
};

// flow: mark stale captures > claim > defer-or-assemble > publish pointer.
// Decision matrix (spec 12/13): recording + fresh heartbeat defers; a stale
// heartbeat flips to interrupted first; a declared final index waits for the
// whole range; an undeclared interrupted take publishes the longest
// contiguous prefix after the five-second recovery debounce.
export const processNextRecordingFinalizeJob = async (
  opts: { database?: DbOrTx; storage?: Client; ownerId?: string } = {}
): Promise<FinalizeProcessResult> => {
  const database = opts.database ?? db;
  const storage = opts.storage ?? minio;

  // captures that went silent become interrupted and get their first job
  const newlyInterrupted = await markStaleRecordingsInterrupted(database);
  for (const row of newlyInterrupted) {
    await scheduleRecordingFinalize(row.recordingId, row.segmentRevision, undefined, database);
  }

  const ownerId = opts.ownerId ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  const job = await claimNextRecordingFinalizeJob(ownerId, database);
  if (!job) return { status: "idle" };

  // lease renewal runs alongside processing; publish re-checks ownership
  let leaseLost = false;
  const renewTimer = setInterval(() => {
    void renewRecordingFinalizeLease(job.jobId, ownerId, database)
      .then((renewed) => {
        if (!renewed) leaseLost = true;
      })
      .catch(() => {
        leaseLost = true;
      });
  }, RENEW_EVERY_MS);

  try {
    const upload = await lookupRecordingUpload(job.recordingId, database);
    if (!upload) {
      await failRecordingFinalizeJob(job.jobId, ownerId, "recording row missing", database);
      return { status: "failed", jobId: job.jobId, detail: "recording row missing" };
    }

    if (upload.captureState === "recording") {
      await deferRecordingFinalizeJob(
        job.jobId,
        ownerId,
        new Date(Date.now() + DEFER_ACTIVE_MS),
        database
      );
      return { status: "deferred", jobId: job.jobId, detail: "capture still active" };
    }

    const segments = await listRecordingSegments(job.recordingId, database);
    const storedIndexes = new Set(
      segments.filter((s) => s.receiptState === "stored").map((s) => s.segmentIndex)
    );
    let contiguous = -1;
    while (storedIndexes.has(contiguous + 1)) contiguous += 1;
    const finalIndex = upload.finalSegmentIndex;

    // empty capture: nothing to assemble, complete without publishing
    if (finalIndex !== null && finalIndex < 0) {
      const done = await completeRecordingFinalizeJob(job.jobId, ownerId, null, database);
      return done.completed
        ? { status: "completed", jobId: job.jobId, detail: "empty capture" }
        : { status: "deferred", jobId: job.jobId, detail: "lease lost" };
    }

    let range: number[];
    if (finalIndex !== null) {
      // declared end (normal stop or recovery-complete): wait for it all
      const missing: number[] = [];
      for (let i = 0; i <= finalIndex; i++) {
        if (!storedIndexes.has(i)) missing.push(i);
      }
      if (missing.length > 0) {
        await deferRecordingFinalizeJob(
          job.jobId,
          ownerId,
          new Date(Date.now() + DEFER_RANGE_MS),
          database
        );
        return {
          status: "deferred",
          jobId: job.jobId,
          detail: `waiting for declared range, missing ${missing.length}`,
        };
      }
      range = Array.from({ length: finalIndex + 1 }, (_, i) => i);
    } else {
      // interrupted, no declared end: longest contiguous prefix after debounce
      if (contiguous === -1) {
        await deferRecordingFinalizeJob(
          job.jobId,
          ownerId,
          new Date(Date.now() + DEFER_EMPTY_MS),
          database
        );
        return { status: "deferred", jobId: job.jobId, detail: "nothing stored yet" };
      }
      const newestStoredAt = segments.reduce<number | null>((acc, s) => {
        const t = s.storedAt?.getTime() ?? 0;
        return t > (acc ?? 0) ? t : acc;
      }, null);
      if (
        newestStoredAt &&
        Date.now() - newestStoredAt < RECOVERY_DEBOUNCE_SECONDS * 1000
      ) {
        await deferRecordingFinalizeJob(
          job.jobId,
          ownerId,
          new Date(Date.now() + RECOVERY_DEBOUNCE_SECONDS * 1000),
          database
        );
        return { status: "deferred", jobId: job.jobId, detail: "recovery debounce" };
      }
      range = Array.from({ length: contiguous + 1 }, (_, i) => i);
    }

    if (leaseLost) return { status: "deferred", jobId: job.jobId, detail: "lease lost" };

    // raw objects first (spec 13) — a stored receipt with a missing object is
    // a storage incident: fail and retry, never publish over a hole
    for (const index of range) {
      const leaf = v2SegmentLeaf(upload.recordingId, index);
      await storage.statObject(leaf.bucket, leaf.key);
    }

    await buildAndUploadArtifacts(upload, job.targetRevision, range, storage, database);

    if (leaseLost) return { status: "deferred", jobId: job.jobId, detail: "lease lost" };
    const done = await completeRecordingFinalizeJob(
      job.jobId,
      ownerId,
      { recordingId: upload.recordingId, revision: job.targetRevision },
      database
    );
    if (!done.completed) {
      return { status: "deferred", jobId: job.jobId, detail: "lease lost at publish" };
    }
    // receipts moved while we built artifacts: line up the newer revision
    if (upload.segmentRevision > job.targetRevision) {
      await scheduleRecordingFinalize(
        upload.recordingId,
        upload.segmentRevision,
        undefined,
        database
      );
    }
    return { status: "completed", jobId: job.jobId };
  } catch (err) {
    await failRecordingFinalizeJob(job.jobId, ownerId, String(err), database);
    return { status: "failed", jobId: job.jobId, detail: String(err).slice(0, 200) };
  } finally {
    clearInterval(renewTimer);
  }
};

// long-lived loop for boot: drains due jobs, polls when idle
export function startRecordingFinalizeWorker() {
  void (async () => {
    for (;;) {
      let ran = false;
      try {
        const result = await processNextRecordingFinalizeJob();
        ran = result.status !== "idle";
      } catch (err) {
        log.error("recording finalize worker error", { err: String(err) });
      }
      if (!ran) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  })();
  log.info("recording finalize worker started");
}

interface ArtifactUpload {
  bucket: string;
  key: string;
  path: string;
  contentType: string;
}

// assemble the revision stream, remux artifacts under the revision prefix,
// upload everything — the caller publishes the pointer only after this returns
// flow: download+concat > mkv > probe > hls > poster > timeline > upload all
async function buildAndUploadArtifacts(
  upload: typeof recordingUpload.$inferSelect,
  revision: number,
  indexes: number[],
  storage: Client,
  database: DbOrTx
): Promise<ArtifactUpload[]> {
  void database;
  const dir = join(env.DATA_DIR, "tmp", `v2-${upload.recordingId}-${revision}`);
  await mkdir(dir, { recursive: true });
  try {
    const masterPath = join(dir, "master.ts");
    const writer = Bun.file(masterPath).writer();
    for (const index of indexes) {
      const segPath = join(dir, `seg_${String(index).padStart(10, "0")}.ts`);
      const leaf = v2SegmentLeaf(upload.recordingId, index);
      await storage.fGetObject(leaf.bucket, leaf.key, segPath);
      await writer.write(await Bun.file(segPath).arrayBuffer());
    }
    await writer.end();

    const mkvPath = join(dir, "video.mkv");
    await runFF(["-y", "-i", masterPath, "-c", "copy", mkvPath]);
    const durationMs = await probeDurationMs(mkvPath);

    const mediaPath = join(dir, "media.ts");
    const manifestPath = join(dir, "index.m3u8");
    await runFF([
      "-y",
      "-i",
      masterPath,
      "-c",
      "copy",
      "-f",
      "hls",
      "-hls_time",
      "6",
      "-hls_flags",
      "single_file",
      "-hls_segment_filename",
      mediaPath,
      manifestPath,
    ]);

    const posterPath = join(dir, "poster.jpg");
    await makePoster(masterPath, posterPath);

    const prefix = v2PlaybackPrefix(upload.recordingId, revision);
    const artifacts: ArtifactUpload[] = [
      { bucket: prefix.bucket, key: `${prefix.key}/video.mkv`, path: mkvPath, contentType: "video/x-matroska" },
      { bucket: prefix.bucket, key: `${prefix.key}/hls/index.m3u8`, path: manifestPath, contentType: "application/vnd.apple.mpegurl" },
      { bucket: prefix.bucket, key: `${prefix.key}/hls/media.ts`, path: mediaPath, contentType: "video/mp2t" },
      { bucket: prefix.bucket, key: `${prefix.key}/poster.jpg`, path: posterPath, contentType: "image/jpeg" },
    ];

    // timeline filmstrip: masters only (clips have no filmstrip)
    if (upload.kind === "master") {
      const stills = await extractTimelineStills(masterPath, dir, durationMs);
      for (const still of stills) {
        artifacts.push({
          bucket: prefix.bucket,
          key: `${prefix.key}/timeline/${String(still.timestampMs).padStart(9, "0")}.jpg`,
          path: still.path,
          contentType: "image/jpeg",
        });
      }
    }

    for (const artifact of artifacts) {
      await storage.fPutObject(artifact.bucket, artifact.key, artifact.path, {
        "Content-Type": artifact.contentType,
      });
    }
    log.info("v2 artifacts published", {
      recording: upload.recordingId,
      revision,
      artifacts: artifacts.length,
    });
    return artifacts;
  } finally {
    await rm(dir, { recursive: true, force: true }); // temp never outlives the job
  }
}

interface TimelineStill {
  timestampMs: number;
  path: string;
}

// filmstrip: adaptive interval caps the set near 20 stills with a 10s floor
async function extractTimelineStills(masterPath: string, dir: string, durationMs: number) {
  const durationSec = durationMs / 1000;
  const intervalSec = Math.max(10, Math.ceil(durationSec / 20));
  const stamps: number[] = [];
  for (let t = 0; t < durationSec; t += intervalSec) stamps.push(Math.round(t * 1000));
  if (stamps.length === 0) stamps.push(0); // sub-interval take still yields frame zero

  const stills: TimelineStill[] = [];
  for (const ms of stamps) {
    const path = join(dir, `t_${String(ms).padStart(9, "0")}.jpg`);
    await runFF(["-y", "-ss", String(ms / 1000), "-i", masterPath, "-frames:v", "1", "-q:v", "3", path]);
    if ((await Bun.file(path).size) === 0) continue; // no decodable frame at the stamp
    stills.push({ timestampMs: ms, path });
  }
  return stills;
}

// one frame at 1s; streams whose first pts sits past 1s (or sub-1s takes)
// fall back to the very first frame
async function makePoster(masterPath: string, posterPath: string) {
  try {
    await runFF(["-y", "-ss", "1", "-i", masterPath, "-frames:v", "1", "-q:v", "2", posterPath]);
  } catch (err) {
    log.warn("poster seek fallback", { err: String(err).slice(0, 120) });
  }
  if ((await Bun.file(posterPath).size) > 0) return;
  await runFF(["-y", "-ss", "0", "-i", masterPath, "-frames:v", "1", "-q:v", "2", posterPath]);
}

async function runFF(args: string[]) {
  const proc = Bun.spawn([env.FFMPEG_PATH, ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).slice(-500);
    throw new Error(`ffmpeg (${args.join(" ")}) failed: ${err}`);
  }
}

async function probeDurationMs(path: string): Promise<number> {
  const proc = Bun.spawn(
    [ffprobePath(), "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (code !== 0) throw new Error(`ffprobe failed on ${path}`);
  const seconds = Number(JSON.parse(out).format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe reported no duration for ${path}`);
  return Math.round(seconds * 1000);
}

// ffprobe sits next to the ffmpeg binary (FFMPEG_PATH .../ffmpeg -> .../ffprobe)
function ffprobePath() {
  return env.FFMPEG_PATH.endsWith("ffmpeg") ? env.FFMPEG_PATH.slice(0, -6) + "ffprobe" : "ffprobe";
}
