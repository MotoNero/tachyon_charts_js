// Builds the pages of a cloud far larger than memory in a worker, from three columns of a column file, into the origin
// private file system, and takes them again next time when they belong to the same columns, as CloudPages.Build of the
// .NET version.
import { blobSource, httpSource, opfsFile, opfsSource, type ByteSource, type SyncAccessHandle } from './byte-source';
import {
  buildCloudPages,
  cloudPageBytes,
  cloudPagesFingerprint,
  cloudPagesHeaderSize,
  readCloudPagesHeader,
} from './cloud-pages-file';
import { ColumnFile } from './column-file';
import type { ColumnEndpoint, ColumnLocation } from './column-worker';

/** The message to the cloud pages worker. */
export interface CloudPagesRequest {
  /** Where the column file lies. */
  readonly location: ColumnLocation;
  /** The columns of x, y and z. */
  readonly columns: readonly [number, number, number];
}

/** The messages of the cloud pages worker. */
export type CloudPagesReply =
  | { readonly kind: 'progress'; readonly share: number }
  | { readonly kind: 'ready'; readonly name: string; readonly fromCache: boolean }
  | { readonly kind: 'error'; readonly message: string };

/** The folder of the origin private file system that holds pages and tiles. */
export const pagesFolder = 'tachyon-points';

async function sourceOf(location: ColumnLocation): Promise<ByteSource> {
  if ('opfs' in location) {
    return opfsSource(location.opfs);
  }
  if ('file' in location) {
    return blobSource(location.file);
  }
  return httpSource(location.url, location.headers ? { headers: location.headers } : {});
}

/** Builds the pages of one request on an endpoint: call it in the module of the worker. */
export function serveCloudPages(endpoint: ColumnEndpoint): void {
  const send = (reply: CloudPagesReply): void => {
    endpoint.postMessage(reply, []);
  };
  endpoint.addEventListener('message', (event) => {
    const request = event.data as CloudPagesRequest;
    void (async () => {
      let handle: SyncAccessHandle | undefined;
      try {
        const file = await ColumnFile.open(await sourceOf(request.location));
        for (const column of request.columns) {
          file.column(column);
        }
        const fingerprint = await cloudPagesFingerprint(file, request.columns);
        const name = `${fingerprint.toString(16).padStart(16, '0')}.tcld`;
        const target = (await opfsFile(`${pagesFolder}/${name}`, true)) as unknown as {
          createSyncAccessHandle(): Promise<SyncAccessHandle>;
        };
        handle = await target.createSyncAccessHandle();
        const opened = handle;
        // The pages of the same columns from a visit before, when they are whole.
        if (opened.getSize() >= cloudPagesHeaderSize) {
          const head = new Uint8Array(cloudPagesHeaderSize);
          opened.read(head, { at: 0 });
          const header = readCloudPagesHeader(head);
          if (
            header?.fingerprint === fingerprint &&
            header.sourceCount === file.rows &&
            opened.getSize() >= cloudPagesHeaderSize + header.pageCount * cloudPageBytes + header.count * 12
          ) {
            opened.close();
            send({ kind: 'ready', name, fromCache: true });
            return;
          }
        }
        // The header goes last, so that pages cut short are built again.
        opened.truncate(0);
        let reported = 0;
        await buildCloudPages(
          file,
          request.columns,
          {
            write: (offset, bytes) => {
              opened.write(bytes, { at: offset });
            },
            read: (offset, length) => {
              const bytes = new Uint8Array(length);
              opened.read(bytes, { at: offset });
              return bytes;
            },
          },
          {
            onProgress: (share) => {
              if (share - reported >= 0.01 || share === 1) {
                reported = share;
                send({ kind: 'progress', share });
              }
            },
          },
        );
        opened.flush();
        opened.close();
        send({ kind: 'ready', name, fromCache: false });
      } catch (error) {
        handle?.close();
        send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}

/** The pages of a cloud on their way: the file once built, and how far the building has come. */
export interface CloudPagesBuild {
  /** The file of the pages. */
  readonly file: Promise<Blob>;
  /** How far the building has come, from 0 to 1. */
  share(): number;
}

/**
 * Builds the pages of three columns in a worker, or takes them from a visit before; the 3D package opens the file as
 * the pages of a cloud.
 */
export function buildCloudPagesInWorker(
  location: ColumnLocation,
  columns: readonly [number, number, number],
  worker: Worker = new Worker(new URL('./cloud-pages-worker-entry.js', import.meta.url), { type: 'module' }),
): CloudPagesBuild {
  let share = 0;
  const file = new Promise<Blob>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<CloudPagesReply>) => {
      const reply = event.data;
      if (reply.kind === 'progress') {
        share = reply.share;
      } else if (reply.kind === 'ready') {
        worker.terminate();
        void opfsFile(`${pagesFolder}/${reply.name}`, false)
          .then((handle) => (handle as unknown as { getFile(): Promise<File> }).getFile())
          .then(resolve, reject);
      } else {
        worker.terminate();
        reject(new Error(reply.message));
      }
    };
    const request: CloudPagesRequest = { location, columns };
    worker.postMessage(request);
  });
  return { file, share: () => share };
}
