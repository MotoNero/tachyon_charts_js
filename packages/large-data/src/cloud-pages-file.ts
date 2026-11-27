// The points of a cloud far larger than memory, sorted once into pages, as CloudPages of the .NET version: along a curve
// through space, so that a page holds points that lie together, at most 32,768 to a page, each page in a random order so
// that its first points are a fair sample of it. The file is the format of the .NET version: a header, a table of the
// pages and the points as three floats from 0 to 1 of the whole.
import { SeededRandom } from '@tachyon-charts/core';
import type { ColumnFile } from './column-file';
import { Fnv1a64 } from './column-pyramid';
import type { StagesStore } from './raster-file';

/** The most points of a page. */
export const cloudPageSize = 32_768;
/** The bytes of the header of a pages file. */
export const cloudPagesHeaderSize = 128;
/** The bytes of an entry of the page table. */
export const cloudPageBytes = 40;
const magic = 0x444c4354; // "TCLD"
const formatVersion = 1;
const bits = 8;
const side = 1 << bits;
const cells = side * side * side;
const readRows = 1 << 20;

/** The header of a pages file. */
export interface CloudPagesHeader {
  /** The rows of the columns the pages come from. */
  readonly sourceCount: number;
  /** The points with finite coordinates. */
  readonly count: number;
  /** The number of pages. */
  readonly pageCount: number;
  /** The fingerprint of the columns. */
  readonly fingerprint: bigint;
  /** The lower corner of all points. */
  readonly low: readonly [number, number, number];
  /** The upper corner of all points. */
  readonly high: readonly [number, number, number];
}

/** Writes the header of a pages file. */
export function writeCloudPagesHeader(header: CloudPagesHeader): Uint8Array {
  const bytes = new Uint8Array(cloudPagesHeaderSize);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, true);
  view.setInt32(4, formatVersion, true);
  view.setBigInt64(8, BigInt(header.sourceCount), true);
  view.setBigInt64(16, BigInt(header.count), true);
  view.setInt32(24, header.pageCount, true);
  view.setBigUint64(32, header.fingerprint, true);
  [...header.low, ...header.high].forEach((value, i) => {
    view.setFloat64(40 + i * 8, value, true);
  });
  return bytes;
}

/** Reads the header of a pages file; undefined for another kind of file. */
export function readCloudPagesHeader(bytes: Uint8Array): CloudPagesHeader | undefined {
  if (bytes.length < cloudPagesHeaderSize) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== magic || view.getInt32(4, true) !== formatVersion) {
    return undefined;
  }
  const corner = (at: number): [number, number, number] => [
    view.getFloat64(at, true),
    view.getFloat64(at + 8, true),
    view.getFloat64(at + 16, true),
  ];
  return {
    sourceCount: Number(view.getBigInt64(8, true)),
    count: Number(view.getBigInt64(16, true)),
    pageCount: view.getInt32(24, true),
    fingerprint: view.getBigUint64(32, true),
    low: corner(40),
    high: corner(64),
  };
}

