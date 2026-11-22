// What a line over a column larger than memory needs, whoever holds the column: the extremes of whole blocks, blocks
// and rows read on request from a worker, and a version that grows with everything that comes in. LargeColumn (a
// file) and ColumnRecorder (a recording) build on it. Rows count from the first row kept; inside, blocks and pages
// count from the start of the column, so that the caches stay valid while a ring moves on.
import { pyramidBlockSize, type Extremes } from './column-pyramid';
import type { ColumnReply, ColumnRequest } from './column-worker';

/** Rows per page of the row cache. */
export const pageRows = 1 << 16;
/** Pages and blocks kept, the oldest go first: 64 MB of rows and 32 MB of blocks. */
const maximumPages = 128;
const maximumBlocks = 1 << 14;

/** A column a worker reads, as a line over it draws it. */
export abstract class WorkerColumn {
  private readonly blocks = new Map<number, Float64Array>();
  private readonly pages = new Map<number, Float64Array>();
  private readonly wantedBlocks = new Set<number>();
  private readonly wantedPages = new Set<number>();
  private readonly pagesInFlight = new Set<number>();
  private readonly listeners = new Set<() => void>();
  private blocksInFlight = false;
  private arrivals = 0;
  private nextRequest = 1;
  private flushScheduled = false;
  private failure: string | undefined;

  protected constructor(
    /** The worker that reads the column. */
    protected readonly worker: Worker,
  ) {
    worker.addEventListener('message', (event: MessageEvent<ColumnReply>) => {
      if (this.receive(event.data)) {
        this.notify();
      }
    });
  }

  /** The number of values. */
  abstract get rows(): number;
  /** The X of the first value. */
  abstract get xStart(): number;
  /** The X distance between two values. */
  abstract get xStep(): number;
  /** Whether the extremes of all blocks are known. */
  abstract get isComplete(): boolean;
  /** The share of the column whose extremes are known, from 0 to 1. */
  abstract get progress(): number;

  /** The extremes of the whole blocks from `firstBlock` to before `endBlock`, counted from the first row. */
  abstract queryBlocks(firstBlock: number, endBlock: number, into: Extremes): Extremes;

  /** The extremes of all values known so far. */
  abstract total(into: Extremes): Extremes;

  /** Grows with the data, every block or page read and every change of the column. */
  get version(): number {
    return this.dataVersion + this.arrivals;
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

  /** The values of a block of 256 rows when it was read, else `undefined` (then ask with {@link WorkerColumn.wantBlock}). */
  block(index: number): Float64Array | undefined {
    const at = index + this.offset / pyramidBlockSize;
    const values = this.blocks.get(at);
    if (values) {
      this.blocks.delete(at);
      this.blocks.set(at, values);
    }
    return values;
  }

  /** Asks the worker for a block; it comes with a later version. */
  wantBlock(index: number): void {
    const at = index + this.offset / pyramidBlockSize;
    if (!this.blocks.has(at) && !this.wantedBlocks.has(at) && index >= 0 && index * pyramidBlockSize < this.rows) {
      this.wantedBlocks.add(at);
      this.schedule();
    }
  }

  /** The value of a row when its page was read, else `undefined` (then ask with {@link WorkerColumn.wantRows}). */
  value(row: number): number | undefined {
    const at = row + this.offset;
    return this.pages.get(Math.floor(at / pageRows))?.[at % pageRows];
  }

  /** Whether all rows from `start` to before `end` are read. */
  hasRows(start: number, end: number): boolean {
    for (let page = Math.floor((start + this.offset) / pageRows); page * pageRows < end + this.offset; page++) {
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
    const offset = this.offset;
    const first = Math.floor((Math.max(start, 0) + offset) / pageRows);
    const last = Math.ceil((Math.min(end, this.rows) + offset) / pageRows);
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

  /** The number of the first row kept, counted from the start of the column; 0 for a file. */
  // A getter, not a field: a recording overrides it with its moving start.
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  protected get offset(): number {
    return 0;
  }

  /** The version of the data itself. */
  protected abstract get dataVersion(): number;

  /** Takes a reply of the worker; returns whether it changed something. */
  protected receive(reply: ColumnReply): boolean {
    switch (reply.kind) {
      case 'blockValues':
        this.blocksInFlight = false;
        for (let i = 0; i < reply.blocks.length; i++) {
          const block = reply.blocks[i] ?? 0;
          this.wantedBlocks.delete(block);
          // A copy each: a view would keep the whole reply alive as long as any of its blocks is kept.
          this.blocks.set(block, reply.values.slice(i * pyramidBlockSize, (i + 1) * pyramidBlockSize));
        }
        while (this.blocks.size > maximumBlocks) {
          this.blocks.delete(this.blocks.keys().next().value as number);
        }
        this.arrivals++;
        // Wishes that came while the last request was on its way.
        if (this.wantedBlocks.size > 0) {
          this.schedule();
        }
        return true;
      case 'rowValues': {
        const page = Math.floor(reply.start / pageRows);
        this.pagesInFlight.delete(page);
        this.wantedPages.delete(page);
        this.pages.set(page, reply.values);
        while (this.pages.size > maximumPages) {
          this.pages.delete(this.pages.keys().next().value as number);
        }
        this.arrivals++;
        return true;
      }
      case 'error':
        this.failure = reply.message;
        return true;
      default:
        return false;
    }
  }

  /** Tells the listeners that something changed. */
  protected notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Drops cached blocks and pages that touch rows from `start` to before `end`, counted from the start of the column. */
  protected forget(start: number, end: number): void {
    for (let block = Math.floor(start / pyramidBlockSize); block * pyramidBlockSize < end; block++) {
      this.blocks.delete(block);
    }
    for (let page = Math.floor(start / pageRows); page * pageRows < end; page++) {
      this.pages.delete(page);
    }
  }

  private schedule(): void {
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      void Promise.resolve().then(() => {
        this.flush();
      });
    }
  }

  // The wishes of one frame go as one message for blocks and one per page of rows.
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
}
