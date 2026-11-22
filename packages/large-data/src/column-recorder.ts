// A recording over hours, as ColumnRecorder of the .NET version: values go into column files of fixed size in the
// origin private file system, one after the other, in a ring (the oldest file goes) or on and on. This side keeps the
// extremes of the blocks of each file kept, about 1 % of the values, and is at once the source and the pyramid of a
// line over the recording; the values themselves stay on the disk and come back through the worker when a chart
// zooms in. A ring keeps its memory: files and their extremes go as new ones come.
import { ColumnPyramid, pyramidBlockSize, type Extremes } from './column-pyramid';
import type { RecorderReply, RecorderRequest, RecordingSettings } from './recorder-worker';
import { pageRows, WorkerColumn } from './worker-column';

/** Options of {@link ColumnRecorder.start}. */
export interface ColumnRecorderOptions {
  /** The folder in the origin private file system; `recordings` by default. */
  readonly folder?: string;
  /** The name of the files; `recording` by default. */
  readonly name?: string;
  /** The type of the values; `float32` by default. */
  readonly type?: 'float32' | 'float64';
  /** The values of a file; 64 Mi by default, as in .NET, a multiple of 65 536. */
  readonly fileValues?: number;
  /** The files kept, the oldest going first; 0 by default, which keeps all. */
  readonly maxFiles?: number;
  /** The X of the first value; 0 by default. */
  readonly xStart?: number;
  /** The X distance between two values; 1 by default. */
  readonly xStep?: number;
  /** A worker running `@tachyon-charts/large-data/recorder-worker`; by default one is started from this package. */
  readonly worker?: Worker;
}

/** A recording into column files that a line draws while it grows. */
export class ColumnRecorder extends WorkerColumn {
  /** The values of a file unless given: 64 Mi, as in .NET. */
  static readonly defaultFileValues = 1 << 26;
  private readonly settings: RecordingSettings;
  private readonly segments: ColumnPyramid[] = [];
  private firstFile = 0;
  private end = 0;
  private dropped = 0;
  private closed: Promise<void> | undefined;
  private readonly part: Extremes = { min: 0, max: 0 };

  private constructor(worker: Worker, settings: RecordingSettings) {
    super(worker);
    this.settings = settings;
  }

  /**
   * Starts a recording; files of an earlier recording of the same name are replaced.
   * @throws RangeError when the values of a file are no positive multiple of 65 536.
   */
  static async start(options: ColumnRecorderOptions = {}): Promise<ColumnRecorder> {
    const fileValues = options.fileValues ?? ColumnRecorder.defaultFileValues;
    if (!Number.isInteger(fileValues) || fileValues <= 0 || fileValues % pageRows !== 0) {
      throw new RangeError(`The values of a file must be a positive multiple of 65 536, not ${String(fileValues)}.`);
    }
    const settings: RecordingSettings = {
      folder: options.folder ?? 'recordings',
      name: options.name ?? 'recording',
      type: options.type ?? 'float32',
      fileValues,
      maxFiles: Math.max(0, options.maxFiles ?? 0),
      xStart: options.xStart ?? 0,
      xStep: options.xStep ?? 1,
    };
    const worker =
      options.worker ?? new Worker(new URL('./recorder-worker-entry.js', import.meta.url), { type: 'module' });
    await new Promise<void>((resolve, reject) => {
      const listen = (event: MessageEvent<RecorderReply>): void => {
        if (event.data.kind === 'started') {
          worker.removeEventListener('message', listen);
          resolve();
        } else if (event.data.kind === 'error') {
          worker.removeEventListener('message', listen);
          reject(new Error(event.data.message));
        }
      };
      worker.addEventListener('message', listen);
      const request: RecorderRequest = { kind: 'start', ...settings };
      worker.postMessage(request);
    });
    return new ColumnRecorder(worker, settings);
  }

  /** {@inheritDoc WorkerColumn.rows} */
  get rows(): number {
    return this.end - this.offset;
  }

  /** The X of the first value kept; it moves on with a ring. */
  get xStart(): number {
    return this.settings.xStart + this.offset * this.settings.xStep;
  }

  /** {@inheritDoc WorkerColumn.xStep} */
  get xStep(): number {
    return this.settings.xStep;
  }

  /** The values recorded since the start, those the ring let go included. */
  get recorded(): number {
    return this.end;
  }

  /** The number of files on the disk. */
  get fileCount(): number {
    return this.segments.length;
  }

  /** The extremes are always complete: they grow with the values. */
  // A getter, not a field: it overrides an abstract getter of WorkerColumn.
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  get isComplete(): boolean {
    return true;
  }

  /** {@inheritDoc ColumnRecorder.isComplete} */
  // A getter, not a field: it overrides an abstract getter of WorkerColumn.
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  get progress(): number {
    return 1;
  }

