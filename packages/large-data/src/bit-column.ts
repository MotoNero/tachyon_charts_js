// A digital channel from a bit column of a column file, as PackedBits over a file in the .NET version: the column
// worker builds the index of changes piece by piece over the whole file (blocks of 4096 points: does a point change,
// and the level of the first), and reads pages of bits when a view needs single points. Until a page is there, an
// answer leans to a change rather than none, so that a pixel column never loses its edge; the next frame is exact.
import { ChangeIndex, changeBlockSize, type DigitalSource } from '@tachyon-charts/core';
import { columnHeaderSize, writeColumnHeader } from './column-file';
import type { ByteSink } from './column-file-writer';
import { pyramidPieceSize } from './column-pyramid';
import { bitPageRows, type ColumnLocation, type ColumnReply, type ColumnRequest } from './column-worker';

/** Pages of bits kept, the oldest going first: 512 pages of 8 KB. */
const maximumPages = 512;

/** A bit column of a column file, opened as a digital channel. */
export class BitColumn implements DigitalSource {
  /** Which blocks of 4096 points change. */
  readonly index: ChangeIndex;
  /** The number of points. */
  readonly count: number;
  /** The X of the first point. */
  readonly xStart: number;
  /** The X distance between two points. */
  readonly xStep: number;
  private readonly starts: Uint8Array;
  private readonly pieces: Uint8Array;
  private piecesLeft: number;
  private readonly pages = new Map<number, Uint32Array>();
  private readonly wanted = new Set<number>();
  private readonly listeners = new Set<() => void>();
  private arrivals = 0;
  private nextRequest = 1;
  private failure: string | undefined;

  private constructor(
    private readonly worker: Worker,
    opened: Extract<ColumnReply, { kind: 'opened' }>,
  ) {
    this.count = opened.rows;
    this.xStart = opened.xStart;
    this.xStep = opened.xStep;
    this.index = new ChangeIndex(opened.rows);
    this.starts = new Uint8Array(Math.ceil(opened.rows / changeBlockSize));
    this.pieces = new Uint8Array(Math.ceil(opened.rows / pyramidPieceSize));
    this.piecesLeft = this.pieces.length;
    worker.addEventListener('message', (event: MessageEvent<ColumnReply>) => {
      this.receive(event.data);
    });
  }

