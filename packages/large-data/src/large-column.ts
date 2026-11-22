// A column of a file larger than memory, on the main thread: its column worker builds the pyramid and reads what a
// chart needs beyond it; this side keeps the pyramid and, through WorkerColumn, recently read blocks and rows.
import type { ColumnType } from './column-file';
import { ColumnPyramid, type Extremes, type PyramidLevel } from './column-pyramid';
import type { ColumnLocation, ColumnReply, ColumnRequest } from './column-worker';
import { WorkerColumn } from './worker-column';

/** Options of {@link LargeColumn.open}. */
export interface LargeColumnOptions {
  /** The column of the file; 0 by default. */
  readonly column?: number;
  /** Whether finished pyramids are kept in the origin private file system and used again; on by default. */
  readonly cache?: boolean;
  /** A worker running `@tachyon-charts/large-data/column-worker`; by default one is started from this package. */
  readonly worker?: Worker;
}

/** A column of a column file, opened for drawing. */
export class LargeColumn extends WorkerColumn {
  /** The type of the values. */
  readonly type: Exclude<ColumnType, 'bit'>;
  /** The pyramid; it fills while the worker reads the column. */
  readonly pyramid: ColumnPyramid;
  private readonly count: number;
  private readonly first: number;
  private readonly step: number;
  private complete = false;
  private buildTime = 0;
  private fromCache = false;
  private ends = 0;

  private constructor(worker: Worker, opened: Extract<ColumnReply, { kind: 'opened' }>) {
    super(worker);
    this.type = opened.type as Exclude<ColumnType, 'bit'>;
    this.count = opened.rows;
    this.first = opened.xStart;
    this.step = opened.xStep;
    this.pyramid = new ColumnPyramid(opened.rows, this.type);
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
    // The replies until the column exists wait, so that no piece of the pyramid is lost.
    const early: ColumnReply[] = [];
    const opened = await new Promise<Extract<ColumnReply, { kind: 'opened' }>>((resolve, reject) => {
      const listen = (event: MessageEvent<ColumnReply>): void => {
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
    const column = new LargeColumn(worker, opened);
    for (const reply of early) {
      column.receive(reply);
    }
    return column;
  }

  /** {@inheritDoc WorkerColumn.rows} */
  get rows(): number {
    return this.count;
  }

  /** {@inheritDoc WorkerColumn.xStart} */
  get xStart(): number {
    return this.first;
  }

  /** {@inheritDoc WorkerColumn.xStep} */
  get xStep(): number {
    return this.step;
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

  /** {@inheritDoc WorkerColumn.queryBlocks} */
  queryBlocks(firstBlock: number, endBlock: number, into: Extremes): Extremes {
    return this.pyramid.queryBlocks(firstBlock, endBlock, into);
  }

  /** {@inheritDoc WorkerColumn.total} */
  total(into: Extremes): Extremes {
    return this.pyramid.total(into);
  }

  /** {@inheritDoc WorkerColumn.dataVersion} */
  protected get dataVersion(): number {
    return this.pyramid.version + this.ends;
  }

  /** {@inheritDoc WorkerColumn.receive} */
  protected override receive(reply: ColumnReply): boolean {
    switch (reply.kind) {
      case 'piece':
        this.pyramid.addPiece(reply.piece, reply.min, reply.max);
        return true;
      case 'levels': {
        const levels: PyramidLevel[] = reply.min.map((min, i) => ({ min, max: reply.max[i] ?? new Float64Array(0) }));
        this.pyramid.setLevels(levels);
        return true;
      }
      case 'complete':
        this.complete = true;
        this.buildTime = reply.milliseconds;
        this.fromCache = reply.fromCache;
        this.ends++;
        return true;
      default:
        return super.receive(reply);
    }
  }
}
