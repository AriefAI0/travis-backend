// The filmstrip grid.
//
// A recording grows, so a fixed interval cannot hold: one still per base
// interval, doubled as the recording outgrows the sample budget and refined
// below the base while it is still short. One interval family either way, so the
// grids nest — a still written for the 10 s grid is still a grid point at 20 s,
// 40 s — and nothing already stored is ever wasted.
//
// flow: total length > widest interval that fits > grid points > due points

export type GridSegment = {
  sequence: number;
  durationMs: number;
};

export type GridSample = {
  timestampMs: number;
  // The segment covering this grid point: what a still is taken from.
  sequence: number;
};

// How many points a grid of this interval would hold, inclusive of zero.
export const pointCount = (totalMs: number, intervalMs: number): number =>
  intervalMs > 0 && totalMs >= 0 ? Math.floor(totalMs / intervalMs) + 1 : 0;

// A recording shorter than this many tiles gets a finer grid: one still per ten
// seconds leaves a ten-second recording with a single tile, which is not a
// filmstrip. Refining halves the interval while it stays an exact divisor.
export const MIN_GRID_SAMPLES = 8;

// The interval that fits the budget, refined for short recordings. Doubling and
// halving only ever land on divisors of the base, so the grids nest: a still
// written for one interval stays a grid point for every coarser one.
export const sampleIntervalMs = (
  totalMs: number,
  baseIntervalMs: number,
  maxSamples: number,
): number => {
  let intervalMs = baseIntervalMs;

  while (pointCount(totalMs, intervalMs) > maxSamples) {
    intervalMs *= 2;
  }

  // An odd interval cannot halve again, which is the floor for a base that is
  // only divisible by two so many times (10000 down to 625).
  while (pointCount(totalMs, intervalMs) < MIN_GRID_SAMPLES && intervalMs % 2 === 0) {
    intervalMs /= 2;
  }

  return intervalMs;
};

// Grid points with no still stored yet, in time order.
export const dueSamples = (
  segments: GridSegment[],
  existingTimestamps: number[],
  baseIntervalMs: number,
  maxSamples: number,
): GridSample[] => {
  if (segments.length === 0) return [];

  const totalMs = segments.reduce((sum, row) => sum + row.durationMs, 0);
  const intervalMs = sampleIntervalMs(totalMs, baseIntervalMs, maxSamples);
  const stored = new Set(existingTimestamps);

  const due: GridSample[] = [];
  // One pointer across both lists: segments and grid points both ascend.
  let cursor = 0;
  let segmentStartMs = 0;

  for (let timestampMs = 0; timestampMs <= totalMs; timestampMs += intervalMs) {
    while (
      cursor < segments.length - 1 &&
      timestampMs >= segmentStartMs + segments[cursor]!.durationMs
    ) {
      segmentStartMs += segments[cursor]!.durationMs;
      cursor += 1;
    }

    if (stored.has(timestampMs)) continue;
    due.push({ timestampMs, sequence: segments[cursor]!.sequence });
  }

  return due;
};
