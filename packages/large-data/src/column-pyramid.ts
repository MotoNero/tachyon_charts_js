// The pyramid of extremes over a column file, as ColumnPyramid of the .NET version (docs/guide/file-formats.md, TPYR):
// the minimum and maximum of blocks of 256 values, and of groups of 4 blocks on every level above, until a level has
// one block. It fills piece by piece; until then a query answers from the pieces read so far, and the rest is empty.
import { columnValueSize, type ColumnType } from './column-file';

/** Values per block of the lowest level. */
export const pyramidBlockSize = 256;
/** Blocks of a level per block of the level above. */
export const pyramidFactor = 4;
/** Values a pyramid reads at once while it is built: 4 Mi, as in .NET. */
export const pyramidPieceSize = (1 << 14) * pyramidBlockSize;

const magic = 0x52595054; // "TPYR"
const formatVersion = 1;
/** The size of the header of a pyramid file in bytes. */
export const pyramidHeaderSize = 64;

// The largest and smallest value of each type: the extremes of a block without finite values.
const largest: Record<Exclude<ColumnType, 'bit'>, number> = {
  float64: Number.MAX_VALUE,
  float32: 3.4028234663852886e38,
  int16: 32767,
  int32: 2147483647,
};
const smallest: Record<Exclude<ColumnType, 'bit'>, number> = {
  float64: -Number.MAX_VALUE,
  float32: -3.4028234663852886e38,
  int16: -32768,
  int32: -2147483648,
};

/** The extremes of a range; `min > max` when it holds no finite value. */
export interface Extremes {
  /** The smallest value. */
  min: number;
  /** The largest value. */
  max: number;
}

/** One level of a pyramid: the minima and maxima of its blocks. */
export interface PyramidLevel {
  /** The minima. */
  readonly min: Float64Array;
  /** The maxima. */
  readonly max: Float64Array;
}

/** The number of blocks on each level for a column of `count` values. */
export function pyramidLevelSizes(count: number): number[] {
  const sizes = [Math.ceil(count / pyramidBlockSize)];
  while ((sizes.at(-1) ?? 0) > 1) {
    sizes.push(Math.ceil((sizes.at(-1) ?? 0) / pyramidFactor));
  }
  return sizes;
}

/** The extremes of each block of 256 values in `values`, ignoring values that are not finite. */
export function blockExtremes(
  values: ArrayLike<number>,
  type: Exclude<ColumnType, 'bit'>,
  min: Float64Array,
  max: Float64Array,
): void {
  const empty = { low: largest[type], high: smallest[type] };
  for (let block = 0; block * pyramidBlockSize < values.length; block++) {
    let low = empty.low;
    let high = empty.high;
    const end = Math.min((block + 1) * pyramidBlockSize, values.length);
    for (let i = block * pyramidBlockSize; i < end; i++) {
      const value = values[i] as number;
      // Comparisons first: NaN fails both, infinities are rare and checked only when they would count.
      if (value < low && value !== Number.NEGATIVE_INFINITY) {
        low = value;
      }
      if (value > high && value !== Number.POSITIVE_INFINITY) {
        high = value;
      }
    }
    min[block] = low;
    max[block] = high;
  }
}

/**
 * The pyramid of a column: levels of extremes in memory (about 1 % of the column), filled piece by piece while it is
 * built, or at once from a pyramid file.
 */
export class ColumnPyramid {
  /** The levels, the lowest first. */
  readonly levels: readonly PyramidLevel[];
  private readonly pieces: Uint8Array;
  private piecesLeft: number;
  private changes = 0;

  /**
   * @param count - The number of values of the column.
   * @param type - The type of the values, for the extremes of empty blocks.
   */
  constructor(
    /** The number of values of the column. */
    readonly count: number,
    /** The type of the values. */
    readonly type: Exclude<ColumnType, 'bit'>,
  ) {
    this.levels = pyramidLevelSizes(count).map((size) => {
      const level = { min: new Float64Array(size), max: new Float64Array(size) };
      level.min.fill(largest[type]);
      level.max.fill(smallest[type]);
      return level;
    });
    const pieceCount = Math.ceil(count / pyramidPieceSize);
    this.pieces = new Uint8Array(pieceCount);
    this.piecesLeft = pieceCount;
  }

  /** The number of pieces the column is read in while the pyramid is built. */
  get pieceCount(): number {
    return this.pieces.length;
  }

  /** Whether every piece is in. */
  get isComplete(): boolean {
    return this.piecesLeft === 0;
  }

