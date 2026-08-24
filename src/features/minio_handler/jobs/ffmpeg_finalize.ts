import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../../config/env";
import { db } from "../../../db/client";
import * as videoService from "../../../db/services/video.service";
import { log } from "../../../lib/logger";
import { tracker, type JobRow } from "../../../lib/db/minio_tracker";
import { minio } from "../../../lib/minio_storage/clients";
import { markRecordingFailedByStem } from "../service";
import { clipLeaves, masterLeaves, stemPk, timelineStill } from "../paths";

// flow: download master > remux mkv > probe duration > single-file hls >
// thumbnail > timeline stills > upload all > bridge to Postgres > mark
// finalized. Stream-copy only (spec D9).
export async function finalizeJob(job: JobRow) {
  const session = tracker.getSession(job.session_id);
  if (!session || session.status === "finalized") return; // gone or already done: idempotent
  if (!session.bucket || !session.storage_stem) throw new Error(`session ${job.session_id} has no object target`);
  const stem = session.storage_stem;

  const dir = join(env.DATA_DIR, "tmp", session.id);
  await mkdir(dir, { recursive: true });
  try {
    const leaves = session.kind === "master" ? masterLeaves(stem) : clipLeaves(stem);
    const masterPath = join(dir, "master.ts");
    await minio.fGetObject(leaves.raw.bucket, leaves.raw.key, masterPath);

    const mkvPath = join(dir, "out.mkv");
    await runFF(["-y", "-i", masterPath, "-c", "copy", mkvPath]);

    // probe the TEMP mkv before uploading — duration validated once, no second download
    const durationMs = await probeDurationMs(mkvPath);

    const mediaPath = join(dir, "media.ts");
    const manifestPath = join(dir, "index.m3u8");
    await runFF(["-y", "-i", masterPath, "-c", "copy", "-f", "hls", "-hls_time", "6", "-hls_flags", "single_file",
      "-hls_segment_filename", mediaPath, manifestPath]);

    const thumbPath = join(dir, "thumb.jpg");
    await makeThumb(masterPath, thumbPath);

    // upload artifacts; overwrites make retries idempotent
    await minio.fPutObject(leaves.mkv.bucket, leaves.mkv.key, mkvPath, { "Content-Type": "video/x-matroska" });
    await minio.fPutObject(leaves.hlsManifest.bucket, leaves.hlsManifest.key, manifestPath, { "Content-Type": "application/vnd.apple.mpegurl" });
    await minio.fPutObject(leaves.hlsMedia.bucket, leaves.hlsMedia.key, mediaPath, { "Content-Type": "video/mp2t" });
    await minio.fPutObject(leaves.poster.bucket, leaves.poster.key, thumbPath, { "Content-Type": "image/jpeg" });

    // timeline filmstrip: masters only (timeline_thumbnail hangs off master)
    const stills =
      session.kind === "master" ? await extractTimelineStills(masterPath, dir, durationMs) : [];
    const first = stills[0];
    const dims = first ? await probeImage(first.path) : null;
    for (const still of stills) {
      const leaf = timelineStill(stem, still.timestampMs);
      await minio.fPutObject(leaf.bucket, leaf.key, still.path, { "Content-Type": "image/jpeg" });
    }

    // bridge: durable facts to Postgres in ONE tx after artifacts exist (spec).
    // Updates by PK converge on retry; a failed tx leaves no half-visible row.
    await bridgeToPostgres(session.kind, stem, durationMs, session.size_bytes ?? null, stills, dims);

    tracker.setFinalized(session.id, durationMs);
    log.info("finalize complete", { session: session.id, durationMs, stills: stills.length });
  } finally {
    await rm(dir, { recursive: true, force: true }); // temp never outlives the job
  }
}

