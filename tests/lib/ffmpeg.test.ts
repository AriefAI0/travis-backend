import { describe, expect, it } from "bun:test";

import { runFfmpegBounded } from "../../src/lib/ffmpeg";

// the runner is command-agnostic, so a node one-liner stands in for ffmpeg
const node = (script: string): [string, string[]] => [process.execPath, ["-e", script]];

describe("runFfmpegBounded", () => {
  it("returns stdout, where ffprobe writes its answer", async () => {
    const [command, args] = node("process.stdout.write('12.5\\n'); process.exit(0)");

    const result = await runFfmpegBounded(command, args, 5_000);

    expect(result).toEqual({ stdout: "12.5\n", nonMonotonous: false });
  });

  it("flags a non-monotonous DTS warning that falls out of the stderr tail", async () => {
    // the marker goes first, then enough noise to push it past the 2000-char tail
    const [command, args] = node(
      "process.stderr.write('Non-monotonous DTS in output stream 0:0\\n');" +
        "process.stderr.write('x'.repeat(4000)); process.exit(0)",
    );

    const result = await runFfmpegBounded(command, args, 5_000);

    expect(result.nonMonotonous).toBe(true);
  });

  it("keeps the exit code and the stderr tail in the error", async () => {
    const [command, args] = node("console.error('bad frame'); process.exit(3)");

    await expect(runFfmpegBounded(command, args, 5_000)).rejects.toThrow(/exited 3: .*bad frame/);
  });

  it("kills a hung run at the deadline", async () => {
    const [command, args] = node("setTimeout(() => {}, 60_000)");

    await expect(runFfmpegBounded(command, args, 200)).rejects.toThrow(/exceeded 200ms/);
  });

  it("kills the run when its signal aborts", async () => {
    const controller = new AbortController();
    const [command, args] = node("setTimeout(() => {}, 60_000)");

    const run = runFfmpegBounded(command, args, 60_000, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});
