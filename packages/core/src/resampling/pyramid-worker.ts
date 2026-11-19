// The pyramid of a series built in a worker. The worker reads the Y values straight from a SharedArrayBuffer and
// answers with the extremes of the blocks, a sixteenth of the data; copying the values to the worker would cost as
// much as scanning them, so data outside shared memory is built on the main thread in slices instead.
import type { NumberArray } from '../data/source';
import { baseBlockSize } from './lod-pyramid';
import { accumulate, Extremes } from './min-max';

/** One side of a message channel: a worker, the scope inside a worker, or a port of a `MessageChannel`. */
export interface MessageEndpoint {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  /** Present on a `MessagePort`, which delivers only after it; called once a listener is set. */
  start?(): void;
}

/** A request for the extremes of the blocks `[firstBlock, lastBlock)` of the values in shared memory. */
export interface PyramidRequest {
  readonly kind: 'tachyon-pyramid';
  readonly id: number;
  readonly buffer: SharedArrayBuffer;
  readonly type: ArrayType;
  readonly byteOffset: number;
  readonly firstBlock: number;
  readonly lastBlock: number;
}

/** The answer to a {@link PyramidRequest}. */
export interface PyramidReply {
  readonly kind: 'tachyon-pyramid';
  readonly id: number;
  readonly firstBlock: number;
  readonly min: Float64Array;
  readonly max: Float64Array;
}

type ArrayType =
  | 'Float64Array'
  | 'Float32Array'
  | 'Int32Array'
  | 'Uint32Array'
  | 'Int16Array'
  | 'Uint16Array'
  | 'Int8Array'
  | 'Uint8Array';

const constructors = {
  Float64Array,
  Float32Array,
  Int32Array,
  Uint32Array,
  Int16Array,
  Uint16Array,
  Int8Array,
  Uint8Array,
} satisfies Record<ArrayType, unknown>;

type SharedView = new (buffer: ArrayBufferLike, byteOffset: number, length: number) => NumberArray;

/** The name of the array type, if its values lie in shared memory and a worker can read them. */
export function sharedTypeOf(values: NumberArray): ArrayType | undefined {
  if (typeof SharedArrayBuffer === 'undefined' || !(values.buffer instanceof SharedArrayBuffer)) {
    return undefined;
  }
  const name = values.constructor.name;
  return name in constructors ? (name as ArrayType) : undefined;
}

function isRequest(data: unknown): data is PyramidRequest {
  return typeof data === 'object' && data !== null && (data as { kind?: unknown }).kind === 'tachyon-pyramid';
}

/** Answers pyramid requests on an endpoint; the module `pyramid-worker-entry` calls it in a worker. */
export function servePyramidRequests(endpoint: MessageEndpoint): void {
  const extremes = new Extremes();
  endpoint.addEventListener('message', (event) => {
    if (!isRequest(event.data)) {
      return;
    }
    const request = event.data;
    const blocks = request.lastBlock - request.firstBlock;
    const values = new (constructors[request.type] as SharedView)(
      request.buffer,
      request.byteOffset,
      request.lastBlock * baseBlockSize,
    );
    const min = new Float64Array(blocks);
    const max = new Float64Array(blocks);
    for (let i = 0; i < blocks; i++) {
      const start = (request.firstBlock + i) * baseBlockSize;
      accumulate(values, start, start + baseBlockSize, extremes.clear());
      min[i] = extremes.min;
      max[i] = extremes.max;
    }
    const reply: PyramidReply = { kind: 'tachyon-pyramid', id: request.id, firstBlock: request.firstBlock, min, max };
    endpoint.postMessage(reply, [min.buffer, max.buffer]);
  });
  endpoint.start?.();
}
