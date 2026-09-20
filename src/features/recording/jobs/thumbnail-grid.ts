// The filmstrip grid.
//
// A recording grows, so a fixed interval cannot hold: one still per base
// interval while the count fits the budget, then the interval doubles. Doubling
// keeps the grids nested — a still written for the 10 s grid is still a grid
// point at 20 s, 40 s — so nothing already stored is ever wasted and an
// obsolete pending point is simply not due any more.
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

// The narrowest interval whose point count still fits the budget.
export const sampleIntervalMs = (
  totalMs: number,
  baseIntervalMs: number,
  maxSamples: number,
): number => {
  let intervalMs = baseIntervalMs;
  while (pointCount(totalMs, intervalMs) > maxSamples) {
    intervalMs *= 2;
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
