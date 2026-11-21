// A ring of fixed capacity for streaming data, as FifoDataSource of the .NET version. Each value is kept twice, at i
// and at i + capacity, so that the newest points are always in one piece: a frame reads them without a copy. The
// metadata of the ring combines summaries of full blocks, made once when a block fills, with the parts at both ends.
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

const maximumCapacity = 2 ** 30;
// Points per block of the metadata.
const blockSize = 4096;
const stateLength = MetadataScanner.stateLength;
// Values per summary: the state of a MetadataScanner, then the first X and the count.
const summaryLength = stateLength + 2;

// Writes the summary of `count` values from `start` of the arrays into `parts` at `offset`.
function summarize(
  x: Float64Array,
  y: Float64Array,
  start: number,
  count: number,
  parts: Float64Array,
  offset: number,
): void {
  parts[offset + stateLength + 1] = count;
  if (count === 0) {
    return;
  }
  const scanner = new MetadataScanner();
  scanner.add(x, y, start, start + count);
  scanner.saveTo(parts.subarray(offset, offset + stateLength));
  parts[offset + stateLength] = x[start] ?? 0;
}

// Folds summaries of consecutive parts as one MetadataScanner would scan them in a row.
class MetadataFold {
  private readonly state = new Float64Array(stateLength);
  private readonly scanner = new MetadataScanner();
  private count = 0;

  reset(): void {
    this.count = 0;
  }

  add(parts: Float64Array, offset: number): void {
    const count = parts[offset + stateLength + 1] ?? 0;
    if (count === 0) {
      return;
    }
    const state = this.state;
    if (this.count === 0) {
      state.set(parts.subarray(offset, offset + stateLength));
      this.count = count;
      return;
    }
    const firstX = parts[offset + stateLength] ?? 0;
    // The pair across the border, as MetadataScanner.addX sees it; the negated form also catches NaN.
    if (!(firstX >= (state[0] ?? 0))) {
      state[2] = 1;
      state[3] = 1;
    } else if (state[3] !== 1) {
      this.updateStep(firstX - (state[0] ?? 0));
    }
    // The pairs inside the part.
    if (parts[offset + 2] === 1) {
      state[2] = 1;
      state[3] = 1;
    } else if (parts[offset + 3] === 1) {
      state[3] = 1;
    } else if ((parts[offset + 4] ?? 0) !== 0 && state[3] !== 1) {
      this.updateStep(parts[offset + 4] ?? 0);
    }
    state[0] = parts[offset] ?? 0;
    state[5] = Math.min(state[5] ?? 0, parts[offset + 5] ?? 0);
    state[6] = Math.max(state[6] ?? 0, parts[offset + 6] ?? 0);
    state[7] = Math.min(state[7] ?? 0, parts[offset + 7] ?? 0);
    state[8] = Math.max(state[8] ?? 0, parts[offset + 8] ?? 0);
    this.count += count;
  }

  toMetadata(count: number): DataMetadata {
    if (this.count === 0) {
      return new MetadataScanner().toMetadata(count);
    }
    this.scanner.loadFrom(this.state);
    return this.scanner.toMetadata(count);
  }

  // As MetadataScanner.updateStep.
  private updateStep(distance: number): void {
    const state = this.state;
    const step = state[4] ?? 0;
    if (step === 0) {
      state[4] = distance;
      state[3] = distance > 0 && Number.isFinite(distance) ? 0 : 1;
    } else if (Math.abs(distance - step) > step * 1e-9) {
      state[3] = 1;
    }
  }
}

/**
 * A ring buffer of fixed capacity: when full, new points replace the oldest. Its version is the number of points ever
 * appended, so the changes since a version follow from arithmetic and appending stays a plain copy.
 */
export class FifoDataSource implements PointSource {
  /** The ring of the X values, to read with the segments of {@link FifoChanges}. */
  readonly x: Float64Array;
  /** The ring of the Y values. */
  readonly y: Float64Array;
  private readonly mirroredX: Float64Array;
  private readonly mirroredY: Float64Array;
  private readonly blocks: Float64Array;
  private readonly blockSlots: number;
  private summarizedBlocks = 0;
  private readonly fold = new MetadataFold();
  private readonly edges = new Float64Array(summaryLength * 2);
  private viewVersion = -1;
  private viewX: Float64Array = new Float64Array(0);
  private viewY: Float64Array = new Float64Array(0);
  private published = 0;
  // Raised before a write, so that a reader in another thread could learn of an overwrite.
  private announced = 0;
  private metadataVersion = -1;
  private cachedMetadata: DataMetadata | undefined;

