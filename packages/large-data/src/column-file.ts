// Column files (TCOL), the same format as ColumnFile and ColumnFileWriter of the .NET version: a header of 64 bytes,
// all little-endian, then the values in blocks of rows, each block holding its rows of the first column, then of the
// second and so on (docs/guide/file-formats.md). A file is read in pieces, so it may be far larger than memory.
import type { ByteSource } from './byte-source';

/** The type of the values in a column file. */
export type ColumnType = 'float64' | 'float32' | 'int16' | 'int32' | 'bit';

/** The values of a piece of a column. */
export type ColumnValues = Float64Array | Float32Array | Int16Array | Int32Array;

/** The header of a column file. */
export interface ColumnHeader {
  /** The type of the values. */
  readonly type: ColumnType;
  /** The number of columns. */
  readonly columns: number;
  /** The number of rows. */
  readonly rows: number;
  /** The X of the first row. */
  readonly xStart: number;
  /** The X distance from one row to the next. */
  readonly xStep: number;
  /** The rows per block; 0 for one block holding all rows. */
  readonly blockRows: number;
}

/** The size of the header in bytes. */
export const columnHeaderSize = 64;
const magic = 0x4c4f4354; // "TCOL"
const formatVersion = 1;
const typeCodes: Record<ColumnType, number> = { float64: 1, float32: 2, int16: 3, int32: 4, bit: 5 };
const typesByCode: readonly (ColumnType | undefined)[] = [undefined, 'float64', 'float32', 'int16', 'int32', 'bit'];
const constructors = {
  float64: Float64Array,
  float32: Float32Array,
  int16: Int16Array,
  int32: Int32Array,
} as const;

/** The size of one value in bytes; 8 for the words of a bit column. */
export function columnValueSize(type: ColumnType): number {
  if (type === 'float64' || type === 'bit') {
    return 8;
  }
  return type === 'float32' || type === 'int32' ? 4 : 2;
}

/** The size of a file with this header in bytes. */
export function columnFileSize(header: ColumnHeader): number {
  const values = header.type === 'bit' ? Math.ceil(header.rows / 64) : header.rows * header.columns;
  return columnHeaderSize + values * columnValueSize(header.type);
}

/** Writes a header into 64 bytes. */
export function writeColumnHeader(header: ColumnHeader): Uint8Array {
  const bytes = new Uint8Array(columnHeaderSize);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, true);
  view.setInt32(4, formatVersion, true);
  view.setInt32(8, typeCodes[header.type], true);
  view.setInt32(12, header.columns, true);
  view.setBigInt64(16, BigInt(header.rows), true);
  view.setFloat64(24, header.xStart, true);
  view.setFloat64(32, header.xStep, true);
  view.setBigInt64(40, BigInt(header.blockRows), true);
  return bytes;
}

/**
 * Reads a header.
 * @throws Error when the bytes are no column file of version 1 or the header does not fit together.
 */
