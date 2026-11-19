// Resamples the visible part of a series and keeps its pyramid up to date in the background (SeriesResampler of the
// .NET version). Until the pyramid catches up, queries scan the remaining values, with the same result.
import { FifoDataSource } from '../data/fifo-data-source';
import { emptySnapshot, type DataSnapshot, type PointSource } from '../data/source';
import type { DoubleRange } from '../numerics/range';
import { baseBlockSize, LodPyramid } from './lod-pyramid';
import { selectLttb } from './lttb';
import { decimateMinMax, lowerBound, upperBound, type ColumnArray } from './min-max-decimator';
import { sharedTypeOf, type MessageEndpoint, type PyramidReply, type PyramidRequest } from './pyramid-worker';

/**
 * How a series reduces its points for drawing: `auto` takes min/max for sorted data with more points than the columns
 * can show and otherwise all points; `none` all visible points; `minMax` the extremes per pixel column, which keeps
 * peaks; `lttb` a selection that keeps the shape. The last two need sorted X.
 */
export type ResamplingMode = 'auto' | 'none' | 'minMax' | 'lttb';

/** The outcome of a resampling; the resampler reuses the object for the next one. */
export interface ResampleResult {
  /** The mode applied, never `auto`. */
  mode: Exclude<ResamplingMode, 'auto'>;
  /** The visible points `[start, end)`. */
  start: number;
  end: number;
  /** The number of indices LTTB selected. */
  selectedCount: number;
}

/** Runs a job later on the same thread, between frames. */
export type Scheduler = (job: () => void) => void;

/** Options of a {@link SeriesResampler}. */
export interface ResamplerOptions {
  /** The blocks of one level that form a block of the next; 4. */
  readonly factor?: number;
  /** A worker serving pyramid requests, used while the Y values lie in a `SharedArrayBuffer`. */
  readonly worker?: MessageEndpoint;
  /** Runs the slices of building on this thread; the default waits for the next task with `setTimeout`. */
  readonly scheduler?: Scheduler;
  /** The values one slice on this thread scans; 262 144, about a quarter millisecond. */
  readonly sliceValues?: number;
}

interface TimerHost {
  setTimeout?: (job: () => void, delay: number) => unknown;
}

const nextTask: Scheduler = (job) => {
  const host = globalThis as TimerHost;
  if (host.setTimeout) {
    host.setTimeout(job, 0);
  } else {
    void Promise.resolve().then(job);
  }
};

let nextRequestId = 1;

/**
 * Resamples a data source. Append-only sources get a pyramid of extremes, built in a worker when one is given and the
 * values lie in shared memory, otherwise on this thread in slices between frames. A {@link FifoDataSource} overwrites
 * points, so it gets no pyramid and every query scans.
 */
export class SeriesResampler {
  private readonly usesPyramid: boolean;
  private readonly factor: number;
  private readonly scheduler: Scheduler;
  private readonly sliceBlocks: number;
  private readonly worker: MessageEndpoint | undefined;
  private pyramid: LodPyramid;
  private epoch = 0;
  private pending = false;
  private requestId = 0;
  private readonly view: DataSnapshot = emptySnapshot();
  private readonly result: ResampleResult = { mode: 'none', start: 0, end: 0, selectedCount: 0 };

  constructor(
    private readonly source: PointSource,
    options: ResamplerOptions = {},
  ) {
    this.factor = options.factor ?? LodPyramid.defaultFactor;
    this.pyramid = new LodPyramid(this.factor);
    this.usesPyramid = !(source instanceof FifoDataSource);
    this.scheduler = options.scheduler ?? nextTask;
    this.sliceBlocks = Math.max(Math.trunc((options.sliceValues ?? 262_144) / baseBlockSize), 1);
    this.worker = options.worker;
    this.worker?.addEventListener('message', (event) => {
      this.receive(event.data);
    });
    this.worker?.start?.();
  }

  /** The memory of the pyramid in bytes. */
  get pyramidByteCount(): number {
    return this.pyramid.byteCount;
  }

  /** The number of values the pyramid covers. */
  get coveredCount(): number {
    return this.pyramid.coveredCount;
  }

