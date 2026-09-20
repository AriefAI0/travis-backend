// Thumbnails written while a recording runs: the grid, dated keys, clip stills,
// a bounded FFmpeg run, and the rule that nothing here can break playback.
//
// FFmpeg is faked, except in the bounded-runner cases where a real child
// process proves the deadline actually kills it.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import {
  enqueueClipStill,
  enqueueThumbnails,
  pendingThumbnailJobs,
  resetThumbnailQueue,
  runClipStillJob,
  runFfmpegBounded,
  runThumbnailJob,
  type ThumbnailDeps,
} from "../../../src/features/recording/jobs/thumbnails";
import type {
  ClipStillSource,
  ThumbnailSource,
} from "../../../src/db/services/recording-thumbnail.service";
import { env } from "../../../src/config/env";

// the readable directory admission freezes on the ingest row
const KEY_PREFIX = "2-platform-north-2026-09-20/session-3-2026-09-20-0000/master-video";
const CLIP_PREFIX = "2-platform-north-2026-09-20/session-3-2026-09-20-0000/clips/455-anode-14-gvi";

const source = (
  segmentCount: number,
  options: { closed?: boolean; existingTimestamps?: number[] } = {},
): ThumbnailSource => ({
  masterVideoId: 7,
  keyPrefix: KEY_PREFIX,
  durationMs: segmentCount * 2_000,
  closed: options.closed ?? true,
  existingTimestamps: options.existingTimestamps ?? [],
  segments: Array.from({ length: segmentCount }, (_, index) => ({
    sequence: index,
    objectKey: `${KEY_PREFIX}/segments/${String(index).padStart(10, "0")}.ts`,
    durationMs: 2_000,
  })),
});

const clipSource = (): ClipStillSource => ({
  clipId: 5,
  keyPrefix: CLIP_PREFIX,
  firstSegmentObjectKey: `${CLIP_PREFIX}/segments/0000000000.ts`,
});

type Fake = {
  deps: ThumbnailDeps;
  stored: Array<{ key: string; size: number }>;
  rows: unknown[][];
  clipStills: Array<{ clipId: number; thumbnailKey: string }>;
  fetched: string[];
};

// A fake FFmpeg that writes a byte per still, so sizes are observable.
function fakeDeps(
  loaded: ThumbnailSource | null,
  overrides: Partial<ThumbnailDeps> = {},
): Fake {
  const stored: Array<{ key: string; size: number }> = [];
  const rows: unknown[][] = [];
  const clipStills: Array<{ clipId: number; thumbnailKey: string }> = [];
  const fetched: string[] = [];
  const deps: ThumbnailDeps = {
    loadSource: async () => loaded,
    loadClipSource: async () => null,
    runFfmpeg: async (_command, args) => {
      const file = args.at(-1)!;
      await Bun.write(file, new Uint8Array([0xff, 0xd8, 0xff]));
    },
    fetchSegment: async (objectKey, destination) => {
      fetched.push(objectKey);
      await Bun.write(destination, new Uint8Array([0x47, 0x00, 0x10]));
    },
    putObject: async (key, body) => {
      stored.push({ key, size: body.byteLength });
    },
    recordRows: async (created) => {
      rows.push(created);
      return created.length;
    },
    recordClipStill: async (clipId, thumbnailKey) => {
      clipStills.push({ clipId, thumbnailKey });
    },
    ...overrides,
  };
  return { deps, stored, rows, clipStills, fetched };
}

