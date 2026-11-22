// Raster files (TRAS) and their stages (TRAP), the formats of RasterFile, RasterFileWriter and RasterPyramid of the
// .NET version (docs/guide/file-formats.md): rows of float32 cells, and coarser copies, each half as fine in each
// direction that is longer than 1024 cells and not far shorter than the other, built once and kept beside.
import type { RasterReduction } from '@tachyon-charts/core';
import type { ByteSource } from './byte-source';
import type { ByteSink } from './column-file-writer';
import { Fnv1a64 } from './column-pyramid';

/** The size of the header of a raster file in bytes. */
export const rasterHeaderSize = 64;
/** The size of the header of a stages file in bytes. */
export const stagesHeaderSize = 128;
const rasterMagic = 0x53415254; // "TRAS"
const stagesMagic = 0x50415254; // "TRAP"
const formatVersion = 1;
const reductionCodes: Record<RasterReduction, number> = { nearest: 0, mean: 1, maximum: 2 };
/** Stages stop when neither side is longer than this. */
export const stageLimit = 1024;

/** Where a raster lies and how large it is. */
export interface RasterHeader {
  /** Cells per row. */
  readonly width: number;
  /** Rows. */
  readonly height: number;
  /** The left edge of the first column. */
  readonly xStart: number;
  /** The width of a column. */
  readonly xStep: number;
  /** The lower edge of the first row. */
  readonly yStart: number;
  /** The height of a row. */
  readonly yStep: number;
}

/** Writes the header of a raster file. */
export function writeRasterHeader(header: RasterHeader): Uint8Array {
  const bytes = new Uint8Array(rasterHeaderSize);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, rasterMagic, true);
  view.setInt32(4, formatVersion, true);
  view.setInt32(8, header.width, true);
  view.setBigInt64(16, BigInt(header.height), true);
  view.setFloat64(24, header.xStart, true);
  view.setFloat64(32, header.xStep, true);
  view.setFloat64(40, header.yStart, true);
  view.setFloat64(48, header.yStep, true);
  return bytes;
}

/**
 * Reads the header of a raster file.
 * @throws Error when the bytes are no raster file of version 1.
 */
