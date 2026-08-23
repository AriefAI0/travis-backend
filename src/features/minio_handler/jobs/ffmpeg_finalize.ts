import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../../config/env";
import { log } from "../../../lib/logger";
import { tracker, type JobRow } from "../../../lib/db/minio_tracker";
import { minio } from "../../../lib/minio_storage/clients";
import { clipLeaves, masterLeaves } from "../paths";

// flow: download master > remux mkv > probe duration > single-file hls >
// thumbnail > upload all > mark finalized. Stream-copy only (spec D9).
export async function finalizeJob(job: JobRow) {
  const session = tracker.getSession(job.session_id);
  if (!session || session.status === "finalized") return; // gone or already done: idempotent
  if (!session.bucket || !session.object_key) throw new Error(`session ${job.session_id} has no object target`);

  const dir = join(env.DATA_DIR, "tmp", session.id);
  await mkdir(dir, { recursive: true });
  try {
    const leaves = session.kind === "master" ? masterLeaves(session.object_key) : clipLeaves(session.object_key);
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

    // upload all four; overwrites make retries idempotent
    await minio.fPutObject(leaves.mkv.bucket, leaves.mkv.key, mkvPath, { "Content-Type": "video/x-matroska" });
    await minio.fPutObject(leaves.hlsManifest.bucket, leaves.hlsManifest.key, manifestPath, { "Content-Type": "application/vnd.apple.mpegurl" });
    await minio.fPutObject(leaves.hlsMedia.bucket, leaves.hlsMedia.key, mediaPath, { "Content-Type": "video/mp2t" });
    await minio.fPutObject(leaves.poster.bucket, leaves.poster.key, thumbPath, { "Content-Type": "image/jpeg" });

    tracker.setFinalized(session.id, durationMs);
    log.info("finalize complete", { session: session.id, durationMs });
  } finally {
    await rm(dir, { recursive: true, force: true }); // temp never outlives the job
  }
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
// the app's poll loop sees finalization_failed and stops waiting.
export function finalizeExhausted(job: JobRow) {
  const session = tracker.getSession(job.session_id);
  if (session && session.status === "finalizing") {
    tracker.setStatus(session.id, "finalization_failed");
    log.error("finalization permanently failed", { session: session.id });
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