  /** The share of the pieces in, from 0 to 1. */
  get progress(): number {
    return this.pieces.length === 0 ? 1 : 1 - this.piecesLeft / this.pieces.length;
  }

  /** Grows with every piece that comes in. */
  get version(): number {
    return this.changes;
  }

  /** Whether a piece is in. */
  hasPiece(piece: number): boolean {
    return this.pieces[piece] === 1;
  }

  /** Takes the extremes of the blocks of one piece and updates the levels above them. */
  addPiece(piece: number, min: Float64Array, max: Float64Array): void {
    if (this.pieces[piece] === 1) {
      return;
    }
    const level0 = this.levels[0] as PyramidLevel;
    const first = piece * (pyramidPieceSize / pyramidBlockSize);
    level0.min.set(min, first);
    level0.max.set(max, first);
    this.pieces[piece] = 1;
    this.piecesLeft--;
    let start = first;
    let end = first + min.length;
    for (let level = 1; level < this.levels.length; level++) {
      start = Math.floor(start / pyramidFactor);
      end = Math.ceil(end / pyramidFactor);
      this.combine(level, start, end);
    }
    this.changes++;
  }

  /**
   * Sets the extremes of blocks of the lowest level from `first` on and updates the levels above them, as a recording
   * does while it grows.
   */
  setBlocks(first: number, min: ArrayLike<number>, max: ArrayLike<number>): void {
    const level0 = this.levels[0] as PyramidLevel;
    for (let i = 0; i < min.length; i++) {
      level0.min[first + i] = min[i] as number;
      level0.max[first + i] = max[i] as number;
    }
    let start = first;
    let end = first + min.length;
    for (let level = 1; level < this.levels.length; level++) {
      start = Math.floor(start / pyramidFactor);
      end = Math.ceil(end / pyramidFactor);
      this.combine(level, start, end);
    }
    this.changes++;
  }

  /** The extremes of the type for a block without finite values: largest minimum, smallest maximum. */
  get emptyMinimum(): number {
    return largest[this.type];
  }

  /** {@inheritDoc ColumnPyramid.emptyMinimum} */
  get emptyMaximum(): number {
    return smallest[this.type];
  }

  /** Takes all levels at once, as read from a pyramid file. */
  setLevels(levels: readonly PyramidLevel[]): void {
    if (levels.length !== this.levels.length) {
      throw new Error('The levels do not belong to this column.');
    }
    for (let level = 0; level < levels.length; level++) {
      (this.levels[level] as PyramidLevel).min.set((levels[level] as PyramidLevel).min);
      (this.levels[level] as PyramidLevel).max.set((levels[level] as PyramidLevel).max);
    }
    this.pieces.fill(1);
    this.piecesLeft = 0;
    this.changes++;
  }

  /**
   * The extremes of the whole blocks from `firstBlock` to before `endBlock` of the lowest level, from as high a level
   * as fits; blocks of pieces not yet in count as empty.
   */
  queryBlocks(firstBlock: number, endBlock: number, into: Extremes): Extremes {
    let low = largest[this.type];
    let high = smallest[this.type];
    let start = Math.max(firstBlock, 0);
    let end = Math.min(endBlock, (this.levels[0] as PyramidLevel).min.length);
    for (let level = 0; start < end && level < this.levels.length; level++) {
      const { min, max } = this.levels[level] as PyramidLevel;
      const last = level === this.levels.length - 1;
      while (start < end && (start % pyramidFactor !== 0 || last)) {
        low = Math.min(low, min[start] as number);
        high = Math.max(high, max[start] as number);
        start++;
      }
      while (end > start && end % pyramidFactor !== 0) {
        end--;
        low = Math.min(low, min[end] as number);
        high = Math.max(high, max[end] as number);
      }
      start /= pyramidFactor;
      end /= pyramidFactor;
    }
    into.min = low;
    into.max = high;
    return into;
  }

  /** The extremes of all values in so far. */
  total(into: Extremes): Extremes {
    const top = this.levels.at(-1) as PyramidLevel;
    into.min = top.min.length > 0 ? (top.min[0] as number) : largest[this.type];
    into.max = top.max.length > 0 ? (top.max[0] as number) : smallest[this.type];
    return into;
  }

  /** Whether extremes stand for a range without finite values. */
  isEmpty(extremes: Extremes): boolean {
    return extremes.min > extremes.max;
  }

