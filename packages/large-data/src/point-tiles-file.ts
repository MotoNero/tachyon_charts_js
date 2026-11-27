// Point tiles (TPTS), the format of PointTiles of the .NET version (docs/guide/file-formats.md): the points of a
// scatter sorted once into 1024 x 1024 tiles over their extent, each tile in a random order, and a grid of 4096 x 4096
// counts. A wide view counts the grid, a narrow one the points of the visible tiles, a fair share of each dense tile.
import type { ColumnFile } from './column-file';
import { Fnv1a64 } from './column-pyramid';
import type { StagesStore } from './raster-file';
import { SeededRandom } from '@tachyon-charts/core';

/** Tiles per side. */
export const tilesPerSide = 1024;
/** Cells of the count grid per side. */
export const gridSize = 4096;
const cellsPerTile = gridSize / tilesPerSide;
const tileCount = tilesPerSide * tilesPerSide;
/** The size of the header of a point tiles file in bytes. */
export const pointTilesHeaderSize = 128;
const offsetsBytes = (tileCount + 1) * 8;
const gridBytes = gridSize * gridSize * 4;
/** Where the points start in a point tiles file. */
export const pointsStart = pointTilesHeaderSize + offsetsBytes + gridBytes;
const magic = 0x53545054; // "TPTS"
const formatVersion = 1;
const readRows = 1 << 20;

/** What the header of a point tiles file says. */
export interface PointTilesHeader {
  /** The rows of the source columns. */
  readonly rows: number;
  /** The points with finite X and Y. */
  readonly count: number;
  /** The fingerprint of the source columns. */
  readonly fingerprint: bigint;
  /** The lowest X. */
  readonly minX: number;
  /** The highest X. */
  readonly maxX: number;
  /** The lowest Y. */
  readonly minY: number;
  /** The highest Y. */
  readonly maxY: number;
}

/** Writes the header of a point tiles file. */
export function writePointTilesHeader(header: PointTilesHeader): Uint8Array {
  const bytes = new Uint8Array(pointTilesHeaderSize);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, true);
  view.setInt32(4, formatVersion, true);
  view.setBigInt64(8, BigInt(header.rows), true);
  view.setBigInt64(16, BigInt(header.count), true);
  view.setBigUint64(24, header.fingerprint, true);
  view.setFloat64(32, header.minX, true);
  view.setFloat64(40, header.maxX, true);
  view.setFloat64(48, header.minY, true);
  view.setFloat64(56, header.maxY, true);
  return bytes;
}

/** Reads the header of a point tiles file; `undefined` for anything else. */
export function readPointTilesHeader(bytes: Uint8Array): PointTilesHeader | undefined {
  if (bytes.length < pointTilesHeaderSize) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, pointTilesHeaderSize);
  if (view.getUint32(0, true) !== magic || view.getInt32(4, true) !== formatVersion) {
    return undefined;
  }
  return {
    rows: Number(view.getBigInt64(8, true)),
    count: Number(view.getBigInt64(16, true)),
    fingerprint: view.getBigUint64(24, true),
    minX: view.getFloat64(32, true),
    maxX: view.getFloat64(40, true),
    minY: view.getFloat64(48, true),
    maxY: view.getFloat64(56, true),
  };
}

