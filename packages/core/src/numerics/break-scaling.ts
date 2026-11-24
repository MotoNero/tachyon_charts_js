// The scale of an axis that leaves out ranges, as BreakScaling of the .NET version: a break keeps 1 % of its length,
// so that its mark has room, and the values after it move up by the rest.
import { DoubleRange } from './range';
import type { AxisScaling } from './scaling';

/** The share of the length of a break it keeps on the axis. */
export const breakKeptShare = 0.01;

// The last index whose start lies at or before the value, -1 for none.
function lastAtOrBefore(starts: readonly number[], value: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((starts[middle] as number) <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1;
}

/** The scale of an axis with breaks: ranges that take almost no room. */
export class BreakScaling implements AxisScaling {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly hiddenBefore: number[] = [0];

  /** @param breaks - The ranges left out; overlapping ones merge. */
  constructor(breaks: readonly DoubleRange[]) {
    const sorted = breaks.filter((range) => !range.isEmpty && range.length > 0).sort((a, b) => a.min - b.min);
    for (const range of sorted) {
      const last = this.ends.length - 1;
      if (last >= 0 && range.min <= (this.ends[last] as number)) {
        this.ends[last] = Math.max(this.ends[last] as number, range.max);
      } else {
        this.starts.push(range.min);
        this.ends.push(range.max);
      }
    }
    for (let i = 0; i < this.starts.length; i++) {
      const length = (this.ends[i] as number) - (this.starts[i] as number);
      this.hiddenBefore.push((this.hiddenBefore[i] as number) + length * (1 - breakKeptShare));
    }
  }

  /** The breaks, merged and in order. */
  get breaks(): readonly DoubleRange[] {
    return this.starts.map((start, i) => new DoubleRange(start, this.ends[i] as number));
  }

  /** {@inheritDoc AxisScaling.forward} */
  forward(value: number): number {
    const index = lastAtOrBefore(this.starts, value);
    if (index < 0 || Number.isNaN(value)) {
      return value;
    }
    const start = this.starts[index] as number;
    return value < (this.ends[index] as number)
      ? start - (this.hiddenBefore[index] as number) + (value - start) * breakKeptShare
      : value - (this.hiddenBefore[index + 1] as number);
  }

  /** {@inheritDoc AxisScaling.inverse} */
  inverse(value: number): number {
    // The last break whose place lies at or before the position.
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.starts[middle] as number) - (this.hiddenBefore[middle] as number) <= value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low === 0) {
      return value;
    }
    // Inside the band of the break, or after it.
    const index = low - 1;
    const start = this.starts[index] as number;
    const band = value - (start - (this.hiddenBefore[index] as number));
    const kept = ((this.ends[index] as number) - start) * breakKeptShare;
    return band < kept ? start + band / breakKeptShare : value + (this.hiddenBefore[low] as number);
  }
}
