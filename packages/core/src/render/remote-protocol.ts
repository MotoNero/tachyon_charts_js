// The messages between a remote render device on the main thread and the render server in a worker. Commands and
// resource changes go as one batch per flush: numbers in a Float64Array, small payloads in one byte arena, large
// payloads, styles and canvases beside them. Both arrays are transferred, not copied.
import type { DeviceCapabilities } from './types';

/** Where messages go and come from: a worker, the global scope of a worker or a `MessagePort`. */
export interface RenderEndpoint {
  /** Sends a message, handing over the objects in `transfer` (buffers, canvases). */
  postMessage(message: unknown, transfer: readonly object[]): void;
  /** Listens for messages. */
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  /** Present on a `MessagePort`, which delivers only after it; called once a listener is set. */
  start?(): void;
}

/** The operations of a batch; each is followed by its numbers in the stream. */
export const Op = {
  createBuffer: 1, // id, size, usage
  writeBuffer: 2, // id, offset, payload (3)
  disposeBuffer: 3, // id
  createTexture: 4, // id, width, height, format object
  writeTexture: 5, // id, payload (3)
  writeTextureRow: 6, // id, row, payload (3)
  disposeTexture: 7, // id
  createSurfaceTarget: 8, // id, width, height, dpi, canvas object
  createOffscreenTarget: 9, // id, width, height, dpi
  resizeTarget: 10, // id, width, height, dpi
  disposeTarget: 11, // id
  beginFrame: 12, // frame id, target id
  clear: 13, // frame, rgba (4)
  fillRectangle: 14, // frame, rect (4), rgba (4)
  fillLinearGradient: 15, // frame, rect (4), rgba (4), rgba (4), vertical
  fillTriangle: 16, // frame, 6 coordinates, rgba (4)
  fillMesh: 17, // frame, payload (3), count, clip flag, rect (4)
  drawTextPlaceholder: 18, // frame, rect (4), rgba (4)
  drawPolyline: 19, // frame, buffer, first, count, style object
  drawMarkers: 20, // frame, buffer, first, count, style object
  drawGlyphs: 21, // frame, texture, payload (3), count
  drawImage: 22, // frame, texture, rect (4)
  drawRaster: 23, // frame, values, colormap, rect (4), style object
  setQuarterTurn: 24, // frame, sum or NaN
  submit: 25, // frame
  disposeFrame: 26, // frame
  readPixels: 27, // target, request
  whenIdle: 28, // request
  simulateLoss: 29,
  dispose: 30,
} as const;

/** A batch from the main thread. A payload is (source, offset, length): source −1 is the arena, else an object. */
export interface BatchMessage {
  readonly type: 'batch';
  readonly ops: Float64Array;
  readonly arena: Uint8Array;
  readonly objects: readonly unknown[];
  readonly frames: number;
}

/** The first message to the worker: create the device. */
export interface InitMessage {
  readonly type: 'init';
}

/** The messages of the render server in a worker to its remote device. */
export type ServerMessage =
  | { readonly type: 'ready'; readonly capabilities: DeviceCapabilities }
  | { readonly type: 'unavailable'; readonly reason: string }
  | {
      readonly type: 'done';
      readonly frames: number;
      readonly drawCalls: number;
      readonly uploadedBytes: number;
      readonly milliseconds: number;
    }
  | { readonly type: 'pixels'; readonly request: number; readonly pixels: Uint8Array }
  | { readonly type: 'idle'; readonly request: number }
  | { readonly type: 'lost'; readonly reason: string }
  | { readonly type: 'error'; readonly message: string };
