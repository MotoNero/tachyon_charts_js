// A column of a file larger than memory, on the main thread: its column worker builds the pyramid and reads what a
// chart needs beyond it; this side keeps the pyramid, recently read blocks and rows, and a version that grows with
// everything that comes in, so that charts draw again and refine.
import type { ColumnType } from './column-file';
import { ColumnPyramid, pyramidBlockSize, type PyramidLevel } from './column-pyramid';
import type { ColumnLocation, ColumnReply, ColumnRequest } from './column-worker';

/** Options of {@link LargeColumn.open}. */
export interface LargeColumnOptions {
  /** The column of the file; 0 by default. */
  readonly column?: number;
  /** Whether finished pyramids are kept in the origin private file system and used again; on by default. */
  readonly cache?: boolean;
  /** A worker running `@tachyon-charts/large-data/column-worker`; by default one is started from this package. */
  readonly worker?: Worker;
}

/** Rows per page of the row cache. */
const pageRows = 1 << 16;
/** Pages and blocks kept, the oldest go first: 64 MB of rows and 32 MB of blocks. */
const maximumPages = 128;
const maximumBlocks = 1 << 14;

/** A column of a column file, opened for drawing. */
export class LargeColumn {
  /** The type of the values. */
  readonly type: Exclude<ColumnType, 'bit'>;
  /** The number of values. */
  readonly rows: number;
  /** The X of the first value. */
  readonly xStart: number;
  /** The X distance between two values. */
  readonly xStep: number;
  /** The pyramid; it fills while the worker reads the column. */
  readonly pyramid: ColumnPyramid;
  private readonly blocks = new Map<number, Float64Array>();
  private readonly pages = new Map<number, Float64Array>();
  private readonly wantedBlocks = new Set<number>();
  private readonly wantedPages = new Set<number>();
  private readonly listeners = new Set<() => void>();
  private arrivals = 0;
  private nextRequest = 1;
  private flushScheduled = false;
  private complete = false;
  private buildTime = 0;
  private fromCache = false;
  private failure: string | undefined;

  private constructor(
    private readonly worker: Worker,
    opened: Extract<ColumnReply, { kind: 'opened' }>,
  ) {
    this.type = opened.type as Exclude<ColumnType, 'bit'>;
    this.rows = opened.rows;
    this.xStart = opened.xStart;
    this.xStep = opened.xStep;
    this.pyramid = new ColumnPyramid(opened.rows, this.type);
    worker.addEventListener('message', (event: MessageEvent<ColumnReply>) => {
      this.receive(event.data);
    });
  }

  /**
   * Opens a column: from the origin private file system (`{ opfs: 'data/run.tcol' }`), a File or Blob
   * (`{ file }`) or a server with range requests (`{ url }`). The pyramid is built in the background; charts draw
   * from the pieces read so far and refine.
   * @throws Error when the file is no column file or the column is not there.
   */
  static async open(location: ColumnLocation, options: LargeColumnOptions = {}): Promise<LargeColumn> {
    const worker =
      options.worker ?? new Worker(new URL('./column-worker-entry.js', import.meta.url), { type: 'module' });
    const opened = await new Promise<Extract<ColumnReply, { kind: 'opened' }>>((resolve, reject) => {
      const listen = (event: MessageEvent<ColumnReply>): void => {
        if (event.data.kind === 'opened') {
          worker.removeEventListener('message', listen);
          resolve(event.data);
        } else if (event.data.kind === 'error') {
          worker.removeEventListener('message', listen);
          reject(new Error(event.data.message));
        }
      };
      worker.addEventListener('message', listen);
      worker.addEventListener('error', () => {
        reject(new Error('The column worker did not start.'));
      });
      const request: ColumnRequest = {
        kind: 'open',
        location,
        column: options.column ?? 0,
        cache: options.cache ?? true,
      };
      worker.postMessage(request);
    });
    return new LargeColumn(worker, opened);
  }

  /** Grows with every piece of the pyramid and every block or page read. */
  get version(): number {
    return this.pyramid.version + this.arrivals;
  }

  /** Whether the pyramid is complete. */
  get isComplete(): boolean {
    return this.complete;
  }

  /** The share of the column the pyramid covers, from 0 to 1. */
  get progress(): number {
    return this.complete ? 1 : this.pyramid.progress;
  }

  /** How long the pyramid took, in milliseconds, once complete. */
  get buildMilliseconds(): number {
    return this.buildTime;
  }

  /** Whether the pyramid came from the cache in the origin private file system. */
  get isFromCache(): boolean {
    return this.fromCache;
  }

  /** The last error of the worker, if any. */
  get error(): string | undefined {
    return this.failure;
  }

