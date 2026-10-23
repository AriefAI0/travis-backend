import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  mergeClip,
  remuxDeps,
  resetRemuxDeps,
  type RemuxSegment,
} from "../../../src/features/recording/jobs/remux";

// the merge runs real ffmpeg; without it the whole file is meaningless
const ffmpegAvailable = Bun.which("ffmpeg") !== null;

let source: string;
let sourceBytes: Buffer;
let sourceSha: string;
let scratch: string;

// one second of mpeg-ts, the shape a stored segment has
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "remux-test-"));
  source = path.join(scratch, "segment.ts");
  const made = Bun.spawn(
    [
      "ffmpeg", "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10",
      "-c:v", "libx264", "-preset", "ultrafast",
      "-f", "mpegts", source,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await made.exited;
  sourceBytes = Buffer.from(await readFile(source));
  sourceSha = createHash("sha256").update(sourceBytes).digest("hex");
});

beforeEach(() => resetRemuxDeps());

const segments = (count: number): RemuxSegment[] =>
  Array.from({ length: count }, (_, index) => ({
    sequence: index,
    objectKey: `seg/${index}.ts`,
    checksumSha256: sourceSha,
    sizeBytes: sourceBytes.length,
    durationMs: 1000,
    discontinuity: false,
  }));

const fakeIngest = (overrides: Record<string, unknown> = {}) => ({
  ingestId: 42,
  keyPrefix: "org/session/clips/1-gvi",
  closedAt: new Date(),
  finalSequence: 99,
  ...overrides,
});

describe.skipIf(!ffmpegAvailable)("clip merge", () => {
  it("copies a clean clip and caches it", async () => {
    const stored = new Map<string, string>();
    let cached = null as null | { ingestId: number; segmentCount: number; objectKey: string; sizeBytes: number };

    remuxDeps.pickIngest = async () => fakeIngest() as never;
    remuxDeps.listSegments = async () => segments(2);
    remuxDeps.fetchSegment = async (_key, destination) => void (await writeFile(destination, sourceBytes));
    remuxDeps.putObject = async (key, file) => void stored.set(key, file);
    remuxDeps.cacheHit = async () => null;
    remuxDeps.cacheStore = async (values) => {
      cached = values;
      return [];
    };

    const result = await mergeClip(900, scratch);

    expect(result.status).toBe("ok");
    expect(result.step).toBe("copy");
    expect(result.key).toBe("org/session/clips/1-gvi/exports/merged-2.mkv");
    expect(stored.size).toBe(1);
    expect(cached).toMatchObject({ ingestId: 42, segmentCount: 2 });
    expect(result.durationMs).toBeGreaterThan(1500);
  }, 60_000);

  it("reports a corrupt segment as partial, never as a silent gap", async () => {
    remuxDeps.pickIngest = async () => fakeIngest() as never;
    remuxDeps.listSegments = async () => segments(2);
    remuxDeps.fetchSegment = async (_key, destination) =>
      void (await writeFile(destination, Buffer.from("not a segment")));
    remuxDeps.cacheHit = async () => null;
    remuxDeps.cacheStore = async () => [];
    remuxDeps.putObject = async () => {};

    const result = await mergeClip(900, scratch);

    expect(result.status).toBe("partial");
    expect(result.error).toContain("segment 0 never arrived");
  }, 120_000);

  it("merges only the segments up to the frozen final sequence", async () => {
    let asked: number | null | undefined;
    remuxDeps.pickIngest = async () => fakeIngest({ finalSequence: 0 }) as never;
    remuxDeps.listSegments = async (_id, upTo) => {
      asked = upTo;
      // the store still holds a later segment; the cap keeps it out
      return segments(1);
    };
    remuxDeps.fetchSegment = async (_key, destination) => void (await writeFile(destination, sourceBytes));
    remuxDeps.cacheHit = async () => null;
    remuxDeps.cacheStore = async () => [];
    remuxDeps.putObject = async () => {};

    const result = await mergeClip(900, scratch);

    expect(asked).toBe(0);
    expect(result.status).toBe("ok");
    expect(result.durationMs).toBeLessThan(1500);
  }, 60_000);

  it("exports an open ingest as partial and caches nothing", async () => {
    let cachedCalls = 0;
    remuxDeps.pickIngest = async () => fakeIngest({ closedAt: null, finalSequence: null }) as never;
    remuxDeps.listSegments = async () => segments(1);
    remuxDeps.fetchSegment = async (_key, destination) => void (await writeFile(destination, sourceBytes));
    remuxDeps.cacheHit = async () => null;
    remuxDeps.cacheStore = async () => {
      cachedCalls++;
      return [];
    };
    remuxDeps.putObject = async () => {};

    const result = await mergeClip(900, scratch);

    expect(result.status).toBe("partial");
    expect(cachedCalls).toBe(0);
  }, 60_000);

  it("skips a clip with no segments", async () => {
    remuxDeps.pickIngest = async () => fakeIngest() as never;
    remuxDeps.listSegments = async () => [];

    const result = await mergeClip(900, scratch);

    expect(result.status).toBe("skipped");
  }, 30_000);

  it("takes a cache hit without fetching anything", async () => {
    let fetched = 0;
    remuxDeps.pickIngest = async () => fakeIngest() as never;
    remuxDeps.listSegments = async () => segments(2);
    remuxDeps.fetchSegment = async () => void fetched++;
    remuxDeps.cacheHit = async () => ({ key: "cached.mkv", sizeBytes: 1234 });

    const result = await mergeClip(900, scratch);

    expect(result.step).toBe("cache");
    expect(fetched).toBe(0);
    expect(result.sizeBytes).toBe(1234);
  }, 30_000);
});

afterAll(async () => {
  // the scratch tree lives under the OS temp directory
  expect(await stat(scratch).catch(() => null)).not.toBeNull();
});