  /**
   * Resamples the visible range into `minima` and `maxima` (min/max) or `indices` (LTTB) and starts bringing the
   * pyramid up to date.
   */
  resample(
    visible: DoubleRange,
    mode: ResamplingMode,
    minima: ColumnArray,
    maxima: ColumnArray,
    indices: Int32Array,
  ): ResampleResult {
    const snapshot = this.source.snapshotInto(this.view);
    this.scheduleUpdate(snapshot);
    const result = this.result;
    result.selectedCount = 0;
    const { x, y, count } = snapshot;
    if (!snapshot.metadata.isSortedX) {
      return this.finish('none', 0, count);
    }
    const start = lowerBound(x, count, visible.min);
    const end = upperBound(x, count, visible.max);
    let applied = mode;
    if (applied === 'auto') {
      applied = end - start > minima.length * 2 ? 'minMax' : 'none';
    }
    if (applied === 'minMax') {
      const pyramid = this.usesPyramid && this.epoch === snapshot.epoch ? this.pyramid : undefined;
      decimateMinMax(x, y, count, pyramid, visible, minima, maxima);
      return this.finish('minMax', start, end);
    }
    if (applied === 'lttb') {
      result.selectedCount = selectLttb(x, y, indices, start, end);
      return this.finish('lttb', start, end);
    }
    return this.finish('none', start, end);
  }

  /** Brings the pyramid up to date on this thread, now. */
  updateNow(): void {
    if (this.usesPyramid) {
      const snapshot = this.source.snapshotInto(this.view);
      this.follow(snapshot);
      if (snapshot.metadata.isSortedX) {
        this.pyramid.update(snapshot.y, snapshot.count);
      }
    }
  }

  private finish(mode: ResampleResult['mode'], start: number, end: number): ResampleResult {
    this.result.mode = mode;
    this.result.start = start;
    this.result.end = end;
    return this.result;
  }

  /** Starts over with an empty pyramid when the source started over. */
  private follow(snapshot: DataSnapshot): void {
    if (snapshot.epoch !== this.epoch) {
      this.epoch = snapshot.epoch;
      this.pyramid = new LodPyramid(this.factor);
      this.pending = false;
      this.requestId = 0;
    }
  }

  private scheduleUpdate(snapshot: DataSnapshot): void {
    if (!this.usesPyramid) {
      return;
    }
    this.follow(snapshot);
    if (this.pending || !snapshot.metadata.isSortedX) {
      return;
    }
    const lastBlock = Math.floor(snapshot.count / baseBlockSize);
    const firstBlock = Math.floor(this.pyramid.coveredCount / baseBlockSize);
    if (lastBlock <= firstBlock) {
      return;
    }
    this.pending = true;
    const type = this.worker ? sharedTypeOf(snapshot.y) : undefined;
    if (this.worker && type) {
      this.requestId = nextRequestId++;
      const y = snapshot.y;
      const request: PyramidRequest = {
        kind: 'tachyon-pyramid',
        id: this.requestId,
        buffer: y.buffer as SharedArrayBuffer,
        type,
        byteOffset: y.byteOffset,
        firstBlock,
        lastBlock,
      };
      this.worker.postMessage(request, []);
    } else {
      this.scheduler(() => {
        this.slice();
      });
    }
  }

  // One slice of building on this thread; schedules the next one while blocks are missing.
  private slice(): void {
    this.pending = false;
    const snapshot = this.source.snapshotInto(this.view);
    this.follow(snapshot);
    if (snapshot.metadata.isSortedX && !this.pyramid.update(snapshot.y, snapshot.count, this.sliceBlocks)) {
      this.scheduleUpdate(snapshot);
    }
  }

  private receive(data: unknown): void {
    const reply = data as Partial<PyramidReply>;
    if (reply.kind !== 'tachyon-pyramid' || reply.id !== this.requestId || !reply.min || !reply.max) {
      return;
    }
    this.pending = false;
    if (reply.firstBlock === Math.floor(this.pyramid.coveredCount / baseBlockSize)) {
      this.pyramid.addBlocks(reply.firstBlock, reply.min, reply.max);
    }
    // Points appended while the worker was busy follow at once.
    this.scheduleUpdate(this.source.snapshotInto(this.view));
  }
}
