// A ring of fixed capacity for streaming data, as FifoDataSource of the .NET version.
import { checkLengths, MetadataScanner, type DataMetadata, type DataSnapshot, type PointSource } from './source';

/** A connected part of the ring arrays. */
export interface RingSegment {
  /** The first index in the arrays of the ring. */
  readonly start: number;
  /** The number of values from there. */
  readonly length: number;
}

/**
 * The points that changed since a version: one segment, or two when they wrap around the end of the ring. Read them
 * from {@link FifoDataSource.x} and {@link FifoDataSource.y}.
 */
export interface FifoChanges {
  /** The version the changes lead to. */
  readonly version: number;
  /** The index of the first point counted over the whole life of the ring. */
  readonly firstIndex: number;
  /** The older part, up to the end of the arrays. */
  readonly first: RingSegment;
  /** The newer part, from the start of the arrays. */
  readonly second: RingSegment;
  /** Whether the segments hold all changes; when not, the ring was overwritten since the version. */
  readonly isComplete: boolean;
  /** The points in both segments. */
  readonly count: number;
}

const maximumCapacity = 2 ** 31 - 1;

/**
 * A ring buffer of fixed capacity: when full, new points replace the oldest. Its version is the number of points ever
 * appended, so the changes since a version follow from arithmetic and appending stays a plain copy.
 */
export class FifoDataSource implements PointSource {
  /** The ring of the X values, to read with the segments of {@link FifoChanges}. */
  readonly x: Float64Array;
  /** The ring of the Y values. */
  readonly y: Float64Array;
  private published = 0;
  // Raised before a write, so that a reader in another thread could learn of an overwrite.
  private announced = 0;
  private metadataVersion = -1;
  private cachedMetadata: DataMetadata | undefined;

  /**
   * @param capacity - The points the ring keeps, at least 1.
   */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > maximumCapacity) {
      throw new RangeError(`The capacity must be from 1 to ${String(maximumCapacity)}, not ${String(capacity)}.`);
    }
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
  }

  /** The points the ring keeps. */
  get capacity(): number {
    return this.x.length;
  }

  /** The points in the ring now. */
  get count(): number {
    return Math.min(this.published, this.capacity);
  }

  /** {@inheritDoc PointSource.version} */
  get version(): number {
    return this.published;
  }

  /** Scans the ring once per version, in time proportional to its count; not for the frame path. */
  get metadata(): DataMetadata {
    if (this.metadataVersion !== this.published || !this.cachedMetadata) {
      const changes = this.changesSince(0);
      const scanner = new MetadataScanner();
      scanner.add(this.x, this.y, changes.first.start, changes.first.start + changes.first.length);
      scanner.add(this.x, this.y, 0, changes.second.length);
      this.cachedMetadata = scanner.toMetadata(changes.count);
      this.metadataVersion = this.published;
    }
    return this.cachedMetadata;
  }

  /** Appends one point. */
  append(x: number, y: number): void;
  /** Appends points; when there are more than the capacity, only the newest remain. */
  append(x: ArrayLike<number>, y: ArrayLike<number>): void;
  append(x: number | ArrayLike<number>, y: number | ArrayLike<number>): void {
    if (typeof x === 'number' || typeof y === 'number') {
      this.announced = this.published + 1;
      const at = this.published % this.capacity;
      this.x[at] = x as number;
      this.y[at] = y as number;
      this.published++;
      return;
    }
    checkLengths(x, y);
    if (x.length === 0) {
      return;
    }
    const total = this.published + x.length;
    // Points beyond the capacity would be overwritten by the same append.
    const skip = Math.max(0, x.length - this.capacity);
    this.announced = total;
    const start = (total - (x.length - skip)) % this.capacity;
    this.copyIntoRing(x, this.x, skip, start);
    this.copyIntoRing(y, this.y, skip, start);
    this.published = total;
  }

  /**
   * The points that changed since a version.
   * @throws RangeError when the version is negative or beyond the current one.
   */
  changesSince(version: number): FifoChanges {
    const total = this.published;
    if (!Number.isInteger(version) || version < 0 || version > total) {
      throw new RangeError(`The version must be from 0 to ${String(total)}, not ${String(version)}.`);
    }
    const oldest = Math.max(total - this.capacity, 0);
    const firstIndex = Math.max(version, oldest);
    const count = total - firstIndex;
    const start = firstIndex % this.capacity;
    const firstLength = Math.min(count, this.capacity - start);
    return {
      version: total,
      firstIndex,
      first: { start, length: firstLength },
      second: { start: 0, length: count - firstLength },
      isComplete: version >= oldest,
      count,
    };
  }

  /** Whether the points of the changes were still unchanged after reading them. */
  isIntact(changes: FifoChanges): boolean {
    return this.announced - this.capacity <= changes.firstIndex;
  }

  /**
   * Copies changes in the order they were appended.
   * @returns Whether the copy is intact.
   */
  copy(changes: FifoChanges, x: Float64Array, y: Float64Array): boolean {
    if (x.length < changes.count || y.length < changes.count) {
      throw new RangeError('The destinations are too short.');
    }
    const { first, second } = changes;
    x.set(this.x.subarray(first.start, first.start + first.length));
    x.set(this.x.subarray(0, second.length), first.length);
    y.set(this.y.subarray(first.start, first.start + first.length));
    y.set(this.y.subarray(0, second.length), first.length);
    return this.isIntact(changes);
  }

  /** Copies the ring in the order of appending; it allocates. Streaming series read the changes instead. */
  snapshot(): DataSnapshot {
    const changes = this.changesSince(0);
    const x = new Float64Array(changes.count);
    const y = new Float64Array(changes.count);
    this.copy(changes, x, y);
    const scanner = new MetadataScanner();
    scanner.add(x, y);
    return {
      x,
      y,
      count: changes.count,
      version: changes.version,
      metadata: scanner.toMetadata(changes.count),
      epoch: changes.version,
    };
  }

  /** {@inheritDoc PointSource.snapshotInto} */
  snapshotInto(target: DataSnapshot): DataSnapshot {
    return Object.assign(target, this.snapshot());
  }

  /** {@inheritDoc PointSource.latest} */
  latest(): number | undefined {
    return this.published === 0 ? undefined : this.y[(this.published - 1) % this.capacity];
  }

  private copyIntoRing(source: ArrayLike<number>, ring: Float64Array, skip: number, start: number): void {
    const length = source.length - skip;
    const firstLength = Math.min(length, ring.length - start);
    for (let i = 0; i < firstLength; i++) {
      ring[start + i] = source[skip + i] as number;
    }
    for (let i = firstLength; i < length; i++) {
      ring[i - firstLength] = source[skip + i] as number;
    }
  }
}
