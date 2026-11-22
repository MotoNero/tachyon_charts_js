// The point tiles worker: it opens a column file, builds the point tiles of two of its columns or takes them from the
// origin private file system, and counts the density of the views a chart shows.
import { blobSource, httpSource, opfsFile, opfsSource, type ByteSource, type SyncAccessHandle } from './byte-source';
import { ColumnFile } from './column-file';
import type { ColumnEndpoint, ColumnLocation } from './column-worker';
import {
  buildPointTiles,
  pointsStart,
  pointTilesFingerprint,
  PointTilesReader,
  type DensityView,
  type PointTilesHeader,
} from './point-tiles-file';

/** The messages to the point tiles worker. */
export type PointTilesRequest =
  | {
      readonly kind: 'open';
      readonly location: ColumnLocation;
      readonly xColumn: number;
      readonly yColumn: number;
      readonly cache: boolean;
    }
  | { readonly kind: 'count'; readonly request: number; readonly view: DensityView; readonly budget: number }
  | { readonly kind: 'close' };

/** The messages of the point tiles worker. */
export type PointTilesReply =
  | { readonly kind: 'opened'; readonly rows: number }
  | { readonly kind: 'progress'; readonly share: number }
  | {
      readonly kind: 'ready';
      readonly header: PointTilesHeader;
      readonly milliseconds: number;
      readonly fromCache: boolean;
    }
  | {
      readonly kind: 'counted';
      readonly request: number;
      readonly view: DensityView;
      readonly values: Float32Array;
      readonly maximum: number;
      readonly drawn: number;
    }
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

interface SyncStore {
  readonly handle?: SyncAccessHandle;
  readonly write: (offset: number, bytes: Uint8Array) => void;
  readonly read: (offset: number, length: number) => Uint8Array;
}

async function opfsStore(name: string): Promise<SyncStore | undefined> {
  try {
    const file = (await opfsFile(`tachyon-points/${name}`, true)) as unknown as {
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

// Without the origin private file system, the tiles stay in memory, grown as the points come.
function memoryStore(): SyncStore {
  let bytes = new Uint8Array(pointsStart);
  return {
    write: (offset, part) => {
      if (offset + part.length > bytes.length) {
        const grown = new Uint8Array(Math.max(offset + part.length, bytes.length * 2));
        grown.set(bytes);
        bytes = grown;
      }
      bytes.set(part, offset);
    },
    read: (offset, length) => bytes.subarray(offset, offset + length),
  };
}

// The counts for a raster: row 0 at the bottom, no count as NaN, so that the background shows.
function forRaster(bins: Float32Array, width: number, height: number): Float32Array {
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const from = (height - 1 - row) * width;
    for (let column = 0; column < width; column++) {
      const value = bins[from + column] as number;
      values[row * width + column] = value > 0 ? value : Number.NaN;
    }
  }
  return values;
}

/** Serves the point tiles of one column file on an endpoint: call it in the module of the worker. */
export function servePointTiles(endpoint: ColumnEndpoint): void {
  let reader: PointTilesReader | undefined;
  let handle: SyncAccessHandle | undefined;
  let file: ColumnFile | undefined;
  let closed = false;
  const send = (reply: PointTilesReply, transfer: Transferable[] = []): void => {
    endpoint.postMessage(reply, transfer);
  };

  const prepare = async (xColumn: number, yColumn: number, cache: boolean): Promise<void> => {
    const opened = file as ColumnFile;
    const start = performance.now();
    const fingerprint = await pointTilesFingerprint(opened, xColumn, yColumn);
    const cached = cache ? await opfsStore(`${fingerprint.toString(16).padStart(16, '0')}.tpts`) : undefined;
    handle = cached?.handle;
    if (cached?.handle && cached.handle.getSize() >= pointsStart) {
      reader = PointTilesReader.open(cached.read, opened.rows, fingerprint);
      if (reader && cached.handle.getSize() >= pointsStart + reader.header.count * 8) {
        send({ kind: 'ready', header: reader.header, milliseconds: performance.now() - start, fromCache: true });
        return;
      }
      reader = undefined;
    }
    // The header goes last, so that tiles cut short are built again.
    cached?.handle?.truncate(0);
    const store = cached ?? memoryStore();
    let reported = 0;
    const header = await buildPointTiles(opened, xColumn, yColumn, store, {
      onProgress: (share) => {
        if (share - reported >= 0.02 || share === 1) {
          reported = share;
          send({ kind: 'progress', share });
        }
      },
      isStopped: () => closed,
    });
    if (!header || closed) {
      return;
    }
    cached?.handle?.flush();
    reader = PointTilesReader.open(store.read, opened.rows, fingerprint);
    if (!reader) {
      throw new Error('The point tiles cannot be read back.');
    }
    send({ kind: 'ready', header, milliseconds: performance.now() - start, fromCache: false });
  };

  endpoint.addEventListener('message', (event) => {
    const request = event.data as PointTilesRequest;
    void (async () => {
      try {
        if (request.kind === 'open') {
          file = await ColumnFile.open(await sourceOf(request.location));
          file.column(request.xColumn);
          file.column(request.yColumn);
          send({ kind: 'opened', rows: file.rows });
          await prepare(request.xColumn, request.yColumn, request.cache);
        } else if (request.kind === 'count') {
          if (!reader) {
            throw new Error('The point tiles are not ready yet.');
          }
          const { width, height } = request.view;
          const density = reader.count(request.view, request.budget);
          const values = forRaster(density.bins, width, height);
          send(
            {
              kind: 'counted',
              request: request.request,
              view: request.view,
              values,
              maximum: density.maximum,
              drawn: density.drawn,
            },
            [values.buffer],
          );
        } else {
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
