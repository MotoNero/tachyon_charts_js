// A raster file larger than memory, on the main thread: its raster worker builds the stages and reads the regions a
// chart shows; this side knows the levels and hands out regions.
import type { RasterReduction } from '@tachyon-charts/core';
import type { ColumnLocation } from './column-worker';
import type { RasterRegion, RasterReply, RasterRequest } from './raster-worker';

/** Options of {@link LargeRaster.open}. */
export interface LargeRasterOptions {
  /** How the stages combine cells; the mean by default. */
  readonly reduction?: RasterReduction;
  /** Whether finished stages are kept in the origin private file system and used again; on by default. */
  readonly cache?: boolean;
  /** A worker running `@tachyon-charts/large-data/raster-worker`; by default one is started from this package. */
  readonly worker?: Worker;
}

/** The size of a level of a raster: the raster itself or one of its stages. */
export interface RasterLevel {
  /** Cells per row. */
  readonly width: number;
  /** Rows. */
  readonly height: number;
}

/** A raster file, opened for drawing. */
export class LargeRaster {
  /** Cells per row of the raster. */
  readonly width: number;
  /** Rows of the raster. */
  readonly height: number;
  /** The left edge of the first column. */
  readonly xStart: number;
  /** The width of a column. */
  readonly xStep: number;
  /** The lower edge of the first row. */
  readonly yStart: number;
  /** The height of a row. */
  readonly yStep: number;
  /** The levels, the raster itself first, then its stages from fine to coarse. */
  readonly levels: readonly RasterLevel[];
  private ready = false;
  private share = 0;
  private lowest = Number.NaN;
  private highest = Number.NaN;
  private buildTime = 0;
  private fromCache = false;
  private changes = 0;
  private nextRequest = 0;
  private failure: string | undefined;
  private readonly waiting = new Map<number, { resolve: (values: Float32Array) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<() => void>();

  private constructor(
    private readonly worker: Worker,
    opened: Extract<RasterReply, { kind: 'opened' }>,
  ) {
    this.width = opened.width;
    this.height = opened.height;
    this.xStart = opened.xStart;
    this.xStep = opened.xStep;
    this.yStart = opened.yStart;
    this.yStep = opened.yStep;
    this.levels = [{ width: opened.width, height: opened.height }, ...opened.stages];
    worker.addEventListener('message', (event: MessageEvent<RasterReply>) => {
      this.receive(event.data);
    });
  }

  /**
   * Opens a raster file: from the origin private file system (`{ opfs: 'data/map.tras' }`), a File or Blob
   * (`{ file }`) or a server with range requests (`{ url }`). The stages are built in the background.
   * @throws Error when the file is no raster file.
   */
  static async open(location: ColumnLocation, options: LargeRasterOptions = {}): Promise<LargeRaster> {
    const worker =
      options.worker ?? new Worker(new URL('./raster-worker-entry.js', import.meta.url), { type: 'module' });
    const early: RasterReply[] = [];
    const opened = await new Promise<Extract<RasterReply, { kind: 'opened' }>>((resolve, reject) => {
      const listen = (event: MessageEvent<RasterReply>): void => {
        if (event.data.kind === 'opened') {
          worker.removeEventListener('message', listen);
          resolve(event.data);
        } else if (event.data.kind === 'error') {
          worker.removeEventListener('message', listen);
          reject(new Error(event.data.message));
        } else {
          early.push(event.data);
        }
      };
      worker.addEventListener('message', listen);
      worker.addEventListener('error', () => {
        reject(new Error('The raster worker did not start.'));
      });
      const request: RasterRequest = {
        kind: 'open',
        location,
        reduction: options.reduction ?? 'mean',
        cache: options.cache ?? true,
      };
      worker.postMessage(request);
    });
    const raster = new LargeRaster(worker, opened);
    for (const reply of early) {
      raster.receive(reply);
    }
    return raster;
  }

  /** Whether the stages are there, so that every level can be read. */
  get isReady(): boolean {
    return this.ready;
  }

  /** The share of the stages built, from 0 to 1. */
  get progress(): number {
    return this.ready ? 1 : this.share;
  }

  /** The lowest finite value; NaN until the stages are ready. */
  get low(): number {
    return this.lowest;
  }

  /** The highest finite value; NaN until the stages are ready. */
  get high(): number {
    return this.highest;
  }

  /** How long the stages took, in milliseconds, once ready. */
  get buildMilliseconds(): number {
    return this.buildTime;
  }

  /** Whether the stages came from the cache in the origin private file system. */
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
   * Reads a region of a level, row 0 at the bottom, `columns` cells per row.
   * @throws Error when a stage is asked before the stages are ready.
   */
  readRegion(region: RasterRegion): Promise<Float32Array> {
    const request = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.waiting.set(request, { resolve, reject });
      const message: RasterRequest = { kind: 'region', request, region };
      this.worker.postMessage(message);
    });
  }

  /** Stops the worker and releases the file. */
  close(): void {
    const message: RasterRequest = { kind: 'close' };
    this.worker.postMessage(message);
    this.worker.terminate();
    for (const { reject } of this.waiting.values()) {
      reject(new Error('The raster is closed.'));
    }
    this.waiting.clear();
  }

  private receive(reply: RasterReply): void {
    switch (reply.kind) {
      case 'progress':
        this.share = reply.share;
        break;
      case 'ready':
        this.ready = true;
        this.lowest = reply.low;
        this.highest = reply.high;
        this.buildTime = reply.milliseconds;
        this.fromCache = reply.fromCache;
        break;
      case 'region': {
        const waiting = this.waiting.get(reply.request);
        this.waiting.delete(reply.request);
        waiting?.resolve(reply.values);
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
