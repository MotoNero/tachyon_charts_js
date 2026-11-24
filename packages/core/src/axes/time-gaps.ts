// Intervals a time axis leaves out, such as nights or weekends, as TimeGapMap and TimeGapScaling of the .NET version.
// Times are integers in the unit of the axis.
import { TimeZone } from '../locale/time-zone';
import type { AxisScaling } from '../numerics/scaling';

const dayMilliseconds = 86_400_000;

// The last index whose start lies at or before the time, -1 for none.
function findGap(starts: readonly bigint[], time: bigint): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((starts[middle] as bigint) <= time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1;
}

function compareStarts(a: readonly [bigint, bigint], b: readonly [bigint, bigint]): number {
  if (a[0] === b[0]) {
    return 0;
  }
  return a[0] < b[0] ? -1 : 1;
}

/** Intervals of time an axis leaves out: they take no room, and zooming, panning and the pointer go across them. */
export class TimeGapMap {
  private readonly starts: bigint[] = [];
  private readonly ends: bigint[] = [];
  private readonly hiddenBefore: bigint[] = [0n];

  /**
   * @param gaps - The intervals as start and end in the unit of the axis; overlapping ones merge.
   * @throws RangeError for an interval that ends before it starts.
   */
  constructor(gaps: Iterable<readonly [bigint, bigint]>) {
    const sorted = [...gaps].sort(compareStarts);
    for (const [start, end] of sorted) {
      if (end < start) {
        throw new RangeError(`The gap from ${String(start)} ends at ${String(end)}.`);
      }
      if (end === start) {
        continue;
      }
      const last = this.ends.length - 1;
      const current = this.ends[last];
      if (current !== undefined && start <= current) {
        this.ends[last] = end > current ? end : current;
      } else {
        this.starts.push(start);
        this.ends.push(end);
      }
    }
    for (let i = 0; i < this.starts.length; i++) {
      this.hiddenBefore.push(
        (this.hiddenBefore[i] as bigint) + ((this.ends[i] as bigint) - (this.starts[i] as bigint)),
      );
    }
  }

  /**
   * The weekends, Saturday and Sunday in a time zone, from a week before one time to a week after another.
   * @param from - The first time in milliseconds since 1970.
   * @param to - The last time in milliseconds since 1970.
   * @param timeZone - A name of the IANA database; UTC by default.
   * @param unitsPerMillisecond - The units of the axis per millisecond: 1 for milliseconds, 10 000 for ticks.
   */
  static weekends(from: number, to: number, timeZone = 'UTC', unitsPerMillisecond = 1n): TimeGapMap {
    const zone = TimeZone.of(timeZone);
    let day = Math.floor(zone.toWall(from) / dayMilliseconds) * dayMilliseconds - 7 * dayMilliseconds;
    const last = to + 7 * dayMilliseconds;
    while (new Date(day).getUTCDay() !== 6) {
      day += dayMilliseconds;
    }
    const gaps: [bigint, bigint][] = [];
    for (; day < last; day += 7 * dayMilliseconds) {
      gaps.push([
        BigInt(zone.toUtc(day)) * unitsPerMillisecond,
        BigInt(zone.toUtc(day + 2 * dayMilliseconds)) * unitsPerMillisecond,
      ]);
    }
    return new TimeGapMap(gaps);
  }

  /** The number of gaps. */
  get count(): number {
    return this.starts.length;
  }

  /** The start of a gap. */
  startOf(index: number): bigint {
    return this.starts[index] as bigint;
  }

  /** Whether a time lies in a gap. */
  isHidden(time: bigint): boolean {
    const index = findGap(this.starts, time);
    return index >= 0 && time < (this.ends[index] as bigint);
  }

  /** A time as a position on the axis without the gaps; a time in a gap goes to its start. */
  compress(time: bigint): bigint {
    const index = findGap(this.starts, time);
    if (index < 0) {
      return time;
    }
    return time < (this.ends[index] as bigint)
      ? (this.starts[index] as bigint) - (this.hiddenBefore[index] as bigint)
      : time - (this.hiddenBefore[index + 1] as bigint);
  }

  /** A position on the axis without the gaps as a time. */
  expand(position: bigint): bigint {
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.starts[middle] as bigint) - (this.hiddenBefore[middle] as bigint) <= position) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return position + (this.hiddenBefore[low] as bigint);
  }
}

/** @internal The scale of a time axis with gaps, counting from the origin of the axis like its values. */
export class TimeGapScaling implements AxisScaling {
  constructor(
    /** The gaps. */
    readonly gaps: TimeGapMap,
    /** The origin of the axis. */
    readonly origin: bigint,
  ) {}

  /** {@inheritDoc AxisScaling.forward} */
  forward(value: number): number {
    return Number.isFinite(value)
      ? Number(this.gaps.compress(this.origin + BigInt(Math.round(value))) - this.origin)
      : value;
  }

  /** {@inheritDoc AxisScaling.inverse} */
  inverse(value: number): number {
    return Number.isFinite(value)
      ? Number(this.gaps.expand(this.origin + BigInt(Math.round(value))) - this.origin)
      : value;
  }
}