  /**
   * Appends values; they are written in the worker, and a line over the recording shows them with its next frame.
   * @throws Error after {@link ColumnRecorder.close}.
   */
  append(values: number | ArrayLike<number>): void {
    if (this.closed) {
      throw new Error('The recording is closed.');
    }
    const settings = this.settings;
    const all = typeof values === 'number' ? [values] : values;
    const typed = settings.type === 'float32' ? new Float32Array(all.length) : new Float64Array(all.length);
    typed.set(all);
    const start = this.end;
    for (let at = 0; at < typed.length;) {
      const file = Math.floor(this.end / settings.fileValues);
      if (file - this.firstFile === this.segments.length) {
        this.segments.push(new ColumnPyramid(settings.fileValues, settings.type));
        while (settings.maxFiles > 0 && this.segments.length > settings.maxFiles) {
          this.segments.shift();
          this.firstFile++;
          this.dropped++;
        }
      }
      const within = this.end - file * settings.fileValues;
      const take = Math.min(typed.length - at, settings.fileValues - within);
      this.addExtremes(this.segments[file - this.firstFile] as ColumnPyramid, within, typed, at, take);
      this.end += take;
      at += take;
    }
    // Blocks and pages read before held fewer values.
    this.forget(start, this.end);
    const request: RecorderRequest = { kind: 'append', values: typed };
    this.worker.postMessage(request, [typed.buffer]);
    this.notify();
  }

  /** {@inheritDoc WorkerColumn.queryBlocks} */
  queryBlocks(firstBlock: number, endBlock: number, into: Extremes): Extremes {
    const blocksPerFile = this.settings.fileValues / pyramidBlockSize;
    const first = firstBlock + this.offset / pyramidBlockSize;
    const end = endBlock + this.offset / pyramidBlockSize;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let file = Math.max(Math.floor(first / blocksPerFile), this.firstFile); file * blocksPerFile < end; file++) {
      const segment = this.segments[file - this.firstFile];
      if (!segment) {
        break;
      }
      const base = file * blocksPerFile;
      segment.queryBlocks(Math.max(first - base, 0), Math.min(end - base, blocksPerFile), this.part);
      if (this.part.min <= this.part.max) {
        low = Math.min(low, this.part.min);
        high = Math.max(high, this.part.max);
      }
    }
    into.min = low;
    into.max = high;
    return into;
  }

  /** {@inheritDoc WorkerColumn.total} */
  total(into: Extremes): Extremes {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const segment of this.segments) {
      segment.total(this.part);
      if (this.part.min <= this.part.max) {
        low = Math.min(low, this.part.min);
        high = Math.max(high, this.part.max);
      }
    }
    into.min = low;
    into.max = high;
    return into;
  }

  /** Writes the number of values into the last file and closes all; the files stay on the disk. */
  close(): Promise<void> {
    this.closed ??= new Promise<void>((resolve) => {
      const listen = (event: MessageEvent<RecorderReply>): void => {
        if (event.data.kind === 'closed' || event.data.kind === 'error') {
          this.worker.removeEventListener('message', listen);
          resolve();
        }
      };
      this.worker.addEventListener('message', listen);
      const request: RecorderRequest = { kind: 'close' };
      this.worker.postMessage(request);
    });
    return this.closed;
  }

  /** Closes the recording, then ends the worker. */
  override dispose(): void {
    void this.close().then(() => {
      this.worker.terminate();
    });
  }

  /** {@inheritDoc WorkerColumn.offset} */
  protected override get offset(): number {
    return this.firstFile * this.settings.fileValues;
  }

  /** {@inheritDoc WorkerColumn.dataVersion} */
  protected get dataVersion(): number {
    return this.end + this.dropped;
  }

  // The extremes of the blocks the values fall into, merged with what these blocks held before.
  private addExtremes(
    segment: ColumnPyramid,
    within: number,
    values: Float32Array | Float64Array,
    at: number,
    count: number,
  ): void {
    const firstBlock = Math.floor(within / pyramidBlockSize);
    const endBlock = Math.ceil((within + count) / pyramidBlockSize);
    const level = segment.levels[0];
    if (!level) {
      return;
    }
    const min = new Float64Array(endBlock - firstBlock);
    const max = new Float64Array(endBlock - firstBlock);
    for (let block = firstBlock; block < endBlock; block++) {
      let low = level.min[block] as number;
      let high = level.max[block] as number;
      const from = Math.max(block * pyramidBlockSize, within) - within + at;
      const to = Math.min((block + 1) * pyramidBlockSize, within + count) - within + at;
      for (let i = from; i < to; i++) {
        const value = values[i] as number;
        if (value < low && value !== Number.NEGATIVE_INFINITY) {
          low = value;
        }
        if (value > high && value !== Number.POSITIVE_INFINITY) {
          high = value;
        }
      }
      min[block - firstBlock] = low;
      max[block - firstBlock] = high;
    }
    segment.setBlocks(firstBlock, min, max);
  }
}
