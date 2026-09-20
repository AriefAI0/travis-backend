import { describe, expect, test } from "bun:test";

import {
  dueSamples,
  pointCount,
  sampleIntervalMs,
  type GridSegment,
} from "../../../src/features/recording/jobs/thumbnail-grid";

const BASE_MS = 10_000;
const MAX_SAMPLES = 300;

// `count` segments of `durationMs` each, sequenced from zero.
const segments = (count: number, durationMs = 2_000): GridSegment[] =>
  Array.from({ length: count }, (_, index) => ({ sequence: index, durationMs }));

describe("thumbnail grid interval", () => {
  test("a short recording keeps the base interval", () => {
    const fiveMinutesMs = 300_000;

    expect(sampleIntervalMs(fiveMinutesMs, BASE_MS, MAX_SAMPLES)).toBe(BASE_MS);
    expect(pointCount(fiveMinutesMs, BASE_MS)).toBe(31);
  });

  test("the interval doubles until the grid fits the budget", () => {
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;

    const intervalMs = sampleIntervalMs(fourDaysMs, BASE_MS, MAX_SAMPLES);
    // 10 s > 20 s > ... > 1280 s, the first that fits
    expect(intervalMs).toBe(1_280_000);
    expect(pointCount(fourDaysMs, intervalMs)).toBeLessThanOrEqual(MAX_SAMPLES);
    // and one step narrower would not have fitted
    expect(pointCount(fourDaysMs, intervalMs / 2)).toBeGreaterThan(MAX_SAMPLES);
  });

  test("grids stay nested, so a stored still is still a grid point", () => {
    // every point of the wide grid is also a point of the narrow one
    const narrow = new Set<number>();
    for (let ms = 0; ms <= 600_000; ms += BASE_MS) narrow.add(ms);

    for (let ms = 0; ms <= 600_000; ms += BASE_MS * 2) {
      expect(narrow.has(ms)).toBe(true);
    }
  });
});

describe("due samples", () => {
  test("an empty recording is due nothing", () => {
    expect(dueSamples([], [], BASE_MS, MAX_SAMPLES)).toEqual([]);
  });

  test("a short recording is due one still per base interval", () => {
    // 5 segments of 2 s = 10 s of footage: a point at zero and at the end
    const due = dueSamples(segments(5), [], BASE_MS, MAX_SAMPLES);

    expect(due.map((row) => row.timestampMs)).toEqual([0, 10_000]);
    expect(due[0]!.sequence).toBe(0);
  });

  test("stored stills are not due again", () => {
    // 60 s of footage, the first two points already stored
    const due = dueSamples(segments(30), [0, 10_000], BASE_MS, MAX_SAMPLES);

    expect(due.map((row) => row.timestampMs)).toEqual([20_000, 30_000, 40_000, 50_000, 60_000]);
  });

  test("each point names the segment that covers it", () => {
    // 60 s of footage: point 0 falls in segment 0, 20 s in segment 10
    const due = dueSamples(segments(30), [0, 10_000], BASE_MS, MAX_SAMPLES);

    expect(due[0]!.sequence).toBe(10);
    expect(due[0]!.timestampMs).toBe(20_000);
  });

  // Restart resume: only what the current grid is missing comes back.
  test("a wider grid does not re-ask for points it already has", () => {
    const long = segments(43_200, 2_000); // 24 h
    const storedAtBase = Array.from({ length: 500 }, (_, index) => index * BASE_MS);

    const due = dueSamples(long, storedAtBase, BASE_MS, MAX_SAMPLES);
    const intervalMs = sampleIntervalMs(24 * 60 * 60 * 1000, BASE_MS, MAX_SAMPLES);

    // every due point sits on the current grid
    expect(due.every((row) => row.timestampMs % intervalMs === 0)).toBe(true);
    // and none of them is one of the dense stills already stored
    expect(due.every((row) => row.timestampMs >= 500 * BASE_MS)).toBe(true);
  });

  test("the last point never falls past the end of the footage", () => {
    const due = dueSamples(segments(30), [], BASE_MS, MAX_SAMPLES);
    const totalMs = 30 * 2_000;

    expect(due.at(-1)!.timestampMs).toBeLessThanOrEqual(totalMs);
  });
});
