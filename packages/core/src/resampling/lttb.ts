// Largest-Triangle-Three-Buckets (Lttb of the .NET version): selects points that keep the shape of a curve for smooth
// lines. Unlike the min/max decimation, it does not guarantee to keep peaks.
import type { NumberArray } from '../data/source';

const target = { x: 0, y: 0 };

/**
 * Selects up to `indices.length` points of `[start, end)`, the first and last finite point always among them, and
 * returns how many it wrote to `indices` (absolute, ascending). Gaps (NaN, ±∞) are never selected.
 * @throws RangeError when the lengths differ or fewer than 2 indices fit.
 */
export function selectLttb(
  x: NumberArray,
  y: NumberArray,
  indices: Int32Array,
  start = 0,
  end = Math.min(x.length, y.length),
): number {
  if (x.length !== y.length || end > x.length) {
    throw new RangeError('X and Y must have the same length.');
  }
  if (indices.length < 2) {
    throw new RangeError('The target count must be at least 2.');
  }
  let first = start;
  while (first < end && !Number.isFinite(y[first])) {
    first++;
  }
  if (first === end) {
    return 0;
  }
  let last = end - 1;
  while (!Number.isFinite(y[last])) {
    last--;
  }
  if (last - first + 1 <= indices.length) {
    return copyFinite(y, first, last, indices);
  }
  let count = 0;
  indices[count++] = first;
  const buckets = indices.length - 2;
  const bucketSize = (last - first - 1) / buckets;
  let selected = first;
  for (let bucket = 0; bucket < buckets; bucket++) {
    const bucketStart = first + 1 + Math.trunc(bucket * bucketSize);
    const bucketEnd = first + 1 + Math.trunc((bucket + 1) * bucketSize);
    const nextEnd = bucket === buckets - 1 ? last + 1 : first + 1 + Math.trunc((bucket + 2) * bucketSize);
    average(x, y, bucketEnd, nextEnd);
    const best = largestTriangle(x, y, selected, bucketStart, bucketEnd);
    if (best >= 0) {
      indices[count++] = best;
      selected = best;
    }
  }
  indices[count++] = last;
  return count;
}

function copyFinite(y: NumberArray, first: number, last: number, indices: Int32Array): number {
  let count = 0;
  for (let i = first; i <= last; i++) {
    if (Number.isFinite(y[i])) {
      indices[count++] = i;
    }
  }
  return count;
}

/** The average of the finite points of the next bucket, into `target`. */
function average(x: NumberArray, y: NumberArray, start: number, end: number): void {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    const value = y[i] as number;
    if (Number.isFinite(value)) {
      sumX += x[i] as number;
      sumY += value;
      count++;
    }
  }
  target.x = count === 0 ? (x[Math.min(start, x.length - 1)] as number) : sumX / count;
  target.y = count === 0 ? 0 : sumY / count;
}

/** The point of a bucket with the largest triangle against the selected point and the target; −1 without one. */
function largestTriangle(x: NumberArray, y: NumberArray, anchor: number, start: number, end: number): number {
  const anchorX = x[anchor] as number;
  const anchorY = y[anchor] as number;
  let best = -1;
  let bestArea = -1;
  for (let i = start; i < end; i++) {
    const pointY = y[i] as number;
    if (!Number.isFinite(pointY)) {
      continue;
    }
    const pointX = x[i] as number;
    const area = Math.abs((anchorX - target.x) * (pointY - anchorY) - (anchorX - pointX) * (target.y - anchorY));
    if (area > bestArea) {
      bestArea = area;
      best = i;
    }
  }
  return best;
}
