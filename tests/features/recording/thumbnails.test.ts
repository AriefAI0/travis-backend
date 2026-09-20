// Async thumbnails: sampling, dated keys, a bounded FFmpeg run, and the rule
// that nothing here can break playback.
//
// FFmpeg is faked, except in the bounded-runner cases where a real child
// process proves the deadline actually kills it.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import {
  enqueueThumbnails,
  filmstripSampleIndexes,
  pendingThumbnailJobs,
  runFfmpegBounded,
  runThumbnailJob,
  type ThumbnailDeps,
} from "../../../src/features/recording/jobs/thumbnails";
import type { ThumbnailSource } from "../../../src/db/services/recording-thumbnail.service";

const SCOPE = {
  organizationId: 1,
  projectId: 2,
  sessionId: 3,
  startedAt: new Date("2026-09-20T00:00:00.000Z"),
};

const source = (segmentCount: number): ThumbnailSource => ({
  masterVideoId: 7,
  scope: SCOPE,
  durationMs: segmentCount * 2_000,
  segments: Array.from({ length: segmentCount }, (_, index) => ({
    sequence: index,
    objectKey: `1/2/3/2026/09/20/master/7/segments/${String(index).padStart(10, "0")}.ts`,
    durationMs: 2_000,
  })),
});

// A fake FFmpeg that writes a byte per still, so sizes are observable.
function fakeDeps(
  loaded: ThumbnailSource | null,
  overrides: Partial<ThumbnailDeps> = {},
): { deps: ThumbnailDeps; stored: Array<{ key: string; size: number }>; rows: unknown[][] } {
  const stored: Array<{ key: string; size: number }> = [];
  const rows: unknown[][] = [];
  const deps: ThumbnailDeps = {
    loadSource: async () => loaded,
    runFfmpeg: async (_command, args) => {
      const file = args.at(-1)!;
      await Bun.write(file, new Uint8Array([0xff, 0xd8, 0xff]));
    },
    fetchSegment: async (_objectKey, destination) => {
      await Bun.write(destination, new Uint8Array([0x47, 0x00, 0x10]));
    },
    putObject: async (key, body) => {
      stored.push({ key, size: body.byteLength });
    },
    recordRows: async (created) => {
      rows.push(created);
      return created.length;
    },
    ...overrides,
  };
  return { deps, stored, rows };
}

describe("thumbnail sampling", () => {
  test("takes every segment when the cap allows", () => {
    expect(filmstripSampleIndexes(3, 20)).toEqual([0, 1, 2]);
  });

  test("spreads a capped sample across the whole recording", () => {
    // 100 segments, 4 stills: even spread, never clustered at the start.
    expect(filmstripSampleIndexes(100, 4)).toEqual([0, 25, 50, 75]);
  });

  test("answers nothing for an empty recording or a zero cap", () => {
    expect(filmstripSampleIndexes(0, 10)).toEqual([]);
    expect(filmstripSampleIndexes(10, 0)).toEqual([]);
  });
});