/** The fingerprint of two columns as point tiles hold it: rows, size of a value, and 64 samples of each column. */
export async function pointTilesFingerprint(file: ColumnFile, xColumn: number, yColumn: number): Promise<bigint> {
  const hash = new Fnv1a64();
  const numbers = new DataView(new ArrayBuffer(12));
  numbers.setBigInt64(0, BigInt(file.rows), true);
  const sample = await file.read(xColumn, 0, 1);
  numbers.setInt32(8, sample.BYTES_PER_ELEMENT, true);
  hash.add(new Uint8Array(numbers.buffer));
  for (const column of [xColumn, yColumn]) {
    for (let s = 0; s < 64 && file.rows > 0; s++) {
      const at = Math.floor((file.rows * s) / 64);
      const values = await file.read(column, at, Math.min(64, file.rows - at));
      hash.add(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    }
  }
  return hash.value;
}

// Reads both columns piece by piece and hands on each point with finite coordinates.
async function eachPoint(
  file: ColumnFile,
  xColumn: number,
  yColumn: number,
  take: (x: number, y: number) => void,
  isStopped?: () => boolean,
): Promise<boolean> {
  for (let start = 0; start < file.rows;) {
    if (isStopped?.()) {
      return false;
    }
    const xs = file.canReadSync ? file.readSync(xColumn, start, readRows) : await file.read(xColumn, start, readRows);
    const ys = file.canReadSync ? file.readSync(yColumn, start, xs.length) : await file.read(yColumn, start, xs.length);
    const length = Math.min(xs.length, ys.length);
    for (let i = 0; i < length; i++) {
      const x = Number(xs[i]);
      const y = Number(ys[i]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        take(x, y);
      }
    }
    if (length === 0) {
      break;
    }
    start += length;
  }
  return true;
}

/** Where a point lies: its tile and its place inside the tile from 0 to 1, as float. */
class Placement {
  private readonly scaleX: number;
  private readonly scaleY: number;
  /** The tile of the last point placed. */
  tile = 0;
  /** The place inside the tile in X. */
  insideX = 0;
  /** The place inside the tile in Y. */
  insideY = 0;

  constructor(
    private readonly minX: number,
    maxX: number,
    private readonly minY: number,
    maxY: number,
  ) {
    this.scaleX = tilesPerSide / (maxX > minX ? maxX - minX : 1);
    this.scaleY = tilesPerSide / (maxY > minY ? maxY - minY : 1);
  }

  place(x: number, y: number): void {
    const u = (x - this.minX) * this.scaleX;
    const v = (y - this.minY) * this.scaleY;
    const tileX = Math.min(Math.max(Math.trunc(u), 0), tilesPerSide - 1);
    const tileY = Math.min(Math.max(Math.trunc(v), 0), tilesPerSide - 1);
    this.tile = tileY * tilesPerSide + tileX;
    this.insideX = Math.min(Math.max(u - tileX, 0), 1);
    this.insideY = Math.min(Math.max(v - tileY, 0), 1);
  }
}

/** Options of {@link buildPointTiles}. */
export interface PointTilesBuildOptions {
  /** Points sorted in memory at once; more go in further passes over the columns. 32 Mi by default (256 MB). */
  readonly bandPoints?: number;
  /** Called with the share done. */
  readonly onProgress?: (share: number) => void;
  /** Stops the build when it returns true. */
  readonly isStopped?: () => boolean;
}

// The extent and the number of the points with finite X and Y; 0 to 1 on both axes without a point. Undefined when
// stopped.
async function extentOf(
  file: ColumnFile,
  xColumn: number,
  yColumn: number,
  isStopped: (() => boolean) | undefined,
): Promise<{ minX: number; maxX: number; minY: number; maxY: number; count: number } | undefined> {
  const extent = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    count: 0,
  };
  const done = await eachPoint(
    file,
    xColumn,
    yColumn,
    (x, y) => {
      extent.minX = Math.min(extent.minX, x);
      extent.maxX = Math.max(extent.maxX, x);
      extent.minY = Math.min(extent.minY, y);
      extent.maxY = Math.max(extent.maxY, y);
      extent.count++;
    },
    isStopped,
  );
  if (!done) {
    return undefined;
  }
  return extent.count === 0 ? { minX: 0, maxX: 1, minY: 0, maxY: 1, count: 0 } : extent;
}

/**
 * Builds point tiles from two columns of a column file into a store, as PointTiles of the .NET version: extent,
 * counts per tile, then the points sorted into their tiles in bands of tiles that fit in memory, each tile mixed in
 * the order of System.Random(tile) and its cells counted. Returns the header, which it writes last.
 */
