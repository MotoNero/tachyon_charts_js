// A growing data source, as DataSource of the .NET version.
import { checkLengths, MetadataScanner, type DataMetadata, type DataSnapshot, type PointSource } from './source';
import {
  allocateValues,
  canShareMemory,
  countIndex,
  sequenceIndex,
  type ShareableSource,
  type SharedDataHandle,
} from './worker-data';

/** Options of a {@link DataSource}. */
export interface DataSourceOptions {
  /**
   * Whether the values live in shared memory, which workers read and write without a copy. By default they do where
   * the page is cross-origin isolated.
   */
  readonly shared?: boolean;
}

// The shared memory a worker publishes count and metadata in.
interface WorkerLink {
  readonly control: Int32Array;
  readonly state: Float64Array;
  sequence: number;
}

const minimumCapacity = 16;
// The largest typed array that every browser allows.
const maximumCapacity = 2 ** 31 - 1;

/** Space reserved in a {@link DataSource} to write points into directly, without an intermediate copy. */
export interface DataWriter {
  /** The space for the X values, as long as the reserved count. */
  readonly x: Float64Array;
  /** The space for the Y values. */
  readonly y: Float64Array;
  /**
   * Publishes the first points written; all reserved ones when the count is left out.
   * @throws RangeError when the count is negative or larger than the reserved space.
   */
  commit(count?: number): void;
  /** Publishes nothing and releases the source for other writes. */
  cancel(): void;
}

/**
 * A growing data source with separate X and Y arrays. New points are complete before they are published, and
 * published points never change; to grow or to clear, the source takes new arrays, so a snapshot stays valid.
 */
export class DataSource implements PointSource, ShareableSource {
  private x: Float64Array;
  private y: Float64Array;
  private count = 0;
  private changes = 0;
  private epoch = 0;
  private scanner = new MetadataScanner();
  private current: DataMetadata;
  private writing = false;
  private readonly shared: boolean;
  private link: WorkerLink | undefined;

