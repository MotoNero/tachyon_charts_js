// The point tiles of two columns of a column file, on the main thread: the worker builds or opens them and counts
// the density of a view; this side knows the extent and hands out counts.
import type { ColumnLocation } from './column-worker';
import type { DensityView, PointTilesHeader } from './point-tiles-file';
import type { PointTilesReply, PointTilesRequest } from './point-tiles-worker';

/** Options of {@link PointTiles.open}. */
export interface PointTilesOptions {
  /** The column of X; 0 by default. */
  readonly xColumn?: number;
  /** The column of Y; 1 by default. */
  readonly yColumn?: number;
  /** Whether finished tiles are kept in the origin private file system and used again; on by default. */
  readonly cache?: boolean;
  /** A worker running `@tachyon-charts/large-data/point-tiles-worker`; by default one is started from this package. */
  readonly worker?: Worker;
}

/** The counts of a view, row 0 at the bottom, NaN where no point lies. */
export interface CountedView {
  /** The view counted. */
  readonly view: DensityView;
  /** The counts, `view.width` per row. */
  readonly values: Float32Array;
  /** The highest count. */
  readonly maximum: number;
  /** The points read; 0 when the grid was counted. */
  readonly drawn: number;
}

/** A scatter of two columns of a column file, sorted into point tiles for drawing as a density. */
export class PointTiles {
  /** The rows of the columns. */
  readonly rows: number;
  private header: PointTilesHeader | undefined;
  private share = 0;
  private buildTime = 0;
  private fromCache = false;
  private changes = 0;
  private nextRequest = 0;
  private failure: string | undefined;
  private readonly waiting = new Map<number, { resolve: (counted: CountedView) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<() => void>();

  private constructor(
    private readonly worker: Worker,
    rows: number,
  ) {
    this.rows = rows;
    worker.addEventListener('message', (event: MessageEvent<PointTilesReply>) => {
      this.receive(event.data);
    });
  }

  /**
   * Opens two columns of a column file: from the origin private file system (`{ opfs: 'data/points.tcol' }`), a File
   * or Blob (`{ file }`) or a server with range requests (`{ url }`). The tiles are built in the background.
   * @throws Error when the file is no column file or a column is not there.
   */
  static async open(location: ColumnLocation, options: PointTilesOptions = {}): Promise<PointTiles> {
    const worker =
      options.worker ?? new Worker(new URL('./point-tiles-worker-entry.js', import.meta.url), { type: 'module' });
    const early: PointTilesReply[] = [];
    const rows = await new Promise<number>((resolve, reject) => {
      const listen = (event: MessageEvent<PointTilesReply>): void => {
        if (event.data.kind === 'opened') {
          worker.removeEventListener('message', listen);
          resolve(event.data.rows);
        } else if (event.data.kind === 'error') {
          worker.removeEventListener('message', listen);
          reject(new Error(event.data.message));
        } else {
          early.push(event.data);
        }
      };
      worker.addEventListener('message', listen);
      worker.addEventListener('error', () => {
        reject(new Error('The point tiles worker did not start.'));
      });
      const request: PointTilesRequest = {
        kind: 'open',
        location,
        xColumn: options.xColumn ?? 0,
        yColumn: options.yColumn ?? 1,
        cache: options.cache ?? true,
      };
      worker.postMessage(request);
    });
    const tiles = new PointTiles(worker, rows);
    for (const reply of early) {
      tiles.receive(reply);
    }
    return tiles;
  }

  /** Whether the tiles are there, so that views can be counted. */
  get isReady(): boolean {
    return this.header !== undefined;
  }

  /** The share of the tiles built, from 0 to 1. */
  get progress(): number {
    return this.header ? 1 : this.share;
  }

  /** The points with finite X and Y; 0 until the tiles are ready. */
  get count(): number {
    return this.header?.count ?? 0;
  }

  /** The extent of the points, once the tiles are ready. */
  get extent(): { minX: number; maxX: number; minY: number; maxY: number } | undefined {
    return this.header;
  }

  /** How long the tiles took, in milliseconds, once ready. */
  get buildMilliseconds(): number {
    return this.buildTime;
  }

  /** Whether the tiles came from the cache in the origin private file system. */
  get isFromCache(): boolean {
    return this.fromCache;
  }

  /** Counts the changes: progress and readiness. */
  get version(): number {
    return this.changes;
  }

  /** The message of the last error of the worker, if any. */
  get error(): string | undefined {
    return this.failure;
  }

  /** Calls `listener` on every change; returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Counts the points of a view per pixel, reading at most `budget` points.
   * @throws Error when the tiles are not ready.
   */
  countView(view: DensityView, budget = 4_000_000): Promise<CountedView> {
    const request = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.waiting.set(request, { resolve, reject });
      const message: PointTilesRequest = { kind: 'count', request, view, budget };
      this.worker.postMessage(message);
    });
  }

  /** Stops the worker and releases the file. */
  close(): void {
    const message: PointTilesRequest = { kind: 'close' };
    this.worker.postMessage(message);
    this.worker.terminate();
    for (const { reject } of this.waiting.values()) {
      reject(new Error('The point tiles are closed.'));
    }
    this.waiting.clear();
  }

  private receive(reply: PointTilesReply): void {
    switch (reply.kind) {
      case 'progress':
        this.share = reply.share;
        break;
      case 'ready':
        this.header = reply.header;
        this.buildTime = reply.milliseconds;
        this.fromCache = reply.fromCache;
        break;
      case 'counted': {
        const waiting = this.waiting.get(reply.request);
        this.waiting.delete(reply.request);
        waiting?.resolve({ view: reply.view, values: reply.values, maximum: reply.maximum, drawn: reply.drawn });
        return;
      }
      case 'error':
        this.failure = reply.message;
        for (const { reject } of this.waiting.values()) {
          reject(new Error(reply.message));
        }
        this.waiting.clear();
        break;
      default:
        return;
    }
    this.changes++;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