  /**
   * Opens the bit column of a column file: from the origin private file system (`{ opfs }`), a File (`{ file }`) or a
   * server with range requests (`{ url }`). The index of changes is built in the background.
   * @throws Error when the file is no column file of bits.
   */
  static async open(location: ColumnLocation, options: { worker?: Worker } = {}): Promise<BitColumn> {
    const worker =
      options.worker ?? new Worker(new URL('./column-worker-entry.js', import.meta.url), { type: 'module' });
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
      const request: ColumnRequest = { kind: 'open', location, column: 0, cache: false };
      worker.postMessage(request);
    });
    if (opened.type !== 'bit') {
      worker.terminate();
      throw new Error('The column file holds no bits.');
    }
    const column = new BitColumn(worker, opened);
    for (const reply of early) {
      column.receive(reply);
    }
    return column;
  }

  /** {@inheritDoc @tachyon-charts/core#DigitalSource.version} */
  get version(): number {
    return this.index.version + this.arrivals;
  }

  /** Whether the index of changes covers the whole column. */
  get isComplete(): boolean {
    return this.piecesLeft === 0;
  }

  /** The share of the column the index covers, from 0 to 1. */
  get progress(): number {
    return this.pieces.length === 0 ? 1 : 1 - this.piecesLeft / this.pieces.length;
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

  /** {@inheritDoc @tachyon-charts/core#DigitalSource.levelAt} */
  levelAt(index: number): boolean {
    const page = this.page(index);
    if (page) {
      const within = index % bitPageRows;
      return (((page[within >>> 5] as number) >>> (within & 31)) & 1) === 1;
    }
    // A block without a change keeps the level of its first point.
    const block = Math.floor(index / changeBlockSize);
    if ((this.index.levels[0] as Uint8Array)[block] === 1) {
      this.want(index);
    }
    return this.starts[block] === 1;
  }

  /** {@inheritDoc @tachyon-charts/core#DigitalSource.nextChange} */
  nextChange(from: number, to: number): number {
    const start = Math.max(from, 1);
    const end = Math.min(to, this.count);
    if (start >= end) {
      return -1;
    }
    const flags = this.index.levels[0] as Uint8Array;
    // The rest of the first block, then the first block with a change.
    const headBlock = Math.floor(start / changeBlockSize);
    const headEnd = Math.min((headBlock + 1) * changeBlockSize, end);
    if (flags[headBlock] === 1) {
      const found = this.scan(start, headEnd);
      if (found !== -2) {
        if (found >= 0 || headEnd === end) {
          return found;
        }
      } else {
        // Not read yet: a change somewhere in this block, as far as the index knows.
        return start;
      }
    } else if (headEnd === end) {
      return -1;
    }
    const block = this.index.firstChangedBlock(headEnd / changeBlockSize, Math.ceil(end / changeBlockSize));
    if (block < 0) {
      return -1;
    }
    const found = this.scan(Math.max(block * changeBlockSize, 1), end);
    return found === -2 ? Math.max(block * changeBlockSize, start) : found;
  }

  /** Ends the worker. */
  dispose(): void {
    const request: ColumnRequest = { kind: 'close' };
    this.worker.postMessage(request);
    this.worker.terminate();
    this.pages.clear();
  }

  // The first change from `start` to before `end` from the pages of bits; -2 while a page is missing.
  private scan(start: number, end: number): number {
    for (let at = start; at < end;) {
      const page = this.page(at);
      if (!page) {
        this.want(at);
        return -2;
      }
      const within = at % bitPageRows;
      const word = within >>> 5;
      const previousBit = at === 0 ? 0 : this.bitBefore(at, page, within);
      if (previousBit < 0) {
        return -2;
      }
      let changes = ((page[word] as number) ^ (((page[word] as number) << 1) | previousBit)) >>> 0;
      changes &= (0xffffffff << (within & 31)) >>> 0;
      const wordEnd = at - (within & 31) + 32;
      if (end < wordEnd) {
        changes &= (1 << (end - (wordEnd - 32))) - 1;
      }
      if (changes !== 0) {
        return at - (within & 31) + (31 - Math.clz32(changes & -changes));
      }
      at = wordEnd;
    }
    return -1;
  }

  // The last bit of the word before the word of `at`; -1 while its page is missing.
  private bitBefore(at: number, page: Uint32Array, within: number): number {
    const word = within >>> 5;
    if (word > 0) {
      return ((page[word - 1] as number) >>> 31) & 1;
    }
    const before = this.page(at - 1);
    if (!before) {
      this.want(at - 1);
      return -1;
    }
    return ((before[before.length - 1] as number) >>> 31) & 1;
  }

  private page(index: number): Uint32Array | undefined {
    return this.pages.get(Math.floor(index / bitPageRows));
  }

  private want(index: number): void {
    const page = Math.floor(index / bitPageRows);
    if (!this.wanted.has(page) && !this.pages.has(page)) {
      this.wanted.add(page);
      const request: ColumnRequest = { kind: 'bits', request: this.nextRequest++, page };
      this.worker.postMessage(request);
    }
  }

  private receive(reply: ColumnReply): void {
    switch (reply.kind) {
      case 'bitPiece': {
        const first = (reply.piece * pyramidPieceSize) / changeBlockSize;
        this.starts.set(reply.starts, first);
        if (this.pieces[reply.piece] === 0) {
          this.pieces[reply.piece] = 1;
          this.piecesLeft--;
        }
        this.index.setBlocks(first, reply.changes);
        break;
      }
      case 'bitValues': {
        this.wanted.delete(reply.page);
        // A whole page always, the last one filled up with zeros.
        const page = new Uint32Array(bitPageRows / 32);
        page.set(reply.words);
        this.pages.set(reply.page, page);
        while (this.pages.size > maximumPages) {
          this.pages.delete(this.pages.keys().next().value as number);
        }
        this.arrivals++;
        break;
      }
      case 'complete':
        this.arrivals++;
        break;
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

/**
 * Writes a bit column, as BitFileWriter of the .NET version: levels as they come, 64 points to a word, the first in
 * bit 0; closing writes the last word and the header.
 */
export class BitFileWriter {
  private readonly word = new Uint32Array(2);
  private readonly buffer = new Uint32Array(1 << 14);
  private filled = 0;
  private points = 0;
  private position = columnHeaderSize;

  /**
   * @param sink - Where the file goes.
   * @param xStart - The X of the first point.
   * @param xStep - The X distance between two points.
   */
  constructor(
    private readonly sink: ByteSink,
    private readonly xStart = 0,
    private readonly xStep = 1,
  ) {}

  /** The points written. */
  get count(): number {
    return this.points;
  }

  /** Appends `count` points of one level; long runs go in whole words. */
  async append(level: boolean, count = 1): Promise<void> {
    let left = count;
    // Single points up to the next word of 64.
    while (left > 0 && this.points % 64 !== 0) {
      await this.appendPoint(level);
      left--;
    }
    // Whole words of the same level.
    const fill = level ? 0xffffffff : 0;
    while (left >= 64) {
      this.buffer[this.filled++] = fill;
      this.buffer[this.filled++] = fill;
      this.points += 64;
      left -= 64;
      if (this.filled === this.buffer.length) {
        await this.flush();
      }
    }
    while (left > 0) {
      await this.appendPoint(level);
      left--;
    }
  }

  private async appendPoint(level: boolean): Promise<void> {
    const bit = this.points % 64;
    if (level) {
      const half = bit >>> 5;
      this.word[half] = ((this.word[half] as number) | (1 << (bit & 31))) >>> 0;
    }
    this.points++;
    if (this.points % 64 === 0) {
      await this.pushWord();
    }
  }

  /** Completes the file: the last word and the header. */
  async close(): Promise<void> {
    if (this.points % 64 !== 0) {
      await this.pushWord();
    }
    await this.flush();
    await this.sink.write(
      0,
      writeColumnHeader({
        type: 'bit',
        columns: 1,
        rows: this.points,
        xStart: this.xStart,
        xStep: this.xStep,
        blockRows: 0,
      }),
    );
    await this.sink.close();
  }

  private async pushWord(): Promise<void> {
    this.buffer[this.filled++] = this.word[0] as number;
    this.buffer[this.filled++] = this.word[1] as number;
    this.word.fill(0);
    if (this.filled === this.buffer.length) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.filled > 0) {
      const bytes = new Uint8Array(this.buffer.buffer, 0, this.filled * 4).slice();
      await this.sink.write(this.position, bytes);
      this.position += bytes.length;
      this.filled = 0;
    }
  }
}
