// The column worker: it opens a column file, builds the pyramid of a column in pieces spread over the whole column
// (bit-reversed order, as in .NET, so that a coarse picture of all of it comes first), keeps finished pyramids in the
// origin private file system, and reads blocks and rows for the main thread.
import { blobSource, httpSource, opfsFile, opfsSource, type ByteSource, type SyncAccessHandle } from './byte-source';
import { changeBlockSize } from '@tachyon-charts/core';
import { ColumnFile, type ColumnType } from './column-file';
import {
  blockExtremes,
  ColumnPyramid,
  Fnv1a64,
  pyramidBlockSize,
  pyramidPieceSize,
  readPyramidFile,
  writePyramidFile,
} from './column-pyramid';

/** Where the file of a column comes from. */
export type ColumnLocation =
  | { readonly opfs: string }
  | { readonly file: Blob }
  | { readonly url: string; readonly headers?: Record<string, string> };

/** The messages to the column worker. */
export type ColumnRequest =
  | { readonly kind: 'open'; readonly location: ColumnLocation; readonly column: number; readonly cache: boolean }
  | { readonly kind: 'blocks'; readonly request: number; readonly blocks: readonly number[] }
  | { readonly kind: 'rows'; readonly request: number; readonly start: number; readonly count: number }
  | { readonly kind: 'bits'; readonly request: number; readonly page: number }
  | { readonly kind: 'close' };

/** The messages of the column worker. */
export type ColumnReply =
  | {
      readonly kind: 'opened';
      readonly type: ColumnType;
      readonly columns: number;
      readonly rows: number;
      readonly xStart: number;
      readonly xStep: number;
    }
  | { readonly kind: 'levels'; readonly min: Float64Array[]; readonly max: Float64Array[] }
  | { readonly kind: 'piece'; readonly piece: number; readonly min: Float64Array; readonly max: Float64Array }
  | { readonly kind: 'complete'; readonly milliseconds: number; readonly fromCache: boolean }
  | { readonly kind: 'blockValues'; readonly request: number; readonly blocks: number[]; readonly values: Float64Array }
  | { readonly kind: 'rowValues'; readonly request: number; readonly start: number; readonly values: Float64Array }
  | {
      readonly kind: 'bitPiece';
      readonly piece: number;
      readonly changes: Uint8Array;
      readonly starts: Uint8Array;
    }
  | { readonly kind: 'bitValues'; readonly request: number; readonly page: number; readonly words: Uint32Array }
  | { readonly kind: 'error'; readonly message: string };

