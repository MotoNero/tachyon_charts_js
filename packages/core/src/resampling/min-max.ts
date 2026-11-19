// The extremes of the finite values in a range (MinMax of the .NET version). NaN and infinities are gaps.
import type { NumberArray } from '../data/source';

/** The extremes of finite values; empty while `min > max`. */
export class Extremes {
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;

  /** Whether no finite value was seen. */
  get isEmpty(): boolean {
    return this.min > this.max;
  }

  /** Starts over without values. */
  clear(): this {
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
    return this;
  }
}

/** Adds the finite values of `values[start, end)` to the extremes. */
export function accumulate(values: NumberArray, start: number, end: number, extremes: Extremes): void {
  let min = extremes.min;
  let max = extremes.max;
  for (let i = start; i < end; i++) {
    const value = values[i] as number;
    // NaN fails both comparisons; infinities are checked only when they would change an extreme, which is rare.
    if (value < min && value !== Number.NEGATIVE_INFINITY) {
      min = value;
    }
    if (value > max && value !== Number.POSITIVE_INFINITY) {
      max = value;
    }
  }
  extremes.min = min;
  extremes.max = max;
}