  /**
   * @param capacity - The points the ring keeps, from 1 to 2³⁰.
   */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > maximumCapacity) {
      throw new RangeError(`The capacity must be from 1 to ${String(maximumCapacity)}, not ${String(capacity)}.`);
    }
    this.mirroredX = new Float64Array(capacity * 2);
    this.mirroredY = new Float64Array(capacity * 2);
    this.x = this.mirroredX.subarray(0, capacity);
    this.y = this.mirroredY.subarray(0, capacity);
    this.blockSlots = Math.ceil(capacity / blockSize) + 2;
    this.blocks = new Float64Array(this.blockSlots * summaryLength);
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

  /**
   * The metadata of the points in the ring, once per version. It costs about two blocks of 4096 points however large
   * the ring is.
   */
  get metadata(): DataMetadata {
    if (this.metadataVersion !== this.published || !this.cachedMetadata) {
      this.cachedMetadata = this.scanMetadata();
      this.metadataVersion = this.published;
    }
    return this.cachedMetadata;
  }

  /** Appends one point. */
  append(x: number, y: number): void;
  /** Appends points; when there are more than the capacity, only the newest remain. */
  append(x: ArrayLike<number>, y: ArrayLike<number>): void;
  append(x: number | ArrayLike<number>, y: number | ArrayLike<number>): void {
    const capacity = this.capacity;
    if (typeof x === 'number' || typeof y === 'number') {
      this.announced = this.published + 1;
      const at = this.published % capacity;
      this.mirroredX[at] = x as number;
      this.mirroredX[at + capacity] = x as number;
      this.mirroredY[at] = y as number;
      this.mirroredY[at + capacity] = y as number;
      this.published++;
      this.summarizeBlocks();
      return;
    }
    checkLengths(x, y);
    if (x.length === 0) {
      return;
    }
    const total = this.published + x.length;
    // Points beyond the capacity would be overwritten by the same append.
    const skip = Math.max(0, x.length - capacity);
    this.announced = total;
    const start = (total - (x.length - skip)) % capacity;
    this.copyIntoRing(x, this.mirroredX, skip, start);
    this.copyIntoRing(y, this.mirroredY, skip, start);
    this.published = total;
    this.summarizeBlocks();
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
    const start = changes.first.start;
    x.set(this.mirroredX.subarray(start, start + changes.count));
    y.set(this.mirroredY.subarray(start, start + changes.count));
    return this.isIntact(changes);
  }

  /** Copies the ring in the order of appending; it allocates, and the copy stays valid. */
  snapshot(): DataSnapshot {
    const changes = this.changesSince(0);
    const x = new Float64Array(changes.count);
    const y = new Float64Array(changes.count);
    this.copy(changes, x, y);
    return {
      x,
      y,
      count: changes.count,
      version: changes.version,
      metadata: this.metadata,
      epoch: changes.version,
    };
  }

  /**
   * Fills `target` with views of the points in the order of appending, without a copy. The views show the points of
   * this version until the next append; read them in the same frame, or take {@link FifoDataSource.snapshot}.
   */
  snapshotInto(target: DataSnapshot): DataSnapshot {
    const total = this.published;
    if (this.viewVersion !== total) {
      const count = Math.min(total, this.capacity);
      const start = (total - count) % this.capacity;
      this.viewX = this.mirroredX.subarray(start, start + count);
      this.viewY = this.mirroredY.subarray(start, start + count);
      this.viewVersion = total;
    }
    target.x = this.viewX;
    target.y = this.viewY;
    target.count = this.viewX.length;
    target.version = total;
    target.metadata = this.metadata;
    target.epoch = total;
    return target;
  }

  /** {@inheritDoc PointSource.latest} */
  latest(): number | undefined {
    return this.published === 0 ? undefined : this.y[(this.published - 1) % this.capacity];
  }

  // Writes into both halves of the mirrored arrays.
  private copyIntoRing(source: ArrayLike<number>, mirrored: Float64Array, skip: number, start: number): void {
    const capacity = this.capacity;
    const length = source.length - skip;
    const firstLength = Math.min(length, capacity - start);
    for (let i = 0; i < firstLength; i++) {
      const value = source[skip + i] as number;
      mirrored[start + i] = value;
      mirrored[start + i + capacity] = value;
    }
    for (let i = firstLength; i < length; i++) {
      const value = source[skip + i] as number;
      mirrored[i - firstLength] = value;
      mirrored[i - firstLength + capacity] = value;
    }
  }

  // Summarizes each block once when it fills; blocks already overwritten are skipped.
  private summarizeBlocks(): void {
    const full = Math.floor(this.published / blockSize);
    if (full <= this.summarizedBlocks) {
      return;
    }
    const oldest = Math.max(this.published - this.capacity, 0);
    for (let block = Math.max(this.summarizedBlocks, Math.ceil(oldest / blockSize)); block < full; block++) {
      const start = (block * blockSize) % this.capacity;
      const offset = (block % this.blockSlots) * summaryLength;
      summarize(this.mirroredX, this.mirroredY, start, blockSize, this.blocks, offset);
    }
    this.summarizedBlocks = full;
  }

  // The parts before the first full block and after the last one are scanned, the full blocks between come from
  // their summaries.
  private scanMetadata(): DataMetadata {
    const total = this.published;
    const count = Math.min(total, this.capacity);
    const first = total - count;
    const capacity = this.capacity;
    const firstBlock = Math.ceil(first / blockSize);
    const endBlock = Math.floor(total / blockSize);
    const fold = this.fold;
    fold.reset();
    if (endBlock - firstBlock < 2) {
      summarize(this.mirroredX, this.mirroredY, first % capacity, count, this.edges, 0);
      fold.add(this.edges, 0);
      return fold.toMetadata(count);
    }
    summarize(this.mirroredX, this.mirroredY, first % capacity, firstBlock * blockSize - first, this.edges, 0);
    fold.add(this.edges, 0);
    for (let block = firstBlock; block < endBlock; block++) {
      fold.add(this.blocks, (block % this.blockSlots) * summaryLength);
    }
    const tail = endBlock * blockSize;
    summarize(this.mirroredX, this.mirroredY, tail % capacity, total - tail, this.edges, summaryLength);
    fold.add(this.edges, summaryLength);
    return fold.toMetadata(count);
  }
}