// single write point from ingest into the domain (spec): master gets duration,
// size, status + the timeline set; clip gets duration via endOffsetMs + size
async function bridgeToPostgres(
  kind: "master" | "clip",
  stem: string,
  durationMs: number,
  fileSize: number | null,
  stills: TimelineStill[],
  dims: { width: number; height: number } | null,
) {
  const ref = stemPk(stem);
  if (!ref) throw new Error(`stem ${stem} carries no master/clip reference`);

  await db.transaction(async (tx) => {
    if (kind === "master") {
      const row = await videoService.getMasterVideoById(ref.pk, tx);
      if (!row) throw new Error(`master video ${ref.pk} missing at bridge time`);
      await videoService.markMasterVideoFinalized(
        ref.pk,
        {
          stoppedAt: new Date(),
          durationMs,
          fileSize,
          endEpoch: row.startEpoch + Math.round(durationMs / 1000),
        },
        tx,
      );
      if (stills.length > 0 && dims) {
        await videoService.replaceMasterVideoTimelineThumbnails(
          ref.pk,
          stills.map((still) => ({
            masterVideoId: ref.pk,
            timestampMs: still.timestampMs,
            imagePath: timelineStill(stem, still.timestampMs).key,
            width: dims.width,
            height: dims.height,
            sizeBytes: still.sizeBytes,
            storageStem: stem,
          })),
          tx,
        );
      }
      return;
    }

    // clip offsets are master-relative in the domain. The parent's enforced
    // span is second-granular (endEpoch - startEpoch), so a clip probing a
    // hair past it clamps down instead of failing validation forever.
    const clip = await videoService.getVideoClipById(ref.pk, tx);
    if (!clip) throw new Error(`video clip ${ref.pk} missing at bridge time`);
    const parent = await videoService.getMasterVideoById(clip.masterVideoId, tx);
    const endOffsetMs =
      parent?.endEpoch != null
        ? Math.min(durationMs, (parent.endEpoch - parent.startEpoch) * 1000)
        : durationMs;
    await videoService.markVideoClipFinalized(
      ref.pk,
      { fileSize, endOffsetMs },
      tx,
    );
  });
}

interface TimelineStill {
  timestampMs: number;
  path: string;
  sizeBytes: number;
}

// filmstrip: adaptive interval caps the set near 20 stills with a 10s floor.
// Slot stamps are deterministic, so a retried job produces the same keys.
async function extractTimelineStills(
  masterPath: string,
  dir: string,
  durationMs: number,
): Promise<TimelineStill[]> {
  const durationSec = durationMs / 1000;
  const intervalSec = Math.max(10, Math.ceil(durationSec / 20));
  const stamps: number[] = [];
  for (let t = 0; t < durationSec; t += intervalSec) stamps.push(Math.round(t * 1000));
  if (stamps.length === 0) stamps.push(0); // sub-interval take still yields frame zero

  const stills: TimelineStill[] = [];
  for (const ms of stamps) {
    const path = join(dir, `t_${String(ms).padStart(9, "0")}.jpg`);
    await runFF(["-y", "-ss", String(ms / 1000), "-i", masterPath, "-frames:v", "1", "-q:v", "3", path]);
    const sizeBytes = await Bun.file(path).size;
    if (sizeBytes === 0) continue; // no decodable frame at the stamp
    stills.push({ timestampMs: ms, path, sizeBytes });
  }
  return stills;
}

// one probe for the whole set: the fps of every still is identical
async function probeImage(path: string): Promise<{ width: number; height: number }> {
  const proc = Bun.spawn(
    [ffprobePath(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (code !== 0) throw new Error(`ffprobe failed on ${path}`);
  const stream = JSON.parse(out).streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error(`ffprobe reported no dimensions for ${path}`);
  }
  return { width, height };
}

// one frame at 1s; sub-1s recordings fall back to the very first frame
async function makeThumb(masterPath: string, thumbPath: string) {
  await runFF(["-y", "-ss", "1", "-i", masterPath, "-frames:v", "1", "-q:v", "2", thumbPath]);
  if ((await Bun.file(thumbPath).size) > 0) return;
  await runFF(["-y", "-ss", "0", "-i", masterPath, "-frames:v", "1", "-q:v", "2", thumbPath]);
}

async function runFF(args: string[]) {
  const proc = Bun.spawn([env.FFMPEG_PATH, ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).slice(-500);
    throw new Error(`ffmpeg (${args.join(" ")}) failed: ${err}`);
  }
}

// ffprobe sits next to the ffmpeg binary (FFMPEG_PATH .../ffmpeg -> .../ffprobe)
function ffprobePath() {
  return env.FFMPEG_PATH.endsWith("ffmpeg") ? env.FFMPEG_PATH.slice(0, -6) + "ffprobe" : "ffprobe";
}

// Retries exhausted: the session is terminally dead, not endlessly 'finalizing' —
// the app's poll loop sees finalization_failed and stops waiting. The domain
// row gets the same verdict so no phantom 'recording' survives.
export function finalizeExhausted(job: JobRow) {
  const session = tracker.getSession(job.session_id);
  if (session && session.status === "finalizing") {
    tracker.setStatus(session.id, "finalization_failed");
    log.error("finalization permanently failed", { session: session.id });
  }
  if (session?.storage_stem) {
    void markRecordingFailedByStem(session.storage_stem, "finalize retries exhausted");
  }
}

async function probeDurationMs(path: string): Promise<number> {
  const proc = Bun.spawn([ffprobePath(), "-v", "error", "-show_entries", "format=duration", "-of", "json", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (code !== 0) throw new Error(`ffprobe failed on ${path}`);
  const seconds = Number(JSON.parse(out).format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe reported no duration for ${path}`);
  return Math.round(seconds * 1000);
}
