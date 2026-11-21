// Writes column files (TCOL) as ColumnFileWriter of the .NET version: rows are appended, a file of several columns
// collects them in blocks, and closing writes the last block and the header.
import type { SyncAccessHandle } from './byte-source';
import { columnHeaderSize, columnValueSize, writeColumnHeader, type ColumnType } from './column-file';

/** Where the bytes of a column file go. */
export interface ByteSink {
  /** Writes bytes at a position. */
  write(offset: number, bytes: Uint8Array): void | Promise<void>;
  /** Completes the file. */
  close(): void | Promise<void>;
}

/** A sink in memory; its bytes become a `Blob` to download or to store. */
export class MemorySink implements ByteSink {
  private data = new Uint8Array(1 << 16);
  private length = 0;

  /** {@inheritDoc ByteSink.write} */
  write(offset: number, bytes: Uint8Array): void {
    const end = offset + bytes.length;
    if (end > this.data.length) {
      const grown = new Uint8Array(Math.max(end, this.data.length * 2));
      grown.set(this.data.subarray(0, this.length));
      this.data = grown;
    }
    this.data.set(bytes, offset);
    this.length = Math.max(this.length, end);
  }

  /** {@inheritDoc ByteSink.close} */
  close(): void {
    // Nothing to complete in memory.
  }

  /** The bytes written. */
  bytes(): Uint8Array {
    return this.data.slice(0, this.length);
  }
}

/** An OPFS file opened for synchronous access in a worker. */
export function syncHandleSink(handle: SyncAccessHandle): ByteSink {
  handle.truncate(0);
  return {
    write(offset, bytes) {
      handle.write(bytes, { at: offset });
    },
    close() {
      handle.flush();
      handle.close();
    },
  };
}

/** A file being written through `FileSystemWritableFileStream`, such as from `showSaveFilePicker` or OPFS. */
export function writableSink(stream: FileSystemWritableFileStream): ByteSink {
  return {
    write: (offset, bytes) => stream.write({ type: 'write', position: offset, data: bytes as Uint8Array<ArrayBuffer> }),
    close: () => stream.close(),
  };
}

/** Options of a {@link ColumnFileWriter}. */
export interface ColumnFileWriterOptions {
  /** The type of the values; `float64` by default. Bit columns are not written here. */
  readonly type?: Exclude<ColumnType, 'bit'>;
  /** The number of columns; 1 by default. */
  readonly columns?: number;
  /** The X of the first row; 0 by default. */
  readonly xStart?: number;
  /** The X distance between two rows; 1 by default. */
  readonly xStep?: number;
  /** The rows per block when there are several columns; 2²⁰ by default, as in .NET. */
  readonly blockRows?: number;
}

const arrays = { float64: Float64Array, float32: Float32Array, int16: Int16Array, int32: Int32Array } as const;

/** Writes a column file: append rows, then close. */
export class ColumnFileWriter {
  /** The rows per block for several columns, as in .NET. */
  static readonly defaultBlockRows = 1 << 20;
  private readonly type: Exclude<ColumnType, 'bit'>;
  private readonly columns: number;
  private readonly blockRows: number;
  private readonly block: Float64Array | Float32Array | Int16Array | Int32Array | undefined;
  private xStart: number;
  private xStep: number;
  private rowsInBlock = 0;
  private position = columnHeaderSize;
  private rows = 0;
  private closed = false;

  /**
   * @param sink - Where the file goes.
   * @param options - Type, columns, X and blocks.
   */
  constructor(
    private readonly sink: ByteSink,
    options: ColumnFileWriterOptions = {},
  ) {
    this.type = options.type ?? 'float64';
    this.columns = options.columns ?? 1;
    const blockRows = options.blockRows ?? ColumnFileWriter.defaultBlockRows;
    if (!Number.isInteger(this.columns) || this.columns < 1) {
      throw new RangeError(`A column file needs at least one column, not ${String(this.columns)}.`);
    }
    if (!Number.isInteger(blockRows) || blockRows < 1) {
      throw new RangeError(`A block needs at least one row, not ${String(blockRows)}.`);
    }
    this.xStart = options.xStart ?? 0;
    this.xStep = options.xStep ?? 1;
    this.blockRows = this.columns === 1 ? 0 : blockRows;
    this.block = this.columns === 1 ? undefined : new arrays[this.type](blockRows * this.columns);
  }

  /** The rows written. */
  get rowCount(): number {
    return this.rows;
  }

  /**
   * Appends rows: the values of a row next to each other, then the next row.
   * @throws RangeError when the values are no whole number of rows.
   */
  async append(values: ArrayLike<number>): Promise<void> {
    this.ensureOpen();
    if (values.length % this.columns !== 0) {
      throw new RangeError(
        `${String(values.length)} values are no whole number of rows of ${String(this.columns)} columns.`,
      );
    }
    const block = this.block;
    if (!block) {
      const typed = new arrays[this.type](values.length);
      typed.set(values);
      await this.writeValues(typed);
      this.rows += values.length;
      return;
    }
    const count = values.length / this.columns;
    for (let row = 0; row < count; row++) {
      for (let column = 0; column < this.columns; column++) {
        block[column * this.blockRows + this.rowsInBlock] = values[row * this.columns + column] as number;
      }
      this.rows++;
      if (++this.rowsInBlock === this.blockRows) {
        await this.flushBlock();
      }
    }
  }

  /** Sets the X of the first row and the step, when they are known only after the rows. */
  setX(xStart: number, xStep: number): void {
    this.ensureOpen();
    this.xStart = xStart;
    this.xStep = xStep;
  }

  /** Completes the file: the last block and the header. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.rowsInBlock > 0) {
      await this.flushBlock();
    }
    await this.sink.write(
      0,
      writeColumnHeader({
        type: this.type,
        columns: this.columns,
        rows: this.rows,
        xStart: this.xStart,
        xStep: this.xStep,
        blockRows: this.blockRows,
      }),
    );
    await this.sink.close();
  }

  // A block holds its rows of each column in turn; the last block only as many as it got.
  private async flushBlock(): Promise<void> {
    const block = this.block;
    if (!block) {
      return;
    }
    for (let column = 0; column < this.columns; column++) {
      const start = column * this.blockRows;
      await this.writeValues(block.subarray(start, start + this.rowsInBlock));
    }
    this.rowsInBlock = 0;
  }

  private async writeValues(values: Float64Array | Float32Array | Int16Array | Int32Array): Promise<void> {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.length * columnValueSize(this.type));
    await this.sink.write(this.position, bytes);
    this.position += bytes.length;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('The column file is closed.');
    }
  }
}
