// The pyramid of a series built in a worker. The worker reads the Y values straight from a SharedArrayBuffer and
// answers with the extremes of the blocks, a sixteenth of the data; copying the values to the worker would cost as
// much as scanning them, so data outside shared memory is built on the main thread in slices instead.
import type { NumberArray } from '../data/source';
import { baseBlockSize } from './lod-pyramid';
import { accumulate, Extremes } from './min-max';

/** One side of a message channel: a worker, the scope inside a worker, or a port of a `MessageChannel`. */
export interface MessageEndpoint {
  /** Sends a message, handing over the buffers in `transfer`. */
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  /** Listens for messages. */
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  /** Present on a `MessagePort`, which delivers only after it; called once a listener is set. */
  start?(): void;
}

/** A request for the extremes of the blocks `[firstBlock, lastBlock)` of the values in shared memory. */
export interface PyramidRequest {
  /** Marks the messages of the pyramid among others on the same channel. */
  readonly kind: 'tachyon-pyramid';
  /** Pairs an answer with its request. */
  readonly id: number;
  /** The memory of the values. */
  readonly buffer: SharedArrayBuffer;
  /** The type of array the values have. */
  readonly type: SharedArrayType;
  /** Where the values start in the memory. */
  readonly byteOffset: number;
  /** The first block of 16 values. */
  readonly firstBlock: number;
  /** The block after the last one. */
  readonly lastBlock: number;
}

/** The answer to a {@link PyramidRequest}. */
export interface PyramidReply {
  /** Marks the messages of the pyramid among others on the same channel. */
  readonly kind: 'tachyon-pyramid';
  /** Pairs an answer with its request. */
  readonly id: number;
  /** The first block of 16 values. */
  readonly firstBlock: number;
  /** The smallest finite value of each block. */
  readonly min: Float64Array;
  /** The largest finite value of each block. */
  readonly max: Float64Array;
}

/** The typed arrays a worker reads from shared memory. */
export type SharedArrayType =
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
} satisfies Record<SharedArrayType, unknown>;

type SharedView = new (buffer: ArrayBufferLike, byteOffset: number, length: number) => NumberArray;

/** The name of the array type, if its values lie in shared memory and a worker can read them. */
export function sharedTypeOf(values: NumberArray): SharedArrayType | undefined {
  if (typeof SharedArrayBuffer === 'undefined' || !(values.buffer instanceof SharedArrayBuffer)) {
    return undefined;
  }
  const name = values.constructor.name;
  return name in constructors ? (name as SharedArrayType) : undefined;
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
