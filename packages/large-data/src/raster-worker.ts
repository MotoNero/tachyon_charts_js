// The raster worker: it opens a raster file, builds its stages or takes them from the origin private file system,
// and reads the regions of a stage that a chart shows.
import type { RasterReduction } from '@tachyon-charts/core';
import { blobSource, httpSource, opfsFile, opfsSource, type ByteSource, type SyncAccessHandle } from './byte-source';
import type { ColumnEndpoint, ColumnLocation } from './column-worker';
import {
  buildStages,
  RasterFile,
  rasterFingerprint,
  readStagesHeader,
  stageOffset,
  stageSizes,
  stagesHeaderSize,
  writeStagesHeader,
  type StagesStore,
} from './raster-file';

/** A region of cells of one level: level 0 is the raster itself, level 1 its finest stage. */
export interface RasterRegion {
  /** The level. */
  readonly level: number;
  /** The first column. */
  readonly column: number;
  /** The first row. */
  readonly row: number;
  /** The columns. */
  readonly columns: number;
  /** The rows. */
  readonly rows: number;
}

/** The messages to the raster worker. */
export type RasterRequest =
  | {
      readonly kind: 'open';
      readonly location: ColumnLocation;
      readonly reduction: RasterReduction;
      readonly cache: boolean;
    }
  | { readonly kind: 'region'; readonly request: number; readonly region: RasterRegion }
  | { readonly kind: 'close' };

/** The messages of the raster worker. */
export type RasterReply =
  | {
      readonly kind: 'opened';
      readonly width: number;
      readonly height: number;
      readonly xStart: number;
      readonly xStep: number;
      readonly yStart: number;
      readonly yStep: number;
      readonly stages: { width: number; height: number }[];
    }
  | { readonly kind: 'progress'; readonly share: number }
  | {
      readonly kind: 'ready';
      readonly low: number;
      readonly high: number;
      readonly milliseconds: number;
      readonly fromCache: boolean;
    }
  | { readonly kind: 'region'; readonly request: number; readonly region: RasterRegion; readonly values: Float32Array }
  | { readonly kind: 'error'; readonly message: string };

async function sourceOf(location: ColumnLocation): Promise<ByteSource> {
  if ('opfs' in location) {
    return opfsSource(location.opfs);
  }
  if ('file' in location) {
    return blobSource(location.file);
  }
  return httpSource(location.url, location.headers ? { headers: location.headers } : {});
}

const cacheFolder = 'tachyon-rasters';

// A stages file in the origin private file system, read and written in place.
async function opfsStore(name: string): Promise<
  | {
      handle: SyncAccessHandle;
      write(offset: number, bytes: Uint8Array): void;
      read(offset: number, length: number): Uint8Array;
    }
  | undefined
> {
  try {
    const file = (await opfsFile(`${cacheFolder}/${name}`, true)) as unknown as {
      createSyncAccessHandle(): Promise<SyncAccessHandle>;
    };
    const handle = await file.createSyncAccessHandle();
    return {
      handle,
      write: (offset, bytes) => {
        handle.write(bytes, { at: offset });
      },
      read: (offset, length) => {
        const bytes = new Uint8Array(length);
        handle.read(bytes, { at: offset });
        return bytes;
      },
    };
  } catch {
    return undefined;
  }
}

function memoryStore(size: number): StagesStore {
  const bytes = new Uint8Array(size);
  return {
    write: (offset, part) => {
      bytes.set(part, offset);
    },
    read: (offset, length) => bytes.slice(offset, offset + length),
  };
}

/** Serves one raster file on an endpoint: call it in the module of the worker with its global scope. */
export function serveRaster(endpoint: ColumnEndpoint): void {
  let file: RasterFile | undefined;
  let store: StagesStore | undefined;
  let handle: SyncAccessHandle | undefined;
  let sizes: { width: number; height: number }[] = [];
  let closed = false;
  const send = (reply: RasterReply, transfer: Transferable[] = []): void => {
    endpoint.postMessage(reply, transfer);
  };

  const prepare = async (reduction: RasterReduction, cache: boolean): Promise<void> => {
    const opened = file as RasterFile;
    const start = performance.now();
    const fingerprint = await rasterFingerprint(opened);
    const size = stageOffset(sizes, sizes.length);
    const cached = cache
      ? await opfsStore(`${fingerprint.toString(16).padStart(16, '0')}-${reduction}.trap`)
      : undefined;
    if (cached) {
      handle = cached.handle;
      const header = readStagesHeader(cached.read(0, stagesHeaderSize));
      if (header?.fingerprint === fingerprint && header.reduction === reduction && cached.handle.getSize() === size) {
        store = cached;
        send({
          kind: 'ready',
          low: header.low,
          high: header.high,
          milliseconds: performance.now() - start,
          fromCache: true,
        });
        return;
      }
      // The header goes last, so that a stages file cut short is built again.
      cached.handle.truncate(0);
    }
    const target = cached ?? memoryStore(size);
    let reported = 0;
    const { low, high } = await buildStages(
      opened,
      reduction,
      target,
      (share) => {
        if (share - reported >= 0.02) {
          reported = share;
          send({ kind: 'progress', share });
        }
      },
      () => closed,
    );
    if (closed) {
      return;
    }
    await target.write(0, writeStagesHeader({ reduction, fingerprint, low, high }));
    cached?.handle.flush();
    store = target;
    send({ kind: 'ready', low, high, milliseconds: performance.now() - start, fromCache: false });
  };

  const read = async (region: RasterRegion): Promise<Float32Array> => {
    const opened = file as RasterFile;
    const values = new Float32Array(region.columns * region.rows);
    const width = region.level === 0 ? opened.width : (sizes[region.level - 1]?.width ?? 0);
    const base = region.level === 0 ? 0 : stageOffset(sizes, region.level - 1);
    // Whole rows when the region is most of their width, else the part of each row.
    const whole = region.columns * 2 >= width;
    for (let r = 0; r < region.rows; r++) {
      const row = region.row + r;
      let cells: Float32Array;
      if (region.level === 0) {
        cells = await opened.readCells(row, region.column, region.columns);
      } else {
        const offset = base + (row * width + (whole ? 0 : region.column)) * 4;
        const bytes = await (store as StagesStore).read(offset, (whole ? width : region.columns) * 4);
        const own = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
        const all = new Float32Array(own.buffer, own.byteOffset, own.byteLength / 4);
        cells = whole ? all.subarray(region.column, region.column + region.columns) : all;
      }
      values.set(cells.subarray(0, region.columns), r * region.columns);
    }
    return values;
  };

  endpoint.addEventListener('message', (event) => {
    const request = event.data as RasterRequest;
    void (async () => {
      try {
        if (request.kind === 'open') {
          file = await RasterFile.open(await sourceOf(request.location));
          sizes = stageSizes(file.width, file.height);
          send({
            kind: 'opened',
            width: file.width,
            height: file.height,
            xStart: file.xStart,
            xStep: file.xStep,
            yStart: file.yStart,
            yStep: file.yStep,
            stages: sizes,
          });
          await prepare(request.reduction, request.cache);
        } else if (request.kind === 'region' && file) {
          if (request.region.level > 0 && !store) {
            throw new Error('The stages of the raster are not ready yet.');
          }
          const values = await read(request.region);
          send({ kind: 'region', request: request.request, region: request.region, values }, [values.buffer]);
        } else if (request.kind === 'close') {
          closed = true;
          handle?.close();
          file?.close();
        }
      } catch (error) {
        send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}