  /** Calls the listener whenever something comes in; returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The values of a block of 256 rows when it was read, else `undefined` (then ask with {@link LargeColumn.wantBlock}). */
  block(index: number): Float64Array | undefined {
    const values = this.blocks.get(index);
    if (values) {
      this.blocks.delete(index);
      this.blocks.set(index, values);
    }
    return values;
  }

  /** Asks the worker for a block; it comes with a later version. */
  wantBlock(index: number): void {
    if (
      !this.blocks.has(index) &&
      !this.wantedBlocks.has(index) &&
      index >= 0 &&
      index * pyramidBlockSize < this.rows
    ) {
      this.wantedBlocks.add(index);
      this.schedule();
    }
  }

  /** The value of a row when its page was read, else `undefined` (then ask with {@link LargeColumn.wantRows}). */
  value(row: number): number | undefined {
    const page = this.pages.get(Math.floor(row / pageRows));
    return page?.[row % pageRows];
  }

  /** Whether all rows from `start` to before `end` are read. */
  hasRows(start: number, end: number): boolean {
    for (let page = Math.floor(start / pageRows); page * pageRows < end; page++) {
      const values = this.pages.get(page);
      if (!values) {
        return false;
      }
      this.pages.delete(page);
      this.pages.set(page, values);
    }
    return true;
  }

  /** Asks the worker for the pages of rows from `start` to before `end`. */
  wantRows(start: number, end: number): void {
    const first = Math.max(Math.floor(start / pageRows), 0);
    const last = Math.min(Math.ceil(end / pageRows), Math.ceil(this.rows / pageRows));
    for (let page = first; page < last; page++) {
      if (!this.pages.has(page) && !this.wantedPages.has(page)) {
        this.wantedPages.add(page);
        this.schedule();
      }
    }
  }

  /** Ends the worker. */
  dispose(): void {
    const request: ColumnRequest = { kind: 'close' };
    this.worker.postMessage(request);
    this.worker.terminate();
    this.blocks.clear();
    this.pages.clear();
  }

  private schedule(): void {
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      void Promise.resolve().then(() => {
        this.flush();
      });
    }
  }

  // The wishes of one frame go as one message each for blocks and one per page of rows.
  private flush(): void {
    this.flushScheduled = false;
    const blocks = [...this.wantedBlocks].filter((block) => !this.blocks.has(block));
    if (blocks.length > 0 && !this.blocksInFlight) {
      this.blocksInFlight = true;
      const request: ColumnRequest = { kind: 'blocks', request: this.nextRequest++, blocks };
      this.worker.postMessage(request);
    }
    for (const page of this.wantedPages) {
      if (!this.pagesInFlight.has(page)) {
        this.pagesInFlight.add(page);
        const request: ColumnRequest = {
          kind: 'rows',
          request: this.nextRequest++,
          start: page * pageRows,
          count: pageRows,
        };
        this.worker.postMessage(request);
      }
    }
  }

  private blocksInFlight = false;
  private readonly pagesInFlight = new Set<number>();

  private receive(reply: ColumnReply): void {
    switch (reply.kind) {
      case 'piece':
        this.pyramid.addPiece(reply.piece, reply.min, reply.max);
        break;
      case 'levels': {
        const levels: PyramidLevel[] = reply.min.map((min, i) => ({ min, max: reply.max[i] ?? new Float64Array(0) }));
        this.pyramid.setLevels(levels);
        break;
      }
      case 'complete':
        this.complete = true;
        this.buildTime = reply.milliseconds;
        this.fromCache = reply.fromCache;
        this.arrivals++;
        break;
      case 'blockValues':
        this.blocksInFlight = false;
        for (let i = 0; i < reply.blocks.length; i++) {
          const block = reply.blocks[i] ?? 0;
          this.wantedBlocks.delete(block);
          this.blocks.set(block, reply.values.subarray(i * pyramidBlockSize, (i + 1) * pyramidBlockSize));
        }
        while (this.blocks.size > maximumBlocks) {
          this.blocks.delete(this.blocks.keys().next().value as number);
        }
        this.arrivals++;
        // Wishes that came while the last request was on its way.
        if (this.wantedBlocks.size > 0) {
          this.schedule();
        }
        break;
      case 'rowValues': {
        const page = Math.floor(reply.start / pageRows);
        this.pagesInFlight.delete(page);
        this.wantedPages.delete(page);
        this.pages.set(page, reply.values);
        while (this.pages.size > maximumPages) {
          this.pages.delete(this.pages.keys().next().value as number);
        }
        this.arrivals++;
        break;
      }
      case 'error':
        this.failure = reply.message;
        break;
      default:
        return;
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
}
