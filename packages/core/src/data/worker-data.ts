// Data written in a worker. Two ways, as the page allows: shared memory, where the worker writes the values straight
// into the arrays of a DataSource and publishes count and metadata with Atomics, or blocks of transferred buffers,
// which the main thread appends. Both give the worker the same writer.
import { MetadataScanner, checkLengths } from './source';

/** Where messages go and come from: a worker, the global scope of a worker or a `MessagePort`. */
export interface DataEndpoint {
  /** Sends a message, handing over the buffers in `transfer`. */
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  /** Listens for messages. */
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  /** Present on a `MessagePort`, which delivers only after it; called once a listener is set. */
  start?(): void;
}

/** Whether this page can share memory with workers (it is cross-origin isolated). */
export function canShareMemory(): boolean {
  return (
    typeof SharedArrayBuffer === 'function' &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  );
}

/** A Float64Array in shared memory where the page allows it, else in ordinary memory. */
export function allocateValues(length: number, shared: boolean): Float64Array {
  return shared ? new Float64Array(new SharedArrayBuffer(length * 8)) : new Float64Array(length);
}

/**
 * The shared memory of a DataSource that a worker writes: the values, a control block (sequence and count) and the
 * state of the metadata. Post it to the worker; it is not transferred but shared.
 */
export interface SharedDataHandle {
  /** Marks the message. */
  readonly kind: 'tachyon-shared-data';
  /** The X values. */
  readonly x: SharedArrayBuffer;
  /** The Y values. */
  readonly y: SharedArrayBuffer;
  /** Sequence (odd while the worker publishes) and count, as Int32. */
  readonly control: SharedArrayBuffer;
  /** The state of the metadata scanner, as Float64. */
  readonly metadata: SharedArrayBuffer;
}

/** Index of the sequence and of the count in the control block. */
export const sequenceIndex = 0;
/** @see sequenceIndex */
export const countIndex = 1;

/** What a worker writes data with, whichever way it travels. */
export interface DataAppender {
  /** `shared` when the values go straight into the data source, `transferred` when they travel in blocks. */
  readonly path: 'shared' | 'transferred';
  /** Appends one point or arrays of points. */
  append(x: number | ArrayLike<number>, y: number | ArrayLike<number>): void;
  /** Sends what is still waiting; blocks also go on their own at the end of the task. */
  flush(): void;
}

/**
 * Writes into a DataSource from a worker through shared memory. The values land in the arrays of the source; count and
 * metadata follow under a sequence lock, so the main thread never sees a count without its values or metadata.
 */
export class SharedDataWriter implements DataAppender {
  /** {@inheritDoc DataAppender.path} */
  readonly path = 'shared';
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  private readonly control: Int32Array;
  private readonly state: Float64Array;
  private readonly scanner = new MetadataScanner();
  private written: number;

  /** @param handle - The handle of `DataSource.shareWithWorker`. */
  constructor(handle: SharedDataHandle) {
    this.x = new Float64Array(handle.x);
    this.y = new Float64Array(handle.y);
    this.control = new Int32Array(handle.control);
    this.state = new Float64Array(handle.metadata);
    this.scanner.loadFrom(this.state);
    this.written = Atomics.load(this.control, countIndex);
  }

  /** The number of points the source holds. */
  get count(): number {
    return this.written;
  }

  /** The number of points the source can hold. */
  get capacity(): number {
    return this.x.length;
  }

  /**
   * {@inheritDoc DataAppender.append}
   * @throws RangeError when the points do not fit into the capacity shared with the worker.
   */
  append(x: number | ArrayLike<number>, y: number | ArrayLike<number>): void {
    const start = this.written;
    if (typeof x === 'number' || typeof y === 'number') {
      this.ensureRoom(1);
      this.x[start] = x as number;
      this.y[start] = y as number;
      this.publish(start, start + 1);
      return;
    }
    checkLengths(x, y);
    this.ensureRoom(x.length);
    this.x.set(x, start);
    this.y.set(y, start);
    this.publish(start, start + x.length);
  }

  /** Nothing waits: every append is published at once. */
  flush(): void {
    // Published in append.
  }

  private ensureRoom(count: number): void {
    if (this.written + count > this.x.length) {
      throw new RangeError(
        `The shared data source holds ${String(this.x.length)} points; ${String(this.written + count)} do not fit.`,
      );
    }
  }

  // The values are in place; the sequence lock publishes count and metadata together.
  private publish(start: number, end: number): void {
    this.scanner.add(this.x, this.y, start, end);
    Atomics.add(this.control, sequenceIndex, 1);
    this.scanner.saveTo(this.state);
    Atomics.store(this.control, countIndex, end);
    Atomics.add(this.control, sequenceIndex, 1);
    this.written = end;
  }
}

/** A block of points a worker sent to the main thread. */
export interface DataBlockMessage {
  /** Marks the message. */
  readonly kind: 'tachyon-data-block';
  /** The stream the block belongs to. */
  readonly stream: string;
  /** The X values. */
  readonly x: Float64Array;
  /** The Y values. */
  readonly y: Float64Array;
}

/**
 * Sends points from a worker to the main thread in blocks of transferred buffers, for pages without shared memory.
 * A block goes when it is full or at the end of the task in which points were appended.
 */
export class DataBlockSender implements DataAppender {
  /** {@inheritDoc DataAppender.path} */
  readonly path = 'transferred';
  private x: Float64Array;
  private y: Float64Array;
  private filled = 0;
  private scheduled = false;