/** Where messages go and come from: the global scope of the worker, or a port in tests. */
export interface ColumnEndpoint {
  /** Sends a message, handing over the buffers in `transfer`. */
  postMessage(message: unknown, transfer: Transferable[]): void;
  /** Listens for messages. */
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

/** The fingerprint of a column as the pyramid file holds it: count, X, and the first and last 4096 values. */
export async function columnFingerprint(file: ColumnFile, column: number): Promise<bigint> {
  const hash = new Fnv1a64();
  const numbers = new DataView(new ArrayBuffer(24));
  numbers.setBigInt64(0, BigInt(file.rows), true);
  numbers.setFloat64(8, file.xStart, true);
  numbers.setFloat64(16, file.xStep, true);
  hash.add(new Uint8Array(numbers.buffer));
  for (const start of [0, Math.max(0, file.rows - 4096)]) {
    for (let at = start, end = Math.min(file.rows, start + 4096); at < end;) {
      const values = await file.read(column, at, end - at);
      hash.add(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
      at += values.length;
    }
  }
  return hash.value;
}

/** The pieces of a column in bit-reversed order: every prefix of the order is spread over the whole column. */
export function pieceOrder(count: number): number[] {
  let bits = 0;
  while (1 << bits < count) {
    bits++;
  }
  const order: number[] = [];
  for (let i = 0; i < 1 << bits; i++) {
    let reversed = 0;
    for (let bit = 0; bit < bits; bit++) {
      if (i & (1 << bit)) {
        reversed |= 1 << (bits - 1 - bit);
      }
    }
    if (reversed < count) {
      order.push(reversed);
    }
  }
  return order;
}

async function sourceOf(location: ColumnLocation): Promise<ByteSource> {
  if ('opfs' in location) {
    return opfsSource(location.opfs);
  }
  if ('file' in location) {
    return blobSource(location.file);
  }
  return httpSource(location.url, location.headers ? { headers: location.headers } : {});
}

// Values of a range of rows of one column, across blocks of the file.
async function readRange(file: ColumnFile, column: number, start: number, count: number): Promise<Float64Array> {
  const values = new Float64Array(count);
  for (let at = 0; at < count;) {
    const piece = file.canReadSync
      ? file.readSync(column, start + at, count - at)
      : await file.read(column, start + at, count - at);
    if (piece.length === 0) {
      break;
    }
    values.set(piece, at);
    at += piece.length;
  }
  return values;
}

// Blocks closer than this go in one read: a read of OPFS costs about as much as some 30 blocks.
const blockGap = 32;

// The values of blocks of 256 rows, in the order asked, NaN beyond the end; neighbouring blocks are read together.
async function readBlocks(file: ColumnFile, column: number, blocks: readonly number[]): Promise<Float64Array> {
  const values = new Float64Array(blocks.length * pyramidBlockSize).fill(Number.NaN);
  const order = blocks.map((block, index) => ({ block, index })).sort((a, b) => a.block - b.block);
  for (let at = 0; at < order.length;) {
    let end = at + 1;
    while (end < order.length && (order[end]?.block ?? 0) - (order[end - 1]?.block ?? 0) <= blockGap) {
      end++;
    }
    const first = (order[at]?.block ?? 0) * pyramidBlockSize;
    const last = Math.min(((order[end - 1]?.block ?? 0) + 1) * pyramidBlockSize, file.rows);
    const run = await readRange(file, column, first, last - first);
    for (let i = at; i < end; i++) {
      const { block, index } = order[i] as { block: number; index: number };
      const offset = block * pyramidBlockSize - first;
      values.set(run.subarray(offset, Math.min(offset + pyramidBlockSize, run.length)), index * pyramidBlockSize);
    }
    at = end;
  }
  return values;
}

/** Points per page of bits a column worker reads at once. */
export const bitPageRows = 1 << 16;

const cacheFolder = 'tachyon-pyramids';

async function loadCached(name: string): Promise<Uint8Array | undefined> {
  try {
    const handle = await opfsFile(`${cacheFolder}/${name}`);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch {
    return undefined;
  }
}

async function saveCached(name: string, bytes: Uint8Array): Promise<void> {
  try {
    const handle = (await opfsFile(`${cacheFolder}/${name}`, true)) as unknown as {
      createSyncAccessHandle(): Promise<SyncAccessHandle>;
    };
    const access = await handle.createSyncAccessHandle();
    access.truncate(0);
    access.write(bytes, { at: 0 });
    access.flush();
    access.close();
  } catch {
    // A pyramid that cannot be kept is built again next time.
  }
}

/** Serves one column on an endpoint: call it in the module of the worker with its global scope. */
export function serveColumn(endpoint: ColumnEndpoint): void {
  let file: ColumnFile | undefined;
  let column = 0;
  let closed = false;
  const send = (reply: ColumnReply, transfer: Transferable[] = []): void => {
    endpoint.postMessage(reply, transfer);
  };

  const build = async (cache: boolean): Promise<void> => {
    const opened = file as ColumnFile;
    const type = opened.type as Exclude<ColumnType, 'bit'>;
    const start = performance.now();
    const fingerprint = await columnFingerprint(opened, column);
    const name = `${fingerprint.toString(16).padStart(16, '0')}-${String(column)}.tpyr`;
    if (cache) {
      const bytes = await loadCached(name);
      const levels = bytes && readPyramidFile(bytes, type, opened.rows, fingerprint);
      if (levels) {
        send(
          { kind: 'levels', min: levels.map((level) => level.min), max: levels.map((level) => level.max) },
          levels.flatMap((level) => [level.min.buffer, level.max.buffer]),
        );
        send({ kind: 'complete', milliseconds: performance.now() - start, fromCache: true });
        return;
      }
    }
    const pyramid = new ColumnPyramid(opened.rows, type);
    for (const piece of pieceOrder(pyramid.pieceCount)) {
      if (closed) {
        return;
      }
      const first = piece * pyramidPieceSize;
      const values = await readRange(opened, column, first, Math.min(pyramidPieceSize, opened.rows - first));
      const count = Math.ceil(values.length / pyramidBlockSize);
      const min = new Float64Array(count);
      const max = new Float64Array(count);
      blockExtremes(values, type, min, max);
      pyramid.addPiece(piece, min, max);
      // Copies travel; the pyramid here keeps its own for the file.
      send({ kind: 'piece', piece, min: min.slice(), max: max.slice() });
    }
    send({ kind: 'complete', milliseconds: performance.now() - start, fromCache: false });
    if (cache) {
      await saveCached(name, writePyramidFile(pyramid, fingerprint));
    }
  };

  // The index of changes of a bit column, piece by piece over the whole column: per block of 4096 points whether a
  // point differs from the one before it, and the level of its first point.
  const buildChanges = async (): Promise<void> => {
    const opened = file as ColumnFile;
    const start = performance.now();
    const pieces = Math.ceil(opened.rows / pyramidPieceSize);
    for (const piece of pieceOrder(pieces)) {
      if (closed) {
        return;
      }
      const first = piece * pyramidPieceSize;
      const points = Math.min(pyramidPieceSize, opened.rows - first);
      // One word more in front: the point before the piece.
      const lead = first > 0 ? 1 : 0;
      const words = await opened.readWords32(first / 32 - lead, Math.ceil(points / 32) + lead);
      const blocks = Math.ceil(points / changeBlockSize);
      const changes = new Uint8Array(blocks);
      const starts = new Uint8Array(blocks);
      for (let block = 0; block < blocks; block++) {
        const begin = block * (changeBlockSize / 32);
        const end = Math.min(begin + changeBlockSize / 32, Math.ceil(points / 32));
        starts[block] = ((words[begin + lead] as number) & 1) === 1 ? 1 : 0;
        let previous = begin + lead > 0 ? ((words[begin + lead - 1] as number) >>> 31) & 1 : (words[0] as number) & 1;
        let any = 0;
        for (let w = begin; w < end && any === 0; w++) {
          const word = words[w + lead] as number;
          let changed = (word ^ ((word << 1) | previous)) >>> 0;
          const valid = points - w * 32;
          if (valid < 32) {
            changed &= (1 << valid) - 1;
          }
          any = changed === 0 ? 0 : 1;
          previous = word >>> 31;
        }
        changes[block] = any;
      }
      send({ kind: 'bitPiece', piece, changes, starts }, [changes.buffer, starts.buffer]);
    }
    send({ kind: 'complete', milliseconds: performance.now() - start, fromCache: false });
  };

  endpoint.addEventListener('message', (event) => {
    const request = event.data as ColumnRequest;
    void (async () => {
      try {
        if (request.kind === 'open') {
          file = await ColumnFile.open(await sourceOf(request.location));
          column = request.column;
          file.column(column);
          send({
            kind: 'opened',
            type: file.type,
            columns: file.columns,
            rows: file.rows,
            xStart: file.xStart,
            xStep: file.xStep,
          });
          await (file.type === 'bit' ? buildChanges() : build(request.cache));
        } else if (request.kind === 'blocks' && file) {
          const values = await readBlocks(file, column, request.blocks);
          send({ kind: 'blockValues', request: request.request, blocks: [...request.blocks], values }, [values.buffer]);
        } else if (request.kind === 'bits' && file) {
          const words = await file.readWords32((request.page * bitPageRows) / 32, bitPageRows / 32);
          const copy = words.slice();
          send({ kind: 'bitValues', request: request.request, page: request.page, words: copy }, [copy.buffer]);
        } else if (request.kind === 'rows' && file) {
          const count = Math.max(0, Math.min(request.count, file.rows - request.start));
          const values = await readRange(file, column, request.start, count);
          send({ kind: 'rowValues', request: request.request, start: request.start, values }, [values.buffer]);
        } else if (request.kind === 'close') {
          closed = true;
          file?.close();
        }
      } catch (error) {
        send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}
