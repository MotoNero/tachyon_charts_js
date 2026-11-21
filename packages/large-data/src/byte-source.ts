// Where the bytes of a column file come from: a File or Blob (drag and drop), a file in the origin private file system
// (OPFS), or a server that answers HTTP range requests. A column file reads only the parts it needs.

/** Bytes that can be read in pieces. */
export interface ByteSource {
  /** The size in bytes. */
  readonly size: number;
  /**
   * Reads `length` bytes from `offset`; fewer at the end.
   * @returns The bytes, in a buffer of their own that the caller may keep.
   */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Reads synchronously, where the source can (an OPFS file in a worker). */
  readSync?(offset: number, length: number): Uint8Array;
  /** Releases the source, such as the lock of an OPFS file. */
  close?(): void;
}

/** A `File` or `Blob`, such as one dropped onto the page; it reads the slices it needs. */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset, length) {
      const end = Math.min(offset + length, blob.size);
      return new Uint8Array(await blob.slice(offset, Math.max(end, offset)).arrayBuffer());
    },
  };
}

/** What an OPFS file opened for synchronous access offers; workers only. */
export interface SyncAccessHandle {
  /** Reads into the buffer from the position `at`; returns the bytes read. */
  read(buffer: Uint8Array, options: { at: number }): number;
  /** Writes the buffer at the position `at`; returns the bytes written. */
  write(buffer: Uint8Array, options: { at: number }): number;
  /** The size of the file. */
  getSize(): number;
  /** Cuts or grows the file. */
  truncate(size: number): void;
  /** Writes what is buffered to the disk. */
  flush(): void;
  /** Releases the lock of the file. */
  close(): void;
}

/** An OPFS file opened for synchronous access in a worker: the fastest way to read, without a copy per read. */
export function syncHandleSource(handle: SyncAccessHandle): ByteSource {
  const readSync = (offset: number, length: number): Uint8Array => {
    const bytes = new Uint8Array(Math.max(0, Math.min(length, handle.getSize() - offset)));
    const read = handle.read(bytes, { at: offset });
    return read === bytes.length ? bytes : bytes.subarray(0, read);
  };
  return {
    get size() {
      return handle.getSize();
    },
    read: (offset, length) => Promise.resolve(readSync(offset, length)),
    readSync,
    close: () => {
      handle.close();
    },
  };
}

// Bytes of the first request: the header of a column file.
const probeLength = 64;

/** Options of {@link httpSource}. */
export interface HttpSourceOptions {
  /** Headers for every request, such as authorization. */
  readonly headers?: Record<string, string>;
  /** The fetch to use; the global one by default. */
  readonly fetch?: typeof fetch;
}

/**
 * A file on a server, read with HTTP range requests: only the parts the chart shows travel.
 * @throws Error when the server does not answer range requests.
 */
export async function httpSource(url: string | URL, options: HttpSourceOptions = {}): Promise<ByteSource> {
  const get = options.fetch ?? fetch;
  const range = async (offset: number, length: number): Promise<Response> => {
    const response = await get(url, {
      headers: { ...options.headers, Range: `bytes=${String(offset)}-${String(offset + length - 1)}` },
    });
    if (response.status !== 206) {
      throw new Error(`The server does not answer range requests (status ${String(response.status)}).`);
    }
    return response;
  };
  // The size comes with the first range: "bytes 0-63/12345". It asks for the 64 bytes of a column header, which the
  // file reads first anyway; some servers send the whole file for "bytes=0-0", taking the end 0 for none.
  const first = await range(0, probeLength);
  const total = /\/(\d+)$/.exec(first.headers.get('Content-Range') ?? '')?.[1];
  const head = new Uint8Array(await first.arrayBuffer());
  if (total === undefined) {
    throw new Error('The server does not tell the size of the file.');
  }
  const size = Number(total);
  return {
    size,
    async read(offset, length) {
      const end = Math.min(offset + length, size);
      if (end <= offset) {
        return new Uint8Array(0);
      }
      if (end <= head.length) {
        return head.slice(offset, end);
      }
      return new Uint8Array(await (await range(offset, end - offset)).arrayBuffer());
    },
  };
}

/** The handle of a file in the origin private file system, by its path such as `recordings/run.tcol`. */
export async function opfsFile(path: string, create = false): Promise<FileSystemFileHandle> {
  const parts = path.split('/').filter((part) => part !== '');
  const name = parts.pop();
  if (name === undefined) {
    throw new Error('The path names no file.');
  }
  let folder = await navigator.storage.getDirectory();
  for (const part of parts) {
    folder = await folder.getDirectoryHandle(part, { create });
  }
  return folder.getFileHandle(name, { create });
}

/**
 * An OPFS file to read: synchronous access in a worker, where it is fastest, else through its `File` on the main
 * thread.
 */
export async function opfsSource(path: string): Promise<ByteSource> {
  const handle = await opfsFile(path);
  const sync = handle as unknown as { createSyncAccessHandle?: () => Promise<SyncAccessHandle> };
  if (typeof sync.createSyncAccessHandle === 'function' && typeof document === 'undefined') {
    return syncHandleSource(await sync.createSyncAccessHandle());
  }
  return blobSource(await handle.getFile());
}
