// What all data sources share: metadata, snapshots, and the scanner that collects metadata append by append.
import { DoubleRange } from '../numerics/range';

/** The arrays a data source can hold or show: any typed array of numbers. */
export type NumberArray =
  Float64Array | Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;

/** What is known about the content of a data source without scanning it. */
export interface DataMetadata {
  readonly count: number;
  /** Whether X never falls; equal neighbors count as sorted, NaN does not. */
  readonly isSortedX: boolean;
  /** The distance between neighbors when it is the same everywhere, from two points on. */
  readonly uniformXStep: number | undefined;
  /** The range of the finite X values. */
  readonly xRange: DoubleRange;
  /** The range of the finite Y values. */
  readonly yRange: DoubleRange;
}

/**
 * A consistent view of a data source: the first `count` values of `x` and `y`. Later changes of the source do not
 * change it, because published values never change and the source takes new arrays to grow or to clear.
 */
export interface DataSnapshot {
  x: NumberArray;
  y: NumberArray;
  count: number;
  version: number;
  metadata: DataMetadata;
  /** Grows when the source starts over, as with clear(); between equal epochs the content only grew. */
  epoch: number;
}

/** A source of points. */
export interface PointSource {
  /** Grows with every change. */
  readonly version: number;
  readonly metadata: DataMetadata;
  /** A consistent view of the current content. */
  snapshot(): DataSnapshot;
  /** The same view written into an object the caller keeps, so that frames need no new objects. */
  snapshotInto(target: DataSnapshot): DataSnapshot;
  /** The Y of the newest point, `undefined` when there is none. */
  latest(): number | undefined;
}

/** An empty snapshot to pass to {@link PointSource.snapshotInto}. */
export function emptySnapshot(): DataSnapshot {
  return { x: new Float64Array(0), y: new Float64Array(0), count: 0, version: 0, metadata: emptyMetadata, epoch: 0 };
}

export const emptyMetadata: DataMetadata = {
  count: 0,
  isSortedX: true,
  uniformXStep: undefined,
  xRange: DoubleRange.empty,
  yRange: DoubleRange.empty,
};

/** Checks that X and Y have the same length. */
export function checkLengths(x: ArrayLike<number>, y: ArrayLike<number>): void {
  if (x.length !== y.length) {
    throw new RangeError(`X and Y must have the same length, not ${String(x.length)} and ${String(y.length)}.`);
  }
}

// Tolerates the rounding of steps such as 0.1, which are not exact in binary.
const uniformTolerance = 1e-9;

/** Collects metadata incrementally, so that an append only looks at the new points. */
export class MetadataScanner {
  private lastX = 0;
  private hasPoints = false;
  private isUnsorted = false;
  private isNotUniform = false;
  private step = 0;
  private minX = Number.POSITIVE_INFINITY;
  private maxX = Number.NEGATIVE_INFINITY;
  private minY = Number.POSITIVE_INFINITY;
  private maxY = Number.NEGATIVE_INFINITY;

  /** Adds the points from `start` to before `end`. */
  add(x: ArrayLike<number>, y: ArrayLike<number>, start = 0, end = x.length): void {
    for (let i = start; i < end; i++) {
      this.addX(x[i] as number);
      const value = y[i] as number;
      if (Number.isFinite(value)) {
        this.minY = Math.min(this.minY, value);
        this.maxY = Math.max(this.maxY, value);
      }
    }
  }

  toMetadata(count: number): DataMetadata {
    return {
      count,
      isSortedX: !this.isUnsorted,
      uniformXStep: count >= 2 && !this.isNotUniform ? this.step : undefined,
      xRange: range(this.minX, this.maxX),
      yRange: range(this.minY, this.maxY),
    };
  }

  private addX(x: number): void {
    if (Number.isFinite(x)) {
      this.minX = Math.min(this.minX, x);
      this.maxX = Math.max(this.maxX, x);
    }
    if (!this.hasPoints) {
      this.hasPoints = true;
      this.isUnsorted = Number.isNaN(x);
      this.isNotUniform = this.isUnsorted;
    } else if (!(x >= this.lastX)) {
      // The negated form also catches NaN, on purpose.
      this.isUnsorted = true;
      this.isNotUniform = true;
    } else if (!this.isNotUniform) {
      this.updateStep(x - this.lastX);
    }
    this.lastX = x;
  }

  private updateStep(distance: number): void {
    if (this.step === 0) {
      this.step = distance;
      this.isNotUniform = !(distance > 0 && Number.isFinite(distance));
    } else if (Math.abs(distance - this.step) > this.step * uniformTolerance) {
      this.isNotUniform = true;
    }
  }
}

function range(min: number, max: number): DoubleRange {
  return min <= max ? new DoubleRange(min, max) : DoubleRange.empty;
}