/** The fingerprint of three columns as cloud pages hold it: rows, size of a value, and 64 samples of each column. */
export async function cloudPagesFingerprint(
  file: ColumnFile,
  columns: readonly [number, number, number],
): Promise<bigint> {
  const hash = new Fnv1a64();
  const numbers = new DataView(new ArrayBuffer(12));
  numbers.setBigInt64(0, BigInt(file.rows), true);
  const sample = await file.read(columns[0], 0, 1);
  numbers.setInt32(8, sample.BYTES_PER_ELEMENT, true);
  hash.add(new Uint8Array(numbers.buffer));
  for (const column of columns) {
    for (let s = 0; s < 64 && file.rows > 0; s++) {
      const at = Math.floor((file.rows * s) / 64);
      const values = await file.read(column, at, Math.min(64, file.rows - at));
      hash.add(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    }
  }
  return hash.value;
}

// Reads the three columns piece by piece and hands on each point with finite coordinates; false when stopped.
async function eachPoint(
  file: ColumnFile,
  columns: readonly [number, number, number],
  take: (x: number, y: number, z: number) => void,
  isStopped?: () => boolean,
): Promise<boolean> {
  for (let start = 0; start < file.rows;) {
    if (isStopped?.()) {
      return false;
    }
    const read = (column: number, count: number): ArrayLike<number | bigint> | Promise<ArrayLike<number | bigint>> =>
      file.canReadSync ? file.readSync(column, start, count) : file.read(column, start, count);
    const xs = await read(columns[0], readRows);
    const ys = await read(columns[1], xs.length);
    const zs = await read(columns[2], Math.min(xs.length, ys.length));
    const length = Math.min(xs.length, ys.length, zs.length);
    for (let i = 0; i < length; i++) {
      const x = Number(xs[i]);
      const y = Number(ys[i]);
      const z = Number(zs[i]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        take(x, y, z);
      }
    }
    if (length === 0) {
      break;
    }
    start += length;
  }
  return true;
}

// The cell of the code along the curve: every third bit of the code belongs to one direction.
function decode(code: number): number {
  let cellX = 0;
  let cellY = 0;
  let cellZ = 0;
  for (let bit = 0; bit < bits; bit++) {
    cellX |= ((code >> (3 * bit)) & 1) << bit;
    cellY |= ((code >> (3 * bit + 1)) & 1) << bit;
    cellZ |= ((code >> (3 * bit + 2)) & 1) << bit;
  }
  return (cellZ * side + cellY) * side + cellX;
}

/** Options of {@link buildCloudPages}. */
export interface CloudPagesBuildOptions {
  /** Points sorted in memory at once; more go in further passes over the columns. 32 Mi by default (384 MB). */
  readonly bandPoints?: number;
  /** Called with the share done. */
  readonly onProgress?: (share: number) => void;
  /** Stops the build when it returns true. */
  readonly isStopped?: () => boolean;
}

/**
 * Sorts the points of three columns into pages and writes them into a store, as CloudPages of the .NET version: the
 * box of all points, the points per cell of a grid of 256 per side, the pages as the nodes of an octree over the cells
 * along a curve through space, then the points into their pages in bands of whole pages that fit in memory, each page
 * mixed in the order of System.Random(page). Returns the header, which it writes last; undefined when stopped.
 */
export async function buildCloudPages(
  file: ColumnFile,
  columns: readonly [number, number, number],
  store: StagesStore,
  options: CloudPagesBuildOptions = {},
): Promise<CloudPagesHeader | undefined> {
  const { isStopped, onProgress } = options;
  const fingerprint = await cloudPagesFingerprint(file, columns);
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  let total = 0;
  if (
    !(await eachPoint(
      file,
      columns,
      (x, y, z) => {
        low[0] = Math.min(low[0] as number, x);
        low[1] = Math.min(low[1] as number, y);
        low[2] = Math.min(low[2] as number, z);
        high[0] = Math.max(high[0] as number, x);
        high[1] = Math.max(high[1] as number, y);
        high[2] = Math.max(high[2] as number, z);
        total++;
      },
      isStopped,
    ))
  ) {
    return undefined;
  }
  if (total === 0) {
    low.splice(0, 3, 0, 0, 0);
    high.splice(0, 3, 1, 1, 1);
  }
  const scale = [0, 1, 2].map((i) => {
    const span = (high[i] as number) - (low[i] as number);
    return 1 / (span > 0 ? span : 1);
  });
  const inside = new Float32Array(3);
  const place = (x: number, y: number, z: number): number => {
    const u = (x - (low[0] as number)) * (scale[0] as number);
    const v = (y - (low[1] as number)) * (scale[1] as number);
    const w = (z - (low[2] as number)) * (scale[2] as number);
    inside[0] = u;
    inside[1] = v;
    inside[2] = w;
    const cx = Math.min(Math.max(Math.trunc(u * side), 0), side - 1);
    const cy = Math.min(Math.max(Math.trunc(v * side), 0), side - 1);
    const cz = Math.min(Math.max(Math.trunc(w * side), 0), side - 1);
    return (cz * side + cy) * side + cx;
  };
  // How many points fall into each cell.
  const counts = new Uint32Array(cells);
  await eachPoint(file, columns, (x, y, z) => {
    const cell = place(x, y, z);
    counts[cell] = (counts[cell] as number) + 1;
  });
  onProgress?.(0.2);
  // The cells along the curve that passes them in order, with the points before each, and the pages: the nodes of an
  // octree over the cells, each split while it holds more than a page; a single cell of more points fills pages of its
  // own.
  const starts = new Float64Array(cells);
  const before = new Float64Array(cells + 1);
  for (let code = 0; code < cells; code++) {
    const cell = decode(code);
    starts[cell] = before[code] as number;
    before[code + 1] = (before[code] as number) + (counts[cell] as number);
  }
  const pageFirst: number[] = [];
  const pageCount: number[] = [];
  const split = (start: number, size: number): void => {
    const count = (before[start + size] as number) - (before[start] as number);
    if (count === 0) {
      return;
    }
    if (count <= cloudPageSize || size === 1) {
      for (let first = before[start] as number; first < (before[start + size] as number); first += cloudPageSize) {
        pageFirst.push(first);
        pageCount.push(Math.min(cloudPageSize, (before[start + size] as number) - first));
      }
      return;
    }
    const child = size / 8;
    for (let i = 0; i < 8; i++) {
      split(start + i * child, child);
    }
  };
  split(0, cells);
  const pages = pageFirst.length;
  const pointsStart = cloudPagesHeaderSize + pages * cloudPageBytes;
  const table = new Uint8Array(pages * cloudPageBytes);
  const tableView = new DataView(table.buffer);
  const bandPoints = Math.max(cloudPageSize, options.bandPoints ?? 1 << 25);
  for (let first = 0; first < pages;) {
    // A band of whole pages whose points fit, at least one page.
    let end = first + 1;
    while (
      end < pages &&
      (pageFirst[end] as number) + (pageCount[end] as number) - (pageFirst[first] as number) <= bandPoints
    ) {
      end++;
    }
    const bandStart = pageFirst[first] as number;
    const bandEnd = (pageFirst[end - 1] as number) + (pageCount[end - 1] as number);
    const points = new Float32Array((bandEnd - bandStart) * 3);
    const cursor = starts.slice();
    const done = await eachPoint(
      file,
      columns,
      (x, y, z) => {
        const cell = place(x, y, z);
        const at = cursor[cell] as number;
        cursor[cell] = at + 1;
        if (at >= bandStart && at < bandEnd) {
          points.set(inside, (at - bandStart) * 3);
        }
      },
      isStopped,
    );
    if (!done) {
      return undefined;
    }
    // Each page in a random order, and its box.
    for (let page = first; page < end; page++) {
      const from = (pageFirst[page] as number) - bandStart;
      const count = pageCount[page] as number;
      const random = new SeededRandom(page);
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = count - 1; i >= 0; i--) {
        const j = random.nextInt(i + 1);
        for (let k = 0; k < 3; k++) {
          const a = (from + i) * 3 + k;
          const b = (from + j) * 3 + k;
          const kept = points[a] as number;
          points[a] = points[b] as number;
          points[b] = kept;
          lo[k] = Math.min(lo[k] as number, points[a]);
          hi[k] = Math.max(hi[k] as number, points[a]);
        }
      }
      const entry = page * cloudPageBytes;
      tableView.setBigInt64(entry, BigInt(pointsStart + (pageFirst[page] as number) * 12), true);
      tableView.setInt32(entry + 8, count, true);
      [...lo, ...hi].forEach((value, k) => {
        tableView.setFloat32(entry + 12 + k * 4, value, true);
      });
    }
    await store.write(pointsStart + bandStart * 12, new Uint8Array(points.buffer));
    onProgress?.(0.2 + 0.79 * (bandEnd / Math.max(1, total)));
    first = end;
  }
  await store.write(cloudPagesHeaderSize, table);
  const header: CloudPagesHeader = {
    sourceCount: file.rows,
    count: total,
    pageCount: pages,
    fingerprint,
    low: [low[0] as number, low[1] as number, low[2] as number],
    high: [high[0] as number, high[1] as number, high[2] as number],
  };
  await store.write(0, writeCloudPagesHeader(header));
  onProgress?.(1);
  return header;
}