describe("thumbnail job", () => {
  test("writes the poster and the grid stills at dated keys, then the rows", async () => {
    // 80 s of footage: nine points on the 10 s grid, plus the closed poster
    const { deps, stored, rows } = fakeDeps(source(40));

    const result = await runThumbnailJob(7, deps);

    expect(result).toMatchObject({
      masterVideoId: 7,
      posterStored: true,
      stills: 9,
      skipped: false,
    });
    // Frozen prefix, then the poster name and the filmstrip's padded ms.
    expect(stored[0]!.key).toBe(`${KEY_PREFIX}/thumbnail.jpg`);
    expect(stored[1]!.key).toBe(`${KEY_PREFIX}/timeline/000000000.jpg`);
    expect(stored.at(-1)!.key).toBe(`${KEY_PREFIX}/timeline/000080000.jpg`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(9);
  });

  // Ten seconds of footage on a ten-second grid is one tile, which reads as a
  // broken strip: short recordings refine instead.
  test("a short recording refines to a usable strip", async () => {
    const { deps, stored } = fakeDeps(source(5, { closed: false }));

    const result = await runThumbnailJob(7, deps);

    expect(result.stills).toBe(9);
    expect(stored.map((entry) => entry.key.replace(/^.*timeline\//, ""))).toEqual([
      "000000000.jpg",
      "000001250.jpg",
      "000002500.jpg",
      "000003750.jpg",
      "000005000.jpg",
      "000006250.jpg",
      "000007500.jpg",
      "000008750.jpg",
      "000010000.jpg",
    ]);
  });

  test("one still per interval across the recording", async () => {
    // 80 s of footage on the base 10 s grid: nine points, zero through eighty
    const { deps, stored } = fakeDeps(source(40));

    const result = await runThumbnailJob(7, deps);

    expect(result.stills).toBe(9);
    expect(stored[1]!.key).toBe(`${KEY_PREFIX}/timeline/000000000.jpg`);
    expect(stored[2]!.key).toBe(`${KEY_PREFIX}/timeline/000010000.jpg`);
    expect(stored.at(-1)!.key).toBe(`${KEY_PREFIX}/timeline/000080000.jpg`);
  });

  // Restart resume and re-runs: only the points the grid is missing come back.
  test("does not repeat a grid point that already has a still", async () => {
    const { deps, rows } = fakeDeps(source(40, { existingTimestamps: [0, 10_000] }));

    const result = await runThumbnailJob(7, deps);

    expect(result.stills).toBe(7);
    expect(
      (rows[0] as Array<{ timestampMs: number }>).map((row) => row.timestampMs),
    ).toEqual([20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000]);
  });

  // Each row's stem is the key its object landed at, so a read rebuilds it.
  test("stores the filmstrip key as the row's stem", async () => {
    const { deps, stored, rows } = fakeDeps(source(40));

    await runThumbnailJob(7, deps);

    const stillKeys = stored.slice(1).map((entry) => entry.key);
    expect(rows[0]!.map((row) => (row as { storageStem: string }).storageStem)).toEqual(stillKeys);
  });

  // While a capture runs there is no face to freeze yet: stills only.
  test("an open master gets grid stills and no poster", async () => {
    const { deps, stored } = fakeDeps(source(40, { closed: false }));

    const result = await runThumbnailJob(7, deps);

    expect(result).toMatchObject({ posterStored: false, stills: 9, skipped: false });
    expect(stored.map((entry) => entry.key)).not.toContain(`${KEY_PREFIX}/thumbnail.jpg`);
  });

  test("reads only the segments its due points land in", async () => {
    const { deps, fetched } = fakeDeps(source(40));

    await runThumbnailJob(7, deps);

    // 0 s > segment 0, 10 s > 5, 20 s > 10, ... 80 s clamps to the last one
    const sequences = fetched.map((key) => Number(key.match(/(\d{10})\.ts$/)![1]));
    expect(sequences).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 39]);
  });

  // A master recorded before the readable layout keeps writing its old keys.
  test("a backfilled numeric prefix mints the legacy key shape", async () => {
    const legacy = "1/1/214/2023/11/14/master/364";
    const { deps, stored } = fakeDeps({ ...source(40), keyPrefix: legacy });

    await runThumbnailJob(7, deps);

    expect(stored[0]!.key).toBe(`${legacy}/thumbnail.jpg`);
    expect(stored[1]!.key).toBe(`${legacy}/timeline/000000000.jpg`);
    // poster plus nine stills, all under the legacy prefix
    expect(stored).toHaveLength(10);
  });

  test("skips a master with nothing to read", async () => {
    const { deps, stored, rows } = fakeDeps(null);

    const result = await runThumbnailJob(7, deps);

    expect(result).toEqual({ masterVideoId: 7, posterStored: false, stills: 0, skipped: true });
    expect(stored).toEqual([]);
    expect(rows).toEqual([]);
  });

  // Acceptance: an error leaves playback working. Playback reads segment
  // rows, so the job only has to stop quietly and keep what did land.
  test("keeps the stills a failing frame did not cost", async () => {
    let calls = 0;
    const { deps, stored, rows } = fakeDeps(source(40), {
      runFfmpeg: async (_command, args) => {
        calls += 1;
        if (calls === 1) throw new Error("ffmpeg exited 1: bad frame");
        const file = args.at(-1)!;
        await Bun.write(file, new Uint8Array([0xff, 0xd8, 0xff]));
      },
    });

    const result = await runThumbnailJob(7, deps);

    // The first still failed, the rest landed, and nothing threw.
    expect(result).toMatchObject({ stills: 8, posterStored: true });
    expect(stored.map((entry) => entry.key)).toContain(`${KEY_PREFIX}/thumbnail.jpg`);
    expect(rows[0]).toHaveLength(8);
  });

  test("survives every frame failing", async () => {
    const { deps, stored, rows } = fakeDeps(source(40), {
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
    const { deps, rows } = fakeDeps(source(40), {
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

describe("clip still job", () => {
  test("takes one still from the clip's first segment and records its key", async () => {
    const { deps, stored, clipStills, fetched } = fakeDeps(null, {
      loadClipSource: async () => clipSource(),
    });

    const result = await runClipStillJob(5, deps);

    expect(result).toEqual({ clipId: 5, stillStored: true, skipped: false });
    expect(fetched).toEqual([`${CLIP_PREFIX}/segments/0000000000.ts`]);
    expect(stored).toEqual([{ key: `${CLIP_PREFIX}/thumbnail.jpg`, size: 3 }]);
    expect(clipStills).toEqual([
      { clipId: 5, thumbnailKey: `${CLIP_PREFIX}/thumbnail.jpg` },
    ]);
  });

  test("skips a clip with no sealed segment", async () => {
    const { deps, stored } = fakeDeps(null);

    const result = await runClipStillJob(5, deps);

    expect(result).toEqual({ clipId: 5, stillStored: false, skipped: true });
    expect(stored).toEqual([]);
  });

  test("a frame that cannot be read leaves no key on the clip", async () => {
    const { deps, clipStills } = fakeDeps(null, {
      loadClipSource: async () => clipSource(),
      runFfmpeg: async () => {
        throw new Error("ffmpeg exited 1: no video stream");
      },
    });

    const result = await runClipStillJob(5, deps);

    expect(result).toEqual({ clipId: 5, stillStored: false, skipped: false });
    expect(clipStills).toEqual([]);
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
  // The queue is module state shared with every other importing test file, so
  // these tests wait on their own calls and use ids nothing else touches.
  beforeEach(resetThumbnailQueue);

  const waitFor = async (ready: () => boolean, timeoutMs = 3_000): Promise<void> => {
    const startedAt = Date.now();

    while (!ready() && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  // A source that records each run, and holds the ones the predicate picks.
  const gatedDeps = (runs: number[], gate: (masterVideoId: number) => boolean) => {
    const held: Array<() => void> = [];
    const { deps } = fakeDeps(null, {
      loadSource: async (masterVideoId) => {
        runs.push(masterVideoId);
        if (gate(masterVideoId)) {
          await new Promise<void>((resolve) => held.push(resolve));
        }
        return null;
      },
    });

    return {
      deps,
      releaseAll: (): void => {
        while (held.length > 0) held.pop()!();
      },
    };
  };

  test("a repeat ask for a recording that is already waiting runs it once", async () => {
    const runs: number[] = [];
    // Fillers hold every slot, so the target really has to wait its turn.
    const { deps, releaseAll } = gatedDeps(runs, () => true);
    const fillers = Array.from({ length: env.FFMPEG_CONCURRENCY }, (_, index) => 900_100 + index);

    for (const filler of fillers) {
      enqueueThumbnails(filler, deps);
    }
    await waitFor(() => runs.length === fillers.length);

    enqueueThumbnails(900_001, deps);
    enqueueThumbnails(900_001, deps);

    releaseAll();
    await waitFor(() => pendingThumbnailJobs() === 0);

    expect(runs.filter((id) => id === 900_001)).toHaveLength(1);
  });

  // Acceptance: a segment landing while a run is in flight must not be lost.
  // The run in flight derived its due set before that segment arrived.
  test("queues one more run for a recording asked again while it runs", async () => {
    const runs: number[] = [];
    // Only the first run is held, so the requeue runs straight after it.
    const { deps, releaseAll } = gatedDeps(runs, () => runs.length === 1);

    enqueueThumbnails(900_003, deps);
    await waitFor(() => runs.length === 1);
    // the ask lands while run one is still in flight
    enqueueThumbnails(900_003, deps);
    releaseAll();

    await waitFor(() => pendingThumbnailJobs() === 0);

    expect(runs).toEqual([900_003, 900_003]);
  });

  test("runs two different recordings without dropping either", async () => {
    const runs: number[] = [];
    const { deps } = gatedDeps(runs, () => false);

    enqueueThumbnails(900_004, deps);
    enqueueThumbnails(900_005, deps);
    await waitFor(() => pendingThumbnailJobs() === 0);

    expect(runs.sort((a, b) => a - b)).toEqual([900_004, 900_005]);
  });

  test("a clip still runs on its own turn", async () => {
    const runs: string[] = [];
    const { deps } = fakeDeps(null, {
      loadClipSource: async () => {
        runs.push("clip");
        return null;
      },
    });

    enqueueClipStill(900_006, deps);
    await waitFor(() => pendingThumbnailJobs() === 0);

    expect(runs).toEqual(["clip"]);
  });
});