export function readColumnHeader(bytes: Uint8Array): ColumnHeader {
  if (bytes.length < columnHeaderSize) {
    throw new Error('The file is too short for a column file.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, columnHeaderSize);
  if (view.getUint32(0, true) !== magic) {
    throw new Error('The file is no column file (TCOL).');
  }
  const version = view.getInt32(4, true);
  if (version !== formatVersion) {
    throw new Error(`The column file has version ${String(version)}; this library reads version 1.`);
  }
  const type = typesByCode[view.getInt32(8, true)];
  if (type === undefined) {
    throw new Error(`The column file has the unknown value type ${String(view.getInt32(8, true))}.`);
  }
  const header: ColumnHeader = {
    type,
    columns: view.getInt32(12, true),
    rows: Number(view.getBigInt64(16, true)),
    xStart: view.getFloat64(24, true),
    xStep: view.getFloat64(32, true),
    blockRows: Number(view.getBigInt64(40, true)),
  };
  if (header.columns < 1 || header.rows < 0 || header.blockRows < 0 || (type === 'bit' && header.columns !== 1)) {
    throw new Error('The header of the column file does not fit together.');
  }
  return header;
}

/**
 * A column file opened from a {@link ByteSource}: a File, an OPFS file or a file on a server. It reads the pieces it is
 * asked for and keeps nothing; the pyramid over the file decides what to read.
 */
export class ColumnFile implements ColumnHeader {
  /** {@inheritDoc ColumnHeader."type"} */
  readonly type: ColumnType;
  /** {@inheritDoc ColumnHeader.columns} */
  readonly columns: number;
  /** {@inheritDoc ColumnHeader.rows} */
  readonly rows: number;
  /** {@inheritDoc ColumnHeader.xStart} */
  readonly xStart: number;
  /** {@inheritDoc ColumnHeader.xStep} */
  readonly xStep: number;
  /** {@inheritDoc ColumnHeader.blockRows} */
  readonly blockRows: number;

  private constructor(
    private readonly source: ByteSource,
    header: ColumnHeader,
  ) {
    this.type = header.type;
    this.columns = header.columns;
    this.rows = header.rows;
    this.xStart = header.xStart;
    this.xStep = header.xStep;
    this.blockRows = header.blockRows;
  }

  /**
   * Opens a column file.
   * @throws Error when it is no column file, or shorter than its header says.
   */
  static async open(source: ByteSource): Promise<ColumnFile> {
    const header = readColumnHeader(await source.read(0, columnHeaderSize));
    if (source.size < columnFileSize(header)) {
      throw new Error(
        `The column file has ${String(source.size)} bytes; its header needs ${String(columnFileSize(header))}.`,
      );
    }
    return new ColumnFile(source, header);
  }

  /** Whether {@link ColumnFile.readSync} works: the source reads synchronously (an OPFS file in a worker). */
  get canReadSync(): boolean {
    return this.source.readSync !== undefined;
  }

  /** A column of the file, as a source of values at an even X step. */
  column(index = 0): FileColumn {
    this.checkColumn(index);
    return new FileColumn(this, index);
  }

  /**
   * Reads values of a column from `start` on: as many as lie one after the other there, at most `maxLength`. A file
   * of several blocks returns fewer at the end of a block; read on from where it stopped.
   * @returns The values, empty at or after the end.
   */
  async read(column: number, start: number, maxLength: number): Promise<ColumnValues> {
    const piece = this.locate(column, start, maxLength);
    return piece ? this.view(await this.source.read(piece.offset, piece.bytes)) : this.empty();
  }

  /** Reads as {@link ColumnFile.read}, synchronously; only where {@link ColumnFile.canReadSync}. */
  readSync(column: number, start: number, maxLength: number): ColumnValues {
    if (!this.source.readSync) {
      throw new Error('The source of this column file cannot read synchronously.');
    }
    const piece = this.locate(column, start, maxLength);
    return piece ? this.view(this.source.readSync(piece.offset, piece.bytes)) : this.empty();
  }

  /**
   * Reads the words of a bit column: 64 rows to a word, the first row in bit 0.
   * @returns At most `maxWords` words from `first` on.
   */
  async readWords(first: number, maxWords: number): Promise<BigUint64Array> {
    if (this.type !== 'bit') {
      throw new Error('Only a bit column has words.');
    }
    const count = Math.max(0, Math.min(maxWords, Math.ceil(this.rows / 64) - first));
    if (count === 0) {
      return new BigUint64Array(0);
    }
    const bytes = await this.source.read(columnHeaderSize + first * 8, count * 8);
    return new BigUint64Array(aligned(bytes, 8).buffer, 0, count);
  }

  /**
   * Reads the words of a bit column as 32-bit words, two to each 64-bit word of the file and in the same order of bits:
   * bit i of the column is bit (i % 32) of word i / 32.
   * @returns At most `maxWords` words from `first` on.
   */
  async readWords32(first: number, maxWords: number): Promise<Uint32Array> {
    if (this.type !== 'bit') {
      throw new Error('Only a bit column has words.');
    }
    const count = Math.max(0, Math.min(maxWords, Math.ceil(this.rows / 64) * 2 - first));
    if (count === 0) {
      return new Uint32Array(0);
    }
    const bytes = this.source.readSync
      ? this.source.readSync(columnHeaderSize + first * 4, count * 4)
      : await this.source.read(columnHeaderSize + first * 4, count * 4);
    return new Uint32Array(aligned(bytes, 4).buffer, aligned(bytes, 4).byteOffset, count);
  }

  /** Releases the source, such as the lock of an OPFS file. */
  close(): void {
    this.source.close?.();
  }

  private checkColumn(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.columns) {
      throw new RangeError(`The file has columns 0 to ${String(this.columns - 1)}, not ${String(index)}.`);
    }
  }

  // Where the values from `start` lie, up to the end of their block.
  private locate(column: number, start: number, maxLength: number): { offset: number; bytes: number } | undefined {
    if (this.type === 'bit') {
      throw new Error('A bit column is read in words, with readWords.');
    }
    this.checkColumn(column);
    if (start < 0 || start >= this.rows || maxLength <= 0) {
      return undefined;
    }
    const size = columnValueSize(this.type);
    let index: number;
    let count: number;
    if (this.blockRows === 0) {
      count = Math.min(maxLength, this.rows - start);
      index = column * this.rows + start;
    } else {
      const block = Math.floor(start / this.blockRows);
      const within = start - block * this.blockRows;
      const inBlock = Math.min(this.blockRows, this.rows - block * this.blockRows);
      count = Math.min(maxLength, inBlock - within);
      index = block * this.blockRows * this.columns + column * inBlock + within;
    }
    return { offset: columnHeaderSize + index * size, bytes: count * size };
  }

  private view(bytes: Uint8Array): ColumnValues {
    const type = this.type as Exclude<ColumnType, 'bit'>;
    const size = columnValueSize(type);
    const own = aligned(bytes, size);
    return new constructors[type](own.buffer, own.byteOffset, own.byteLength / size);
  }

  private empty(): ColumnValues {
    return new constructors[this.type as Exclude<ColumnType, 'bit'>](0);
  }
}

// Typed arrays need their offset to be a multiple of the value size; a copy fixes the rare piece that is not.
function aligned(bytes: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  if (bytes.byteOffset % size === 0 && bytes.buffer instanceof ArrayBuffer) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  return bytes.slice();
}

/** One column of a {@link ColumnFile}: values at an even X step, read in pieces. */
export class FileColumn {
  /** @internal */
  constructor(
    private readonly file: ColumnFile,
    /** The index of the column in its file. */
    readonly index: number,
  ) {}

  /** The number of values. */
  get count(): number {
    return this.file.rows;
  }

  /** The X of the first value. */
  get xStart(): number {
    return this.file.xStart;
  }

  /** The X distance between two values. */
  get xStep(): number {
    return this.file.xStep;
  }

  /** The version; a file does not change. */
  readonly version = 0;

  /** {@inheritDoc ColumnFile.read} */
  read(start: number, maxLength: number): Promise<ColumnValues> {
    return this.file.read(this.index, start, maxLength);
  }
}