export async function buildPointTiles(
  file: ColumnFile,
  xColumn: number,
  yColumn: number,
  store: StagesStore,
  options: PointTilesBuildOptions = {},
): Promise<PointTilesHeader | undefined> {
  const { isStopped, onProgress } = options;
  const fingerprint = await pointTilesFingerprint(file, xColumn, yColumn);
  const extent = await extentOf(file, xColumn, yColumn, isStopped);
  if (!extent) {
    return undefined;
  }
  const { minX, maxX, minY, maxY, count } = extent;
  const place = new Placement(minX, maxX, minY, maxY);
  const tileCounts = new Float64Array(tileCount);
  await eachPoint(file, xColumn, yColumn, (x, y) => {
    place.place(x, y);
    tileCounts[place.tile] = (tileCounts[place.tile] as number) + 1;
  });
  const offsets = new Float64Array(tileCount + 1);
  for (let i = 0; i < tileCount; i++) {
    offsets[i + 1] = (offsets[i] as number) + (tileCounts[i] as number);
  }
  const grid = new Uint32Array(gridSize * gridSize);
  const bandPoints = Math.max(1, options.bandPoints ?? 1 << 25);

  for (let first = 0; first < tileCount;) {
    // A band of whole tiles whose points fit, at least one tile.
    let end = first + 1;
    while (end < tileCount && (offsets[end + 1] as number) - (offsets[first] as number) <= bandPoints) {
      end++;
    }
    const bandStart = offsets[first] as number;
    const bandCount = (offsets[end] as number) - bandStart;
    if (bandCount > 0) {
      const points = new Float32Array(bandCount * 2);
      const cursors = offsets.slice(first, end);
      const done = await eachPoint(
        file,
        xColumn,
        yColumn,
        (x, y) => {
          place.place(x, y);
          if (place.tile >= first && place.tile < end) {
            const at = ((cursors[place.tile - first] as number) - bandStart) * 2;
            cursors[place.tile - first] = (cursors[place.tile - first] as number) + 1;
            points[at] = place.insideX;
            points[at + 1] = place.insideY;
          }
        },
        isStopped,
      );
      if (!done) {
        return undefined;
      }
      for (let tile = first; tile < end; tile++) {
        const from = (offsets[tile] as number) - bandStart;
        const size = (offsets[tile + 1] as number) - (offsets[tile] as number);
        shuffle(points, from, size, tile);
        countCells(points, from, size, tile, grid);
      }
      await store.write(pointsStart + bandStart * 8, new Uint8Array(points.buffer));

      onProgress?.(Math.min(0.99, (offsets[end] as number) / Math.max(1, count)));
    }
    first = end;
  }
  const offsetBytes = new BigInt64Array(tileCount + 1);
  for (let i = 0; i <= tileCount; i++) {
    offsetBytes[i] = BigInt(offsets[i] as number);
  }
  await store.write(pointTilesHeaderSize, new Uint8Array(offsetBytes.buffer));
  await store.write(pointTilesHeaderSize + offsetsBytes, new Uint8Array(grid.buffer));
  const header = { rows: file.rows, count, fingerprint, minX, maxX, minY, maxY };
  await store.write(0, writePointTilesHeader(header));
  onProgress?.(1);
  return header;
}

// The points of a tile in the order of System.Random(tile).NextInt64 from the last point down, as .NET mixes them.
function shuffle(points: Float32Array, from: number, count: number, tile: number): void {
  if (count < 2) {
    return;
  }
  const random = new SeededRandom(tile);
  for (let i = count - 1; i > 0; i--) {
    const j = random.nextInt64(i + 1);
    const a = (from + i) * 2;
    const b = (from + j) * 2;
    const x = points[a] as number;
    const y = points[a + 1] as number;
    points[a] = points[b] as number;
    points[a + 1] = points[b + 1] as number;
    points[b] = x;
    points[b + 1] = y;
  }
}

function countCells(points: Float32Array, from: number, count: number, tile: number, grid: Uint32Array): void {
  const tileX = tile % tilesPerSide;
  const tileY = Math.floor(tile / tilesPerSide);
  for (let i = 0; i < count; i++) {
    const cellX = Math.min(
      cellsPerTile - 1,
      Math.trunc(Math.fround((points[(from + i) * 2] as number) * cellsPerTile)),
    );
    const cellY = Math.min(
      cellsPerTile - 1,
      Math.trunc(Math.fround((points[(from + i) * 2 + 1] as number) * cellsPerTile)),
    );
    const at = (tileY * cellsPerTile + cellY) * gridSize + tileX * cellsPerTile + cellX;
    grid[at] = (grid[at] as number) + 1;
  }
}

