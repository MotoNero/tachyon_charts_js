// Finds the point of a series nearest to a position (SeriesHitTester of the .NET version, without the indexes, which
// come with the large data: sorted X is searched by halves, other data scanned).
import type { PointSource } from '../data/source';
import type { SeriesFrame } from '../pipeline/chart-series';
import type { ChartSeries } from '../pipeline/chart-series';
import { lowerBound } from '../resampling/min-max-decimator';
import type { FoundPoint, HitTestMode } from './types';

export type { FoundPoint, HitTestMode } from './types';

/** A point found under a position. */
export interface HitResult extends FoundPoint {
  /** The series the point belongs to. */
  readonly series: ChartSeries;
  /** The distance to the position in device-independent units. */
  readonly distance: number;
}

/**
 * The point of a source nearest to a pixel position within `maximumDistance` pixels, measured in pixels of the frame.
 * NaN and ±∞ are never found. With sorted X it searches outwards from the X of the position and stops as soon as X
 * alone is too far.
 */
export function findNearest(
  source: PointSource,
  origin: number,
  frame: SeriesFrame,
  pixelX: number,
  pixelY: number,
  maximumDistance: number,
  mode: HitTestMode,
): FoundPoint | undefined {
  const snapshot = source.snapshot();
  const { x, y, count } = snapshot;
  const state = { best: maximumDistance * maximumDistance, index: -1 };
  const measure = (i: number): number => {
    const value = y[i] as number;
    const dx = frame.x.toPixel((x[i] as number) - origin) - pixelX;
    const dy = mode === 'nearestX' ? 0 : frame.y.toPixel(value) - pixelY;
    return Number.isFinite(value) ? dx * dx + dy * dy : Number.POSITIVE_INFINITY;
  };
  const consider = (i: number): void => {
    const distance = measure(i);
    // Of two points at the same distance the earlier one wins, as in the .NET version.
    if (distance < state.best || (distance === state.best && state.index >= 0 && i < state.index)) {
      state.best = distance;
      state.index = i;
    }
  };
  if (snapshot.metadata.isSortedX && frame.x.isLinear) {
    const start = lowerBound(x, count, frame.x.toData(pixelX) + origin);
    const xFar = (i: number): boolean => {
      const dx = frame.x.toPixel((x[i] as number) - origin) - pixelX;
      return dx * dx > state.best;
    };
    for (let i = start - 1; i >= 0 && !xFar(i); i--) {
      consider(i);
    }
    for (let i = start; i < count && !xFar(i); i++) {
      consider(i);
    }
  } else {
    for (let i = 0; i < count; i++) {
      consider(i);
    }
  }
  if (state.index < 0) {
    return undefined;
  }
  return { index: state.index, x: (x[state.index] as number) - origin, y: y[state.index] as number };
}