  /**
   * @param endpoint - The scope of the worker or a port to the main thread.
   * @param stream - The name of the stream, when a worker feeds several sources.
   * @param blockSize - Points per block.
   */
  constructor(
    private readonly endpoint: DataEndpoint,
    private readonly stream = 'data',
    private readonly blockSize = 65_536,
  ) {
    this.x = new Float64Array(blockSize);
    this.y = new Float64Array(blockSize);
  }

  /** {@inheritDoc DataAppender.append} */
  append(x: number | ArrayLike<number>, y: number | ArrayLike<number>): void {
    if (typeof x === 'number' || typeof y === 'number') {
      this.put(x as number, y as number);
    } else {
      checkLengths(x, y);
      let at = 0;
      while (at < x.length) {
        const room = this.blockSize - this.filled;
        const take = Math.min(room, x.length - at);
        for (let i = 0; i < take; i++) {
          this.x[this.filled + i] = x[at + i] as number;
          this.y[this.filled + i] = y[at + i] as number;
        }
        this.filled += take;
        at += take;
        if (this.filled === this.blockSize) {
          this.flush();
        }
      }
    }
    this.schedule();
  }

  /** {@inheritDoc DataAppender.flush} */
  flush(): void {
    this.scheduled = false;
    if (this.filled === 0) {
      return;
    }
    const x = this.filled === this.blockSize ? this.x : this.x.slice(0, this.filled);
    const y = this.filled === this.blockSize ? this.y : this.y.slice(0, this.filled);
    const message: DataBlockMessage = { kind: 'tachyon-data-block', stream: this.stream, x, y };
    this.endpoint.postMessage(message, [x.buffer as ArrayBuffer, y.buffer as ArrayBuffer]);
    if (x === this.x) {
      this.x = new Float64Array(this.blockSize);
      this.y = new Float64Array(this.blockSize);
    }
    this.filled = 0;
  }

  private put(x: number, y: number): void {
    this.x[this.filled] = x;
    this.y[this.filled] = y;
    this.filled++;
    if (this.filled === this.blockSize) {
      this.flush();
    }
  }

  private schedule(): void {
    if (!this.scheduled && this.filled > 0) {
      this.scheduled = true;
      void Promise.resolve().then(() => {
        this.flush();
      });
    }
  }
}

/** What the main thread appends received blocks to: a `DataSource` or a `FifoDataSource`. */
export interface AppendTarget {
  /** Appends arrays of points. */
  append(x: ArrayLike<number>, y: ArrayLike<number>): void;
}

/** What a source can share with a worker; `DataSource` implements it. */
export interface ShareableSource extends AppendTarget {
  /** Shares the arrays with a worker, which then writes them; see `DataSource.shareWithWorker`. */
  shareWithWorker(capacity: number): SharedDataHandle;
}

/** The message that tells a worker how to write a stream. */
export interface DataLinkMessage {
  /** Marks the message. */
  readonly kind: 'tachyon-data-link';
  /** The stream. */
  readonly stream: string;
  /** The shared memory, or `undefined` for blocks. */
  readonly handle: SharedDataHandle | undefined;
}

/** Options of {@link linkDataSource}. */
export interface DataLinkOptions {
  /** The name of the stream, when a worker feeds several sources. */
  readonly stream?: string;
  /** How many points the worker may write in shared memory; required for that way. */
  readonly capacity?: number;
  /** `false` sends blocks even where memory could be shared. */
  readonly share?: boolean;
}

/**
 * Lets a worker write into a source: through shared memory where the page allows it and the source can share (a
 * `DataSource` with a capacity), else in blocks the main thread appends. The worker calls {@link acceptDataLink}.
 * @returns The way the data travels.
 */
export function linkDataSource(
  source: AppendTarget | ShareableSource,
  endpoint: DataEndpoint,
  options: DataLinkOptions = {},
): 'shared' | 'transferred' {
  const stream = options.stream ?? 'data';
  const canShare =
    options.share !== false && options.capacity !== undefined && 'shareWithWorker' in source && canShareMemory();
  if (canShare) {
    const handle = source.shareWithWorker(options.capacity ?? 0);
    const message: DataLinkMessage = { kind: 'tachyon-data-link', stream, handle };
    endpoint.postMessage(message, []);
    return 'shared';
  }
  endpoint.addEventListener('message', (event) => {
    const block = event.data as Partial<DataBlockMessage>;
    if (block.kind === 'tachyon-data-block' && block.stream === stream && block.x && block.y) {
      source.append(block.x, block.y);
    }
  });
  endpoint.start?.();
  const message: DataLinkMessage = { kind: 'tachyon-data-link', stream, handle: undefined };
  endpoint.postMessage(message, []);
  return 'transferred';
}

/** In a worker: waits for {@link linkDataSource} of the main thread and resolves with the writer for the stream. */
export function acceptDataLink(endpoint: DataEndpoint, stream = 'data'): Promise<DataAppender> {
  return new Promise((resolve) => {
    endpoint.addEventListener('message', (event) => {
      const link = event.data as Partial<DataLinkMessage>;
      if (link.kind === 'tachyon-data-link' && link.stream === stream) {
        resolve(link.handle ? new SharedDataWriter(link.handle) : new DataBlockSender(endpoint, stream));
      }
    });
    endpoint.start?.();
  });
}