/** The view a density is counted for: its size in pixels and the data at its edges. */
export interface DensityView {
  /** Pixels across. */
  readonly width: number;
  /** Pixels down. */
  readonly height: number;
  /** X at the left edge. */
  readonly left: number;
  /** X at the right edge. */
  readonly right: number;
  /** Y at the lower edge. */
  readonly bottom: number;
  /** Y at the upper edge. */
  readonly top: number;
}

/** The counts of a view: per pixel, row 0 at the top. */
export interface Density {
  /** The counts, `width` per row, row 0 at the top. */
  readonly bins: Float32Array;
  /** The highest count. */
  readonly maximum: number;
  /** The points read; 0 when the grid was counted. */
  readonly drawn: number;
}

/** Point tiles opened for counting: offsets and the levels of the grid in memory, the points read on demand. */
export class PointTilesReader {
  /** The levels of the grid, 4096 cells per side first, each half as many, down to 64. */
  readonly grids: Uint32Array[];

  private constructor(
    /** The header. */
    readonly header: PointTilesHeader,
    private readonly offsets: Float64Array,
    grid: Uint32Array,
    private readonly readPoints: (offset: number, length: number) => Uint8Array,
  ) {
    this.grids = [grid];
    for (let size = gridSize / 2; size >= 64; size /= 2) {
      const below = this.grids.at(-1) as Uint32Array;
      const level = new Uint32Array(size * size);
      for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) {
          const at = row * 2 * size * 2 + column * 2;
          level[row * size + column] =
            (below[at] as number) +
            (below[at + 1] as number) +
            (below[at + size * 2] as number) +
            (below[at + size * 2 + 1] as number);
        }
      }
      this.grids.push(level);
    }
  }

  /** Opens point tiles from a store that reads synchronously; `undefined` when the header does not fit. */
  static open(
    read: (offset: number, length: number) => Uint8Array,
    rows: number,
    fingerprint: bigint,
  ): PointTilesReader | undefined {
    const header = readPointTilesHeader(read(0, pointTilesHeaderSize));
    if (header?.rows !== rows || header.fingerprint !== fingerprint) {
      return undefined;
    }
    const raw = read(pointTilesHeaderSize, offsetsBytes);
    const own = raw.byteOffset % 8 === 0 ? raw : raw.slice();
    const big = new BigInt64Array(own.buffer, own.byteOffset, tileCount + 1);
    const offsets = new Float64Array(tileCount + 1);
    for (let i = 0; i <= tileCount; i++) {
      offsets[i] = Number(big[i]);
    }
    if (offsets[tileCount] !== header.count) {
      return undefined;
    }
    const gridRaw = read(pointTilesHeaderSize + offsetsBytes, gridBytes).slice();
    return new PointTilesReader(header, offsets, new Uint32Array(gridRaw.buffer), read);
  }

  /** The points of a tile. */
  tileCount(tileX: number, tileY: number): number {
    const tile = tileY * tilesPerSide + tileX;
    return (this.offsets[tile + 1] as number) - (this.offsets[tile] as number);
  }

  /** Up to `max` points of a tile from its start, each its place inside the tile as x, y from 0 to 1. */
  tilePoints(tileX: number, tileY: number, max: number): Float32Array {
    const tile = tileY * tilesPerSide + tileX;
    const start = this.offsets[tile] as number;
    const count = Math.min(max, (this.offsets[tile + 1] as number) - start);
    const bytes = this.readPoints(pointsStart + start * 8, count * 8);
    const own = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
    return new Float32Array(own.buffer, own.byteOffset, count * 2);
  }

  /**
   * Counts the points of a view per pixel as PointDensitySeries of the .NET version: from the finest level of the
   * grid with a cell or more per pixel, each cell shared out by area; else from the points of the visible tiles, at
   * most `budget` of them, each dense tile read in part and its points weighed for the rest.
   */
  count(view: DensityView, budget = 4_000_000): Density {
    const { width, height } = view;
    const bins = new Float32Array(width * height);
    const h = this.header;
    if (h.count === 0 || width < 1 || height < 1) {
      return { bins, maximum: 0, drawn: 0 };
    }
    const spanX = h.maxX - h.minX > 0 ? h.maxX - h.minX : 1;
    const spanY = h.maxY - h.minY > 0 ? h.maxY - h.minY : 1;
    const shareX = (view.right - view.left) / spanX;
    const shareY = (view.top - view.bottom) / spanY;
    let level = -1;
    for (let candidate = this.grids.length - 1; candidate >= 0; candidate--) {
      const cells = gridSize >> candidate;
      if (cells * shareX >= width && cells * shareY >= height) {
        level = candidate;
        break;
      }
    }
    let drawn = 0;
    if (level >= 0) {
      this.countGrid(view, level, spanX, spanY, bins);
    } else {
      drawn = this.countPoints(view, spanX, spanY, budget, bins);
    }
    let maximum = 0;
    for (const value of bins) {
      maximum = Math.max(maximum, value);
    }
    return { bins, maximum, drawn };
  }

  private countGrid(view: DensityView, level: number, spanX: number, spanY: number, bins: Float32Array): void {
    const h = this.header;
    const size = gridSize >> level;
    const grid = this.grids[level] as Uint32Array;
    const cellWidth = spanX / size;
    const cellHeight = spanY / size;
    const clamp = (value: number): number => Math.min(Math.max(value, 0), size - 1);
    const column0 = clamp(Math.floor((view.left - h.minX) / cellWidth));
    const column1 = clamp(Math.ceil((view.right - h.minX) / cellWidth));
    const row0 = clamp(Math.floor((view.bottom - h.minY) / cellHeight));
    const row1 = clamp(Math.ceil((view.top - h.minY) / cellHeight));
    const toX = (x: number): number => ((x - view.left) / (view.right - view.left)) * view.width;
    const toY = (y: number): number => ((view.top - y) / (view.top - view.bottom)) * view.height;
    const x0 = toX(h.minX);
    const dx = toX(h.minX + cellWidth) - x0;
    const y0 = toY(h.minY);
    const dy = toY(h.minY + cellHeight) - y0;
    const cellPixelsY = Math.abs(dy);
    const pass: GridPass = { view, grid, column0, column1, x0, dx, cellPixelsX: Math.abs(dx), bins };
    for (let row = row0; row <= row1; row++) {
      const top = Math.min(y0 + row * dy, y0 + (row + 1) * dy);
      const upper = Math.floor(top);
      const upperShare = Math.min(1, (upper + 1 - top) / cellPixelsY);
      const takesUpper = upper >= 0 && upper < view.height;
      const takesLower = upperShare < 1 && upper + 1 >= 0 && upper + 1 < view.height;
      if (!takesUpper && !takesLower) {
        continue;
      }
      const lowerShare = takesLower ? 1 - upperShare : 0;
      const upperTaken = takesUpper ? upperShare : 0;
      addGridRow(pass, row * size, upper, upperTaken, lowerShare);
    }
  }

  private countPoints(view: DensityView, spanX: number, spanY: number, budget: number, bins: Float32Array): number {
    const h = this.header;
    const tile = (value: number, min: number, span: number): number =>
      Math.min(Math.max(Math.floor(((value - min) / span) * tilesPerSide), 0), tilesPerSide - 1);
    const tx0 = tile(view.left, h.minX, spanX);
    const tx1 = tile(view.right, h.minX, spanX);
    const ty0 = tile(view.bottom, h.minY, spanY);
    const ty1 = tile(view.top, h.minY, spanY);
    let largest = 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        largest = Math.max(largest, this.tileCount(tx, ty));
      }
    }
    const sum = (cap: number, limit: number): number => {
      let total = 0;
      for (let ty = ty0; ty <= ty1 && total <= limit; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          total += Math.min(cap, this.tileCount(tx, ty));
        }
      }
      return total;
    };
    const cap = capWithin(sum, largest, budget);
    const planned = sum(cap, Number.MAX_SAFE_INTEGER);
    const tileWidth = spanX / tilesPerSide;
    const tileHeight = spanY / tilesPerSide;
    const toX = (x: number): number => ((x - view.left) / (view.right - view.left)) * view.width;
    const toY = (y: number): number => ((view.top - y) / (view.top - view.bottom)) * view.height;
    for (let ty = ty0; ty <= ty1; ty++) {
      const bottom = h.minY + ty * tileHeight;
      const ay = Math.fround(toY(bottom));
      const by = Math.fround(Math.fround(toY(bottom + tileHeight)) - ay);
      for (let tx = tx0; tx <= tx1; tx++) {
        const count = this.tileCount(tx, ty);
        if (count === 0) {
          continue;
        }
        const left = h.minX + tx * tileWidth;
        const ax = Math.fround(toX(left));
        const bx = Math.fround(Math.fround(toX(left + tileWidth)) - ax);
        const points = this.tilePoints(tx, ty, Math.min(count, cap));
        addPoints(view, points, Math.fround(count / (points.length / 2)), { ax, bx, ay, by }, bins);
      }
    }
    return planned;
  }
}