  /**
   * @param capacity - The points to make room for at once; the source grows beyond.
   */
  constructor(capacity = 0, options: DataSourceOptions = {}) {
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > maximumCapacity) {
      throw new RangeError(`The capacity must be from 0 to ${String(maximumCapacity)}, not ${String(capacity)}.`);
    }
    this.shared = options.shared ?? canShareMemory();
    this.x = allocateValues(capacity, this.shared);
    this.y = allocateValues(capacity, this.shared);
    this.current = this.scanner.toMetadata(0);
  }

  /** Whether the values live in shared memory. */
  get isShared(): boolean {
    return this.shared || this.link !== undefined;
  }

  /** Whether a worker writes this source (after {@link DataSource.shareWithWorker}). */
  get isWrittenByWorker(): boolean {
    return this.link !== undefined;
  }

  /** {@inheritDoc PointSource.version} */
  get version(): number {
    this.follow();
    return this.changes;
  }

  /** {@inheritDoc PointSource.metadata} */
  get metadata(): DataMetadata {
    this.follow();
    return this.current;
  }

  /** {@inheritDoc PointSource.snapshot} */
  snapshot(): DataSnapshot {
    this.follow();
    return {
      x: this.x,
      y: this.y,
      count: this.count,
      version: this.changes,
      metadata: this.current,
      epoch: this.epoch,
    };
  }

  /** {@inheritDoc PointSource.snapshotInto} */
  snapshotInto(target: DataSnapshot): DataSnapshot {
    this.follow();
    target.x = this.x;
    target.y = this.y;
    target.count = this.count;
    target.version = this.changes;
    target.metadata = this.current;
    target.epoch = this.epoch;
    return target;
  }

  /** {@inheritDoc PointSource.latest} */
  latest(): number | undefined {
    this.follow();
    return this.count > 0 ? this.y[this.count - 1] : undefined;
  }

  /** Appends one point. */
  append(x: number, y: number): void;
  /** Appends points; they are copied. */
  append(x: ArrayLike<number>, y: ArrayLike<number>): void;
  append(x: number | ArrayLike<number>, y: number | ArrayLike<number>): void {
    if (typeof x === 'number' || typeof y === 'number') {
      this.ensureNotWriting();
      this.ensureCapacity(1);
      this.x[this.count] = x as number;
      this.y[this.count] = y as number;
      this.publish(this.count, 1);
      return;
    }
    checkLengths(x, y);
    this.ensureNotWriting();
    this.ensureCapacity(x.length);
    this.x.set(x, this.count);
    this.y.set(y, this.count);
    this.publish(this.count, x.length);
  }

  /** Reserves space to write points into directly. Other writes wait until the writer commits or cancels. */
  beginWrite(count: number): DataWriter {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`The count must be 0 or more, not ${String(count)}.`);
    }
    this.ensureNotWriting();
    this.ensureCapacity(count);
    this.writing = true;
    const start = this.count;
    const x = this.x.subarray(start, start + count);
    const y = this.y.subarray(start, start + count);
    let open = true;
    const close = (): void => {
      if (!open) {
        throw new Error('The writer is already closed.');
      }
      open = false;
      this.writing = false;
    };
    return {
      x,
      y,
      commit: (written = count) => {
        if (!Number.isInteger(written) || written < 0 || written > count) {
          throw new RangeError(`The count must be from 0 to ${String(count)}, not ${String(written)}.`);
        }
        close();
        this.publish(start, written);
      },
      cancel: close,
    };
  }

  /** Removes all points. Snapshots keep theirs: the source takes new arrays. */
  clear(): void {
    this.ensureNotWriting();
    this.x = allocateValues(0, this.shared);
    this.y = allocateValues(0, this.shared);
    this.count = 0;
    this.epoch++;
    this.scanner = new MetadataScanner();
    this.current = this.scanner.toMetadata(0);
    this.changes++;
  }

  private publish(start: number, added: number): void {
    this.scanner.add(this.x, this.y, start, start + added);
    this.count = start + added;
    this.current = this.scanner.toMetadata(this.count);
    this.changes++;
  }

  // New arrays when the points do not fit: snapshots keep the old ones, which hold all they saw.
  private ensureCapacity(additional: number): void {
    const required = this.count + additional;
    if (required <= this.x.length) {
      return;
    }
    if (required > maximumCapacity) {
      throw new RangeError('The data source cannot hold that many points.');
    }
    const capacity = Math.min(Math.max(required, this.x.length * 2, minimumCapacity), maximumCapacity);
    const x = allocateValues(capacity, this.shared);
    const y = allocateValues(capacity, this.shared);
    x.set(this.x.subarray(0, this.count));
    y.set(this.y.subarray(0, this.count));
    this.x = x;
    this.y = y;
  }

  /**
   * Hands writing over to a worker through shared memory: the source takes arrays for `capacity` points in shared
   * memory (with the points it holds) and from then on shows what the worker publishes. Post the handle to the worker
   * and write with `SharedDataWriter`, or use `linkDataSource`. Afterwards this thread can no longer append or clear.
   * @throws Error when the page cannot share memory or a worker already writes the source.
   * @throws RangeError when the source holds more than `capacity` points.
   */
  shareWithWorker(capacity: number): SharedDataHandle {
    this.ensureNotWriting();
    if (typeof SharedArrayBuffer !== 'function') {
      throw new TypeError('This page cannot share memory with workers.');
    }
    if (!Number.isInteger(capacity) || capacity < this.count || capacity > maximumCapacity) {
      throw new RangeError(`The capacity must hold the ${String(this.count)} points, not ${String(capacity)}.`);
    }
    const x = allocateValues(capacity, true);
    const y = allocateValues(capacity, true);
    x.set(this.x.subarray(0, this.count));
    y.set(this.y.subarray(0, this.count));
    this.x = x;
    this.y = y;
    const control = new SharedArrayBuffer(8);
    const metadata = new SharedArrayBuffer(MetadataScanner.stateLength * 8);
    const link: WorkerLink = { control: new Int32Array(control), state: new Float64Array(metadata), sequence: 0 };
    Atomics.store(link.control, countIndex, this.count);
    this.scanner.saveTo(link.state);
    this.link = link;
    return {
      kind: 'tachyon-shared-data',
      x: x.buffer as SharedArrayBuffer,
      y: y.buffer as SharedArrayBuffer,
      control,
      metadata,
    };
  }

  // Takes what the worker published since the last look; the sequence lock gives count and metadata of one moment.
  private follow(): void {
    const link = this.link;
    if (!link) {
      return;
    }
    const sequence = Atomics.load(link.control, sequenceIndex);
    if (sequence === link.sequence || (sequence & 1) === 1) {
      return;
    }
    const count = Atomics.load(link.control, countIndex);
    this.scanner.loadFrom(link.state);
    if (Atomics.load(link.control, sequenceIndex) !== sequence) {
      return;
    }
    link.sequence = sequence;
    if (count !== this.count) {
      this.count = count;
      this.current = this.scanner.toMetadata(count);
      this.changes++;
    }
  }

  private ensureNotWriting(): void {
    if (this.link) {
      throw new Error('A worker writes this data source.');
    }
    if (this.writing) {
      throw new Error('A writer of this data source is still open.');
    }
  }
}
