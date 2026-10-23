// One bounded runner for every ffmpeg and ffprobe call in the server.
//
// A hung encoder is killed, never waited on. stdout comes back because ffprobe
// writes its answer there. stderr keeps only a tail for error text, but the
// discontinuity marker is read from every chunk, because an early warning falls
// out of the tail long before the process ends.
// flow: spawn > collect stdout + stderr tail + marker > kill at deadline or abort

import { spawn } from "node:child_process";

import { env } from "../config/env";

// Enough for a probe answer or a short log; never a decoded stream.
const STDOUT_CAP = 256 * 1024;
const STDERR_TAIL = 2_000;

export type FfmpegResult = {
  stdout: string;
  // true when ffmpeg reported a timestamp that went backwards
  nonMonotonous: boolean;
};

export type FfmpegOptions = {
  // aborts the run: the process is killed and the promise rejects
  signal?: AbortSignal;
};

const abortError = () => Object.assign(new Error("ffmpeg run aborted"), { name: "AbortError" });

// flow: spawn > bounded reads > settle once on exit, timeout, abort, or error
export const runFfmpegBounded = (
  command: string,
  args: string[],
  timeoutMs: number,
  options: FfmpegOptions = {},
): Promise<FfmpegResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let nonMonotonous = false;
    let settled = false;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ stdout, nonMonotonous });
    };

    const kill = (reason: Error) => {
      child.kill("SIGKILL");
      settle(reason);
    };

    const timer = setTimeout(
      () => kill(new Error(`${command} exceeded ${timeoutMs}ms and was killed`)),
      timeoutMs,
    );

    // an abort is a normal outcome for a cancelled export, not a fault
    const onAbort = () => kill(abortError());
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < STDOUT_CAP) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (/Non-monotonous DTS/i.test(text)) nonMonotonous = true;
      stderr = (stderr + text).slice(-STDERR_TAIL);
    });

    child.on("error", (error) => settle(error));
    child.on("close", (code) =>
      code === 0 ? settle() : settle(new Error(`${command} exited ${code}: ${stderr}`)),
    );
  });

// The probe answer on stdout, trimmed. Same bounds as the encoder runner.
export const runFfprobe = async (args: string[], timeoutMs: number, options?: FfmpegOptions) => {
  const result = await runFfmpegBounded(env.FFPROBE_PATH, args, timeoutMs, options);
  return result.stdout.trim();
};

// Duration in seconds, or null when the file cannot be read.
export const probeDurationSeconds = async (file: string, timeoutMs = 30_000) => {
  try {
    const answer = await runFfprobe(
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      timeoutMs,
    );
    const seconds = Number(answer);
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
};