// The highest number of points per tile that keeps the sum within the budget, found by halving; all points of the
// largest tile when they fit.
function capWithin(sum: (cap: number, limit: number) => number, largest: number, budget: number): number {
  if (sum(largest, Number.MAX_SAFE_INTEGER) <= budget) {
    return largest;
  }
  let low = 1;
  let high = largest;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (sum(middle, budget) <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

// Adds the points of a tile, each with its weight, to the pixels they fall in; X and Y in the tile go to pixels as
// a + value * b, in float as the shader of the .NET version does.
function addPoints(
  view: DensityView,
  points: Float32Array,
  weight: number,
  tile: { readonly ax: number; readonly bx: number; readonly ay: number; readonly by: number },
  bins: Float32Array,
): void {
  const { ax, bx, ay, by } = tile;
  for (let i = 0; i < points.length; i += 2) {
    const pixelX = Math.fround(ax + Math.fround((points[i] as number) * bx));
    const pixelY = Math.fround(ay + Math.fround((points[i + 1] as number) * by));
    if (pixelY >= 0 && pixelY < view.height && pixelX >= 0 && pixelX < view.width) {
      const at = Math.trunc(pixelY) * view.width + Math.trunc(pixelX);
      bins[at] = (bins[at] as number) + weight;
    }
  }
}

// A row of grid cells going to the pixels of a view.
interface GridPass {
  readonly view: DensityView;
  readonly grid: Uint32Array;
  readonly column0: number;
  readonly column1: number;
  readonly x0: number;
  readonly dx: number;
  readonly cellPixelsX: number;
  readonly bins: Float32Array;
}

// Adds the cells of one grid row, starting at `rowStart`, to the pixel row `upper` and the one below by their shares.
function addGridRow(pass: GridPass, rowStart: number, upper: number, upperShare: number, lowerShare: number): void {
  const { view, grid, x0, dx, bins } = pass;
  for (let column = pass.column0; column <= pass.column1; column++) {
    const count = grid[rowStart + column] as number;
    if (count === 0) {
      continue;
    }
    const left = Math.min(x0 + column * dx, x0 + (column + 1) * dx);
    const first = Math.floor(left);
    const firstShare = Math.min(1, (first + 1 - left) / pass.cellPixelsX);
    if (upperShare > 0) {
      add(bins, view.width, upper, first, firstShare, count * upperShare);
    }
    if (lowerShare > 0) {
      add(bins, view.width, upper + 1, first, firstShare, count * lowerShare);
    }
  }
}

// Adds a count to a pixel and, by its share, to the one right of it.
function add(bins: Float32Array, width: number, row: number, column: number, share: number, count: number): void {
  const offset = row * width;
  if (column >= 0 && column < width) {
    bins[offset + column] = (bins[offset + column] as number) + count * share;
  }
  if (share < 1 && column + 1 >= 0 && column + 1 < width) {
    bins[offset + column + 1] = (bins[offset + column + 1] as number) + count * (1 - share);
  }
}
