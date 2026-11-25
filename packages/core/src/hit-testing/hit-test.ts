// Finds the point of a series nearest to a position (SeriesHitTester of the .NET version, without the indexes, which
// come with the large data: sorted X is searched by halves, other data scanned).
import { FifoDataSource } from '../data/fifo-data-source';
import type { DataSnapshot, PointSource } from '../data/source';
import type { ChartSeries, SeriesFrame } from '../pipeline/chart-series';
import type { DoubleRange } from '../numerics/range';
import { valueLabelLimit, type ValueLabel } from '../pipeline/value-label';
import { lowerBound } from '../resampling/min-max-decimator';
import type { FoundPoint, HitTestMode, SelectionArea } from './types';

export { SelectionArea, type FoundPoint, type HitTestMode } from './types';

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

// A ring numbers its points by running number, so that a selection keeps meaning the same points while it moves on.
function firstIndexOf(source: PointSource, snapshot: DataSnapshot): number {
  return source instanceof FifoDataSource ? snapshot.version - snapshot.count : 0;
}

/** Adds the numbers of the points of a source that lie in an area, as PointSelection.Collect of the .NET version. */
export function collectSourcePoints(
  source: PointSource,
  origin: number,
  frame: SeriesFrame,
  area: SelectionArea,
  indices: number[],
): void {
  const snapshot = source.snapshot();
  const { x, y, count } = snapshot;
  let start = 0;
  let end = count;
  if (source instanceof FifoDataSource || snapshot.metadata.isSortedX) {
    const first = frame.x.toData(area.left);
    const second = frame.x.toData(area.right);
    start = lowerBound(x, count, Math.min(first, second) + origin);
    end = lowerBound(x, count, nextUp(Math.max(first, second)) + origin);
  }
  const firstIndex = firstIndexOf(source, snapshot);
  for (let i = start; i < end; i++) {
    const valueX = (x[i] as number) - origin;
    const valueY = y[i] as number;
    if (
      Number.isFinite(valueX) &&
      Number.isFinite(valueY) &&
      area.contains(frame.x.toPixel(valueX), frame.y.toPixel(valueY))
    ) {
      indices.push(firstIndex + i);
    }
  }
}

/** A point of a source by its number, X relative to the origin; `undefined` when it is no longer there. */
export function readSourcePoint(
  source: PointSource,
  origin: number,
  index: number,
): { x: number; y: number } | undefined {
  const snapshot = source.snapshot();
  const slot = index - firstIndexOf(source, snapshot);
  if (slot < 0 || slot >= snapshot.count) {
    return undefined;
  }
  return { x: (snapshot.x[slot] as number) - origin, y: snapshot.y[slot] as number };
}

// The next double above a value, as Math.BitIncrement.
function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) {
    return value;
  }
  if (value === 0) {
    return Number.MIN_VALUE;
  }
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value);
  const bits = buffer.getBigInt64(0);
  buffer.setBigInt64(0, value > 0 ? bits + 1n : bits - 1n);
  return buffer.getFloat64(0);
}

/** Adds a label above each point of a source within the visible ranges, X relative to the origin. */
export function collectSourceLabels(
  source: PointSource,
  origin: number,
  xRange: DoubleRange,
  yRange: DoubleRange,
  labels: ValueLabel[],
): void {
  const snapshot = source.snapshot();
  for (let i = 0; i < snapshot.count && labels.length < valueLabelLimit; i++) {
    const x = (snapshot.x[i] as number) - origin;
    const y = snapshot.y[i] as number;
    if (xRange.contains(x) && yRange.contains(y)) {
      labels.push({ x, y, value: y, place: 'above' });
    }
  }
}