export function readRasterHeader(bytes: Uint8Array): RasterHeader {
  if (bytes.length < rasterHeaderSize) {
    throw new Error('The file is too short for a raster file.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, rasterHeaderSize);
  if (view.getUint32(0, true) !== rasterMagic) {
    throw new Error('The file is no raster file (TRAS).');
  }
  if (view.getInt32(4, true) !== formatVersion) {
    throw new Error(`The raster file has version ${String(view.getInt32(4, true))}; this library reads version 1.`);
  }
  const header = {
    width: view.getInt32(8, true),
    height: Number(view.getBigInt64(16, true)),
    xStart: view.getFloat64(24, true),
    xStep: view.getFloat64(32, true),
    yStart: view.getFloat64(40, true),
    yStep: view.getFloat64(48, true),
  };
  if (header.width < 1 || header.height < 0) {
    throw new Error('The header of the raster file does not fit together.');
  }
  return header;
}

/** A raster file opened from a byte source; it reads the rows it is asked for. */
export class RasterFile implements RasterHeader {
  /** {@inheritDoc RasterHeader.width} */
  readonly width: number;
  /** {@inheritDoc RasterHeader.height} */
  readonly height: number;
  /** {@inheritDoc RasterHeader.xStart} */
  readonly xStart: number;
  /** {@inheritDoc RasterHeader.xStep} */
  readonly xStep: number;
  /** {@inheritDoc RasterHeader.yStart} */
  readonly yStart: number;
  /** {@inheritDoc RasterHeader.yStep} */
  readonly yStep: number;

  private constructor(
    private readonly source: ByteSource,
    header: RasterHeader,
  ) {
    this.width = header.width;
    this.height = header.height;
    this.xStart = header.xStart;
    this.xStep = header.xStep;
    this.yStart = header.yStart;
    this.yStep = header.yStep;
  }

  /**
   * Opens a raster file.
   * @throws Error when it is no raster file, or shorter than its header says.
   */
  static async open(source: ByteSource): Promise<RasterFile> {
    const header = readRasterHeader(await source.read(0, rasterHeaderSize));
    if (source.size < rasterHeaderSize + header.width * header.height * 4) {
      throw new Error('The raster file is shorter than its header says.');
    }
    return new RasterFile(source, header);
  }

  /** Reads `count` whole rows from `first` on. */
  async readRows(first: number, count: number): Promise<Float32Array> {
    const rows = Math.max(0, Math.min(count, this.height - first));
    const offset = rasterHeaderSize + first * this.width * 4;
    const bytes = this.source.readSync
      ? this.source.readSync(offset, rows * this.width * 4)
      : await this.source.read(offset, rows * this.width * 4);
    return floatsOf(bytes);
  }

  /** Reads `count` cells of a row from `column` on. */
  async readCells(row: number, column: number, count: number): Promise<Float32Array> {
    const offset = rasterHeaderSize + (row * this.width + column) * 4;
    const bytes = this.source.readSync
      ? this.source.readSync(offset, count * 4)
      : await this.source.read(offset, count * 4);
    return floatsOf(bytes);
  }

  /** Releases the source. */
  close(): void {
    this.source.close?.();
  }
}

// Floats over bytes, copied when they do not start on a multiple of four.
function floatsOf(bytes: Uint8Array): Float32Array {
  const own = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  return new Float32Array(own.buffer, own.byteOffset, own.byteLength / 4);
}

/** Writes a raster file row by row; closing writes the header. */
export class RasterFileWriter {
  private rows = 0;

  /**
   * @param sink - Where the file goes.
   * @param header - Width and where the raster lies; the height counts the rows appended.
   */
  constructor(
    private readonly sink: ByteSink,
    private readonly header: Omit<RasterHeader, 'height'>,
  ) {}

  /** The rows written. */
  get height(): number {
    return this.rows;
  }

  /**
   * Appends whole rows.
   * @throws RangeError when the values are no whole number of rows.
   */
  async append(values: ArrayLike<number>): Promise<void> {
    if (values.length % this.header.width !== 0) {
      throw new RangeError(
        `${String(values.length)} values are no whole number of rows of ${String(this.header.width)}.`,
      );
    }
    const floats = Float32Array.from(values);
    await this.sink.write(rasterHeaderSize + this.rows * this.header.width * 4, new Uint8Array(floats.buffer));
    this.rows += values.length / this.header.width;
  }

  /** Writes the header and completes the file. */
  async close(): Promise<void> {
    await this.sink.write(0, writeRasterHeader({ ...this.header, height: this.rows }));
    await this.sink.close();
  }
}

/** The sizes of the stages of a raster, finest first; none for a raster no larger than 1024 × 1024. */
export function stageSizes(width: number, height: number): { width: number; height: number }[] {
  const sizes: { width: number; height: number }[] = [];
  let w = width;
  let h = height;
  while (w > stageLimit || h > stageLimit) {
    const halveWidth = w > stageLimit && 2 * w > h;
    const halveHeight = h > stageLimit && 2 * h > w;
    w = halveWidth ? Math.ceil(w / 2) : w;
    h = halveHeight ? Math.ceil(h / 2) : h;
    sizes.push({ width: w, height: h });
  }
  return sizes;
}

/** The fingerprint of a raster as its stages file holds it: size, place and samples of 64 rows. */
export async function rasterFingerprint(file: RasterFile): Promise<bigint> {
  const hash = new Fnv1a64();
  const numbers = new DataView(new ArrayBuffer(44));
  numbers.setInt32(0, file.width, true);
  numbers.setBigInt64(4, BigInt(file.height), true);
  numbers.setFloat64(12, file.xStart, true);
  numbers.setFloat64(20, file.xStep, true);
  numbers.setFloat64(28, file.yStart, true);
  numbers.setFloat64(36, file.yStep, true);
  hash.add(new Uint8Array(numbers.buffer));
  for (let sample = 0; sample < 64 && file.height > 0; sample++) {
    const row = await file.readRows(Math.floor((file.height * sample) / 64), 1);
    const part = row.subarray(0, Math.min(row.length, 256));
    hash.add(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
  }
  return hash.value;
}

/** What a stages file says in its header. */
export interface StagesHeader {
  /** How the stages combine the cells. */
  readonly reduction: RasterReduction;
  /** The fingerprint of the raster. */
  readonly fingerprint: bigint;
  /** The lowest finite value of the raster. */
  readonly low: number;
  /** The highest finite value of the raster. */
  readonly high: number;
}

/** Writes the header of a stages file. */
export function writeStagesHeader(header: StagesHeader): Uint8Array {
  const bytes = new Uint8Array(stagesHeaderSize);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, stagesMagic, true);
  view.setInt32(4, formatVersion, true);
  view.setInt32(8, reductionCodes[header.reduction], true);
  view.setBigUint64(16, header.fingerprint, true);
  view.setFloat64(24, header.low, true);
  view.setFloat64(32, header.high, true);
  return bytes;
}

/** Reads the header of a stages file; `undefined` for anything else. */
export function readStagesHeader(bytes: Uint8Array): StagesHeader | undefined {
  if (bytes.length < stagesHeaderSize) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, stagesHeaderSize);
  const code = view.getInt32(8, true);
  const reduction = (Object.keys(reductionCodes) as RasterReduction[]).find((name) => reductionCodes[name] === code);
  if (view.getUint32(0, true) !== stagesMagic || view.getInt32(4, true) !== formatVersion || !reduction) {
    return undefined;
  }
  return {
    reduction,
    fingerprint: view.getBigUint64(16, true),
    low: view.getFloat64(24, true),
    high: view.getFloat64(32, true),
  };
}

/** Where the stages are written and read back while they are built. */
export interface StagesStore {
  /** Writes bytes at a position. */
  write(offset: number, bytes: Uint8Array): void | Promise<void>;
  /** Reads bytes from a position. */
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
}

/** The place of a stage in a stages file, in bytes. */
export function stageOffset(sizes: readonly { width: number; height: number }[], stage: number): number {
  let offset = stagesHeaderSize;
  for (let i = 0; i < stage; i++) {
    offset += (sizes[i]?.width ?? 0) * (sizes[i]?.height ?? 0) * 4;
  }
  return offset;
}

/**
 * Builds the stages of a raster into a store, as RasterPyramid of the .NET version computes them: nearest takes the
 * upper-left cell, mean the mean of the finite cells (summed as doubles, rounded to float), maximum the highest finite
 * one; NaN without a finite cell. Returns the lowest and highest finite value of the raster.
 */
export async function buildStages(
  file: RasterFile,
  reduction: RasterReduction,
  store: StagesStore,
  onProgress?: (share: number) => void,
  isStopped?: () => boolean,
): Promise<{ low: number; high: number }> {
  const sizes = stageSizes(file.width, file.height);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  const extend = (row: Float32Array): void => {
    for (const value of row) {
      if (Number.isFinite(value)) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
  };
  if (sizes.length === 0) {
    for (let row = 0; row < file.height; row += 256) {
      extend(await file.readRows(row, 256));
    }
  }
  const total = sizes.reduce((sum, size) => sum + size.height, 0);
  let done = 0;
  let belowWidth = file.width;
  let belowHeight = file.height;
  for (let stage = 0; stage < sizes.length; stage++) {
    const { width, height } = sizes[stage] as { width: number; height: number };
    const halvesRows = height < belowHeight;
    const halvesColumns = width < belowWidth;
    const below = stage === 0 ? undefined : stageOffset(sizes, stage - 1);
    const target = stageOffset(sizes, stage);
    // Rows go out in batches, so that a store with a cost per write is not called for every row.
    const batchRows = Math.max(1, Math.floor((1 << 22) / (width * 4)));
    const batch = new Float32Array(batchRows * width);
    let batchFirst = 0;
    let batchCount = 0;
    for (let row = 0; row < height; row++) {
      if (isStopped?.()) {
        return { low, high };
      }
      const top = halvesRows ? row * 2 : row;
      const count = halvesRows && top + 1 < belowHeight ? 2 : 1;
      const rows =
        below === undefined
          ? await file.readRows(top, count)
          : floatsOf(await store.read(below + top * belowWidth * 4, count * belowWidth * 4));
      const upper = rows.subarray(0, belowWidth);
      const lower = count === 2 ? rows.subarray(belowWidth, 2 * belowWidth) : undefined;
      if (stage === 0) {
        extend(upper);
        if (lower) {
          extend(lower);
        }
      }
      const out = batch.subarray(batchCount * width, (batchCount + 1) * width);
      for (let column = 0; column < width; column++) {
        const left = halvesColumns ? column * 2 : column;
        const right = halvesColumns && left + 1 < belowWidth ? left + 1 : -1;
        out[column] = reduction === 'nearest' ? (upper[left] as number) : cell(upper, lower, left, right, reduction);
      }
      batchCount++;
      if (batchCount === batchRows || row === height - 1) {
        const bytes = new Uint8Array(batch.buffer, 0, batchCount * width * 4);
        await store.write(target + batchFirst * width * 4, bytes.slice());
        batchFirst += batchCount;
        batchCount = 0;
      }
      done++;
      if (done % 256 === 0) {
        onProgress?.(done / total);
      }
    }
    belowWidth = width;
    belowHeight = height;
  }
  return { low, high };
}

// A cell of a stage from up to four below.
function cell(
  upper: Float32Array,
  lower: Float32Array | undefined,
  left: number,
  right: number,
  reduction: RasterReduction,
): number {
  let sum = 0;
  let count = 0;
  let highest = Number.NEGATIVE_INFINITY;
  const take = (value: number): void => {
    if (Number.isFinite(value)) {
      sum += value;
      count++;
      highest = Math.max(highest, value);
    }
  };
  take(upper[left] as number);
  if (right >= 0) {
    take(upper[right] as number);
  }
  if (lower) {
    take(lower[left] as number);
    if (right >= 0) {
      take(lower[right] as number);
    }
  }
  if (count === 0) {
    return Number.NaN;
  }
  return reduction === 'maximum' ? highest : Math.fround(sum / count);
}