describe("thumbnail job", () => {
  test("writes the poster and stills at dated keys, then the rows", async () => {
    const { deps, stored, rows } = fakeDeps(source(4));

    const result = await runThumbnailJob(7, deps);

    expect(result).toMatchObject({ masterVideoId: 7, posterStored: true, stills: 4, skipped: false });
    // Dated keys: the scope's date, the target, and the filmstrip's padded ms.
    expect(stored[0]!.key).toBe("1/2/3/2026/09/20/master/7/poster.jpg");
    expect(stored.slice(1).map((entry) => entry.key)).toEqual([
      "1/2/3/2026/09/20/master/7/timeline/000000000.jpg",
      "1/2/3/2026/09/20/master/7/timeline/000002000.jpg",
      "1/2/3/2026/09/20/master/7/timeline/000004000.jpg",
      "1/2/3/2026/09/20/master/7/timeline/000006000.jpg",
    ]);
    // The stills' timestamps come from the segments' measured lengths.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(4);
  });

  test("reads only the sampled segments", async () => {
    const fetched: string[] = [];
    const { deps } = fakeDeps(source(100), {
      fetchSegment: async (objectKey) => {
        fetched.push(objectKey);
      },
    });

    const result = await runThumbnailJob(7, deps);

    expect(result.stills).toBe(20); // the default cap
    expect(fetched).toHaveLength(20);
  });

  test("skips a master with nothing to read", async () => {
    const { deps, stored } = fakeDeps(null);

    const result = await runThumbnailJob(7, deps);

    expect(result).toEqual({ masterVideoId: 7, posterStored: false, stills: 0, skipped: true });
    expect(stored).toEqual([]);
  });

  // Acceptance: an error leaves playback working. Playback reads segment
  // rows, so the job only has to stop quietly and keep what did land.
  test("keeps the stills a failing frame did not cost", async () => {
    let calls = 0;
    const { deps, stored, rows } = fakeDeps(source(3), {
      runFfmpeg: async (_command, args) => {
        calls += 1;
        if (calls === 1) throw new Error("ffmpeg exited 1: bad frame");
        const file = args.at(-1)!;
        await Bun.write(file, new Uint8Array([0xff, 0xd8, 0xff]));
      },
    });

    const result = await runThumbnailJob(7, deps);

    // The first still failed, the rest landed, and nothing threw.
    expect(result).toMatchObject({ stills: 2, posterStored: true });
    expect(stored.map((entry) => entry.key)).toContain("1/2/3/2026/09/20/master/7/poster.jpg");
    expect(rows[0]).toHaveLength(2);
  });

  test("survives every frame failing", async () => {
    const { deps, stored, rows } = fakeDeps(source(2), {
      runFfmpeg: async () => {
        throw new Error("ffmpeg exited 1: no video stream");
      },
    });

    const result = await runThumbnailJob(7, deps);

    expect(result).toMatchObject({ stills: 0, posterStored: false, skipped: false });
    expect(stored).toEqual([]);
    // No stills means no rows, and the master still plays.
    expect(rows).toEqual([[]]);
  });

  test("survives an upload that refuses", async () => {
    const { deps, rows } = fakeDeps(source(2), {
      putObject: async () => {
        throw new Error("storage unavailable");
      },
    });

    await expect(runThumbnailJob(7, deps)).rejects.toThrow("storage unavailable");
    // No rows land, so the boot scan re-derives this master on the next start.
    expect(rows).toEqual([]);
  });

  test("removes its temporary directory", async () => {
    let directory = "";
    const { deps } = fakeDeps(source(1), {
      fetchSegment: async (_objectKey, destination) => {
        directory = destination.replace(/[\\/][^\\/]+$/, "");
        await Bun.write(destination, new Uint8Array([0x47]));
      },
    });

    await runThumbnailJob(7, deps);

    expect(directory).not.toBe("");
    expect(existsSync(directory)).toBe(false);
  });
});

describe("bounded FFmpeg", () => {
  test("resolves a clean run", async () => {
    await expect(runFfmpegBounded(process.execPath, ["-e", "process.exit(0)"], 5_000)).resolves.toBeUndefined();
  });

  test("rejects a non-zero exit with its stderr", async () => {
    await expect(
      runFfmpegBounded(process.execPath, ["-e", "console.error('bad frame'); process.exit(3)"], 5_000),
    ).rejects.toThrow(/exited 3: .*bad frame/s);
  });

  // Acceptance: the timeout kills the process rather than waiting on it.
  test("kills a run that outlives its deadline", async () => {
    const started = Date.now();
    await expect(
      runFfmpegBounded(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], 200),
    ).rejects.toThrow(/exceeded 200ms and was killed/);
    // The deadline is the whole wait, not the child's 60 seconds.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("thumbnail queue", () => {
  // Acceptance: one master close creates one job. The second request arrives
  // while the first is still running, which is the case the queue must catch.
  test("drops a repeat request for a master already running", async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps } = fakeDeps(null, {
      loadSource: async () => {
        loads += 1;
        await gate;
        return null;
      },
    });

    enqueueThumbnails(7, deps);
    enqueueThumbnails(7, deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loads).toBe(1);
    expect(pendingThumbnailJobs()).toBe(1);

    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pendingThumbnailJobs()).toBe(0);
  });

  // A different master is a different job, not a duplicate.
  test("runs a second master after the first settles", async () => {
    const loaded: number[] = [];
    const { deps } = fakeDeps(null, {
      loadSource: async (masterVideoId) => {
        loaded.push(masterVideoId);
        return null;
      },
    });

    enqueueThumbnails(7, deps);
    enqueueThumbnails(8, deps);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(loaded.sort((a, b) => a - b)).toEqual([7, 8]);
    expect(pendingThumbnailJobs()).toBe(0);
  });
});
