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
  test("a mid-length recording keeps the base interval", () => {
    const fiveMinutesMs = 300_000;

    expect(sampleIntervalMs(fiveMinutesMs, BASE_MS, MAX_SAMPLES)).toBe(BASE_MS);
    expect(pointCount(fiveMinutesMs, BASE_MS)).toBe(31);
  });

  // Ten seconds of footage on a ten-second grid is one tile, which reads as a
  // broken strip: short recordings refine instead.
  test("a short recording refines below the base interval", () => {
    const tenSecondsMs = 9_733;

    const intervalMs = sampleIntervalMs(tenSecondsMs, BASE_MS, MAX_SAMPLES);

    expect(intervalMs).toBe(1_250);
    expect(pointCount(tenSecondsMs, intervalMs)).toBeGreaterThanOrEqual(8);
  });

  // 10000 halves to 625 and stops: 625 is odd, so another half would be
  // fractional and would stop dividing the coarser grids.
  test("refinement stops at the last whole divisor", () => {
    const oneSecondMs = 1_000;

    const intervalMs = sampleIntervalMs(oneSecondMs, BASE_MS, MAX_SAMPLES);

    expect(intervalMs).toBe(625);
    expect(Number.isInteger(intervalMs)).toBe(true);
    expect(pointCount(oneSecondMs, intervalMs)).toBe(2);
  });

  test("refined grids still nest inside the coarser ones", () => {
    const intervalMs = sampleIntervalMs(9_733, BASE_MS, MAX_SAMPLES);

    // every 2.5 s point is also a 1.25 s point, so no stored still is orphaned
    for (let ms = 0; ms <= 10_000; ms += intervalMs * 2) {
      expect(ms % intervalMs).toBe(0);
    }
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

  // 10 s of footage refines to a 1.25 s grid: eight tiles, not one.
  test("a short recording is due a still every refined interval", () => {
    const due = dueSamples(segments(5), [], BASE_MS, MAX_SAMPLES);

    expect(due.map((row) => row.timestampMs)).toEqual([
      0, 1_250, 2_500, 3_750, 5_000, 6_250, 7_500, 8_750, 10_000,
    ]);
    expect(due[0]!.sequence).toBe(0);
    // 2.5 s falls inside the second segment (2 s to 4 s)
    expect(due[2]!.sequence).toBe(1);
  });

  test("stored stills are not due again", () => {
    // 60 s refines to a 5 s grid, with the first two points already stored
    const due = dueSamples(segments(30), [0, 10_000], BASE_MS, MAX_SAMPLES);

    expect(due.map((row) => row.timestampMs)).toEqual([
      5_000,
      15_000,
      20_000,
      25_000,
      30_000,
      35_000,
      40_000,
      45_000,
      50_000,
      55_000,
      60_000,
    ]);
  });

  test("each point names the segment that covers it", () => {
    // 60 s refines to 5 s: the first due point is 5 s, inside segment 2
    const due = dueSamples(segments(30), [0, 10_000], BASE_MS, MAX_SAMPLES);

    expect(due[0]!.timestampMs).toBe(5_000);
    expect(due[0]!.sequence).toBe(2);
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