  // The blocks of a level from the four below each.
  private combine(level: number, start: number, end: number): void {
    const below = this.levels[level - 1] as PyramidLevel;
    const { min, max } = this.levels[level] as PyramidLevel;
    const length = below.min.length;
    for (let block = start; block < end; block++) {
      let low = largest[this.type];
      let high = smallest[this.type];
      for (let child = block * pyramidFactor; child < Math.min((block + 1) * pyramidFactor, length); child++) {
        low = Math.min(low, below.min[child] as number);
        high = Math.max(high, below.max[child] as number);
      }
      min[block] = low;
      max[block] = high;
    }
  }
}

/** FNV-1a with 64 bits, as the fingerprint of the file formats. */
export class Fnv1a64 {
  private high = 0xcbf29ce4;
  private low = 0x84222325;

  /** Adds bytes. */
  add(bytes: Uint8Array): void {
    // 64-bit multiplication by 1099511628211 = 2^40 + 435 in 32-bit halves; faster than BigInt per byte.
    let high = this.high;
    let low = this.low;
    for (const byte of bytes) {
      low = (low ^ byte) >>> 0;
      const lowTimes = low * 435;
      const carry = Math.floor(lowTimes / 2 ** 32);
      const newLow = lowTimes >>> 0;
      high = (Math.imul(high, 435) + carry + ((low << 8) >>> 0)) >>> 0;
      low = newLow;
    }
    this.high = high;
    this.low = low;
  }

  /** The hash. */
  get value(): bigint {
    return (BigInt(this.high) << 32n) | BigInt(this.low);
  }
}

/** Writes a pyramid file: the header with the fingerprint, then each level as minima and maxima in the value type. */
export function writePyramidFile(pyramid: ColumnPyramid, fingerprint: bigint): Uint8Array {
  const size = columnValueSize(pyramid.type);
  const blocks = pyramid.levels.reduce((sum, level) => sum + level.min.length, 0);
  const bytes = new Uint8Array(pyramidHeaderSize + blocks * 2 * size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, true);
  view.setInt32(4, formatVersion, true);
  view.setInt32(8, size, true);
  view.setInt32(12, pyramid.levels.length, true);
  view.setBigInt64(16, BigInt(pyramid.count), true);
  view.setBigUint64(24, fingerprint, true);
  const Typed = typedArrayOf(pyramid.type);
  let offset = pyramidHeaderSize;
  for (const level of pyramid.levels) {
    for (const values of [level.min, level.max]) {
      const typed = new Typed(values.length);
      typed.set(values);
      bytes.set(new Uint8Array(typed.buffer), offset);
      offset += typed.byteLength;
    }
  }
  return bytes;
}

/**
 * Reads the levels of a pyramid file when it belongs to the column: same value size, count and fingerprint.
 * @returns The levels, or `undefined` for a file of another column, an older version or a broken one.
 */
export function readPyramidFile(
  bytes: Uint8Array,
  type: Exclude<ColumnType, 'bit'>,
  count: number,
  fingerprint: bigint,
): PyramidLevel[] | undefined {
  if (bytes.length < pyramidHeaderSize) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = columnValueSize(type);
  const sizes = pyramidLevelSizes(count);
  if (
    view.getUint32(0, true) !== magic ||
    view.getInt32(4, true) !== formatVersion ||
    view.getInt32(8, true) !== size ||
    view.getInt32(12, true) !== sizes.length ||
    Number(view.getBigInt64(16, true)) !== count ||
    view.getBigUint64(24, true) !== fingerprint ||
    bytes.length < pyramidHeaderSize + sizes.reduce((sum, blocks) => sum + blocks, 0) * 2 * size
  ) {
    return undefined;
  }
  const Typed = typedArrayOf(type);
  let offset = bytes.byteOffset + pyramidHeaderSize;
  const copy = bytes.byteOffset % size === 0 ? bytes : bytes.slice();
  if (copy !== bytes) {
    offset = pyramidHeaderSize;
  }
  return sizes.map((blocks) => {
    const read = (): Float64Array => {
      const values = Float64Array.from(new Typed(copy.buffer as ArrayBuffer, offset, blocks));
      offset += blocks * size;
      return values;
    };
    const min = read();
    const max = read();
    return { min, max };
  });
}

function typedArrayOf(
  type: Exclude<ColumnType, 'bit'>,
): Float64ArrayConstructor | Float32ArrayConstructor | Int16ArrayConstructor | Int32ArrayConstructor {
  switch (type) {
    case 'float64':
      return Float64Array;
    case 'float32':
      return Float32Array;
    case 'int16':
      return Int16Array;
    default:
      return Int32Array;
  }
}
