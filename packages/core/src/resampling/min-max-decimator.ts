// Reduces a line with sorted X to the extremes per pixel column (MinMaxDecimator of the .NET version).
import type { NumberArray } from '../data/source';
import type { DoubleRange } from '../numerics/range';
import type { LodPyramid } from './lod-pyramid';
import { accumulate, Extremes } from './min-max';

/** The columns of a decimation; an empty column has `min > max` (+∞ and −∞). */
export type ColumnArray = Float64Array | Float32Array;

const scratch = new Extremes();

/**
 * The first index below `count` with an X of at least `value`. Boundaries are nearly evenly spaced, so with a stride the
 * search starts at the expected index and gallops, which needs far fewer cache misses than a search over all of X.
 */
export function lowerBound(x: NumberArray, count: number, value: number, first = 0, stride = 0): number {
  let low = first;
  let high = count;
  if (stride > 0) {
    let step = stride;
    let probe = Math.min(first + step, count);
    while (probe < count && (x[probe] as number) < value) {
      low = probe + 1;
      step *= 2;
      probe = Math.min(low + step, count);
    }
    high = probe;
  }
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    if ((x[middle] as number) < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** The first index below `count` with an X above `value`. */
export function upperBound(x: NumberArray, count: number, value: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    if ((x[middle] as number) <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Finds the extremes of the first `count` points per column of the visible range, which keeps every peak visible.
 * X must be sorted. A column runs from its left boundary up to the next; the last one includes the end of the range.
 * @throws RangeError when the lengths differ or there are no columns or no visible range.
 */
export function decimateMinMax(
  x: NumberArray,
  y: NumberArray,
  count: number,
  pyramid: LodPyramid | undefined,
  visible: DoubleRange,
  minima: ColumnArray,
  maxima: ColumnArray,
): void {
  if (count > x.length || count > y.length || minima.length !== maxima.length) {
    throw new RangeError('X and Y must hold the points, and the column arrays must have the same length.');
  }
  if (minima.length === 0 || visible.isEmpty) {
    throw new RangeError('There must be columns and a visible range.');
  }
  const columns = minima.length;
  let start = lowerBound(x, count, visible.min);
  const last = upperBound(x, count, visible.max);
  const stride = Math.max(Math.trunc((last - start) / columns), 1);
  for (let column = 0; column < columns; column++) {
    const end =
      column === columns - 1
        ? last
        : lowerBound(x, count, visible.min + (visible.length * (column + 1)) / columns, start, stride);
    scratch.clear();
    if (pyramid) {
      pyramid.query(y, start, end, scratch);
    } else {
      accumulate(y, start, end, scratch);
    }
    minima[column] = scratch.min;
    maxima[column] = scratch.max;
    start = end;
  }
}
