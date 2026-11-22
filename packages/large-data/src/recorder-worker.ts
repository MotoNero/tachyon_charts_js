// The worker of a ColumnRecorder: it writes the values into column files of fixed size in the origin private file
// system, one after the other, each a complete column file once full; in a ring the oldest file goes when a new one
// starts. It reads blocks and rows of the files that are kept for the line over the recording.
import { opfsFile, type SyncAccessHandle } from './byte-source';
import { columnHeaderSize, columnValueSize, writeColumnHeader } from './column-file';
import { pyramidBlockSize } from './column-pyramid';
import type { ColumnReply } from './column-worker';

/** How a recording is written. */
export interface RecordingSettings {
  /** The folder in the origin private file system. */
  readonly folder: string;
  /** The name; the files are `<name>-000000.tcol`, `<name>-000001.tcol` and so on. */
  readonly name: string;
  /** The type of the values. */
  readonly type: 'float32' | 'float64';
  /** The values of a file. */
  readonly fileValues: number;
  /** The files kept; 0 keeps all. */
  readonly maxFiles: number;
  /** The X of the first value. */
  readonly xStart: number;
  /** The X distance between two values. */
  readonly xStep: number;
}

/** The messages to a recorder worker. */
export type RecorderRequest =
  | ({ readonly kind: 'start' } & RecordingSettings)
  | { readonly kind: 'append'; readonly values: Float32Array | Float64Array }
  | { readonly kind: 'blocks'; readonly request: number; readonly blocks: readonly number[] }
  | { readonly kind: 'rows'; readonly request: number; readonly start: number; readonly count: number }
  | { readonly kind: 'close' };

/** The messages of a recorder worker beside those of a column worker. */
export type RecorderReply = ColumnReply | { readonly kind: 'started' } | { readonly kind: 'closed' };

interface LiveFile {
  readonly index: number;
  readonly handle: SyncAccessHandle;
  count: number;
}

/** The name of a file of a recording. */
export function recordingFileName(name: string, index: number): string {
  return `${name}-${String(index).padStart(6, '0')}.tcol`;
}

/** Serves a recording on an endpoint: call it in the module of the worker with its global scope. */
export function serveRecording(endpoint: Worker): void {
  let settings: RecordingSettings | undefined;
  const live: LiveFile[] = [];
  let size = 4;
  const send = (reply: RecorderReply, transfer: Transferable[] = []): void => {
    endpoint.postMessage(reply, transfer);
  };

  const header = (file: LiveFile): Uint8Array => {
    const s = settings as RecordingSettings;
    return writeColumnHeader({
      type: s.type,
      columns: 1,
      rows: file.count,
      xStart: s.xStart + file.index * s.fileValues * s.xStep,
      xStep: s.xStep,
      blockRows: 0,
    });
  };

  const finish = (file: LiveFile): void => {
    file.handle.write(header(file), { at: 0 });
    file.handle.flush();
  };

  const open = async (index: number): Promise<LiveFile> => {
    const s = settings as RecordingSettings;
    const handle = (await opfsFile(`${s.folder}/${recordingFileName(s.name, index)}`, true)) as unknown as {
      createSyncAccessHandle(): Promise<SyncAccessHandle>;
    };
    const access = await handle.createSyncAccessHandle();
    access.truncate(0);
    const file = { index, handle: access, count: 0 };
    access.write(header(file), { at: 0 });
    return file;
  };

  const folder = async (): Promise<FileSystemDirectoryHandle> => {
    let directory = await navigator.storage.getDirectory();
    for (const part of (settings as RecordingSettings).folder.split('/').filter((name) => name !== '')) {
      directory = await directory.getDirectoryHandle(part, { create: true });
    }
    return directory;
  };

  const drop = async (file: LiveFile): Promise<void> => {
    file.handle.close();
    try {
      await (await folder()).removeEntry(recordingFileName((settings as RecordingSettings).name, file.index));
    } catch {
      // A file that cannot be removed stays; the next start of the recording replaces it.
    }
  };

  // The files of an earlier recording of the same name go.
  const clear = async (): Promise<void> => {
    const directory = await folder();
    const prefix = `${(settings as RecordingSettings).name}-`;
    const names: string[] = [];
    for await (const name of (directory as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.startsWith(prefix) && name.endsWith('.tcol')) {
        names.push(name);
      }
    }
    for (const name of names) {
      await directory.removeEntry(name);
    }
  };

  const append = async (values: Float32Array | Float64Array): Promise<void> => {
    const s = settings as RecordingSettings;
    let at = 0;
    while (at < values.length) {
      let file = live[live.length - 1];
      if (!file || file.count === s.fileValues) {
        if (file) {
          finish(file);
        }
        file = await open(file ? file.index + 1 : 0);
        live.push(file);
        while (s.maxFiles > 0 && live.length > s.maxFiles) {
          await drop(live.shift() as LiveFile);
        }
      }
      const take = Math.min(values.length - at, s.fileValues - file.count);
      const part = values.subarray(at, at + take);
      file.handle.write(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), {
        at: columnHeaderSize + file.count * size,
      });
      file.count += take;
      at += take;
    }
  };

  // Values of rows counted from the start of the recording; NaN where no file holds them any more.
  const read = (start: number, count: number): Float64Array => {
    const s = settings as RecordingSettings;
    const values = new Float64Array(count).fill(Number.NaN);
    for (let at = 0; at < count;) {
      const row = start + at;
      const index = Math.floor(row / s.fileValues);
      const within = row - index * s.fileValues;
      const take = Math.min(count - at, s.fileValues - within);
      const file = live.find((candidate) => candidate.index === index);
      if (file) {
        const available = Math.max(0, Math.min(take, file.count - within));
        const bytes = new Uint8Array(available * size);
        file.handle.read(bytes, { at: columnHeaderSize + within * size });
        values.set(s.type === 'float32' ? new Float32Array(bytes.buffer) : new Float64Array(bytes.buffer), at);
      }
      at += take;
    }
    return values;
  };

  // One request after the other, in the order they came, so that a read sees the values appended before it.
  let queue = Promise.resolve();
  endpoint.addEventListener('message', (event: MessageEvent<RecorderRequest>) => {
    const request = event.data;
    queue = queue.then(async () => {
      try {
        switch (request.kind) {
          case 'start':
            settings = request;
            size = columnValueSize(request.type);
            await clear();
            send({ kind: 'started' });
            break;
          case 'append':
            await append(request.values);
            break;
          case 'blocks': {
            const values = new Float64Array(request.blocks.length * pyramidBlockSize);
            request.blocks.forEach((block, i) => {
              values.set(read(block * pyramidBlockSize, pyramidBlockSize), i * pyramidBlockSize);
            });
            send({ kind: 'blockValues', request: request.request, blocks: [...request.blocks], values }, [
              values.buffer,
            ]);
            break;
          }
          case 'rows': {
            const values = read(request.start, request.count);
            send({ kind: 'rowValues', request: request.request, start: request.start, values }, [values.buffer]);
            break;
          }
          case 'close':
            for (const file of live) {
              finish(file);
              file.handle.close();
            }
            live.length = 0;
            send({ kind: 'closed' });
            break;
        }
      } catch (error) {
        send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    });
  });
}
