// Canvas 2D in a worker: the device draws there on OffscreenCanvases, so that the work of the CPU stays off the main
// thread; the main thread only records frames.
import { connectRenderWorker, type RemoteRenderDevice, type RenderEndpoint } from '@tachyon-charts/core';

/** Options of {@link createCanvas2dWorkerDevice}. */
export interface Canvas2dWorkerDeviceOptions {
  /** A worker running `@tachyon-charts/render-canvas/render-worker`; by default one is started from this package. */
  readonly worker?: Worker;
  /** How long to wait for the worker to report its device, in milliseconds; 10 s by default. */
  readonly timeoutMilliseconds?: number;
}

/**
 * Starts a render worker with a Canvas 2D device. Resolves with the device as the main thread sees it, or with
 * `undefined` when the browser cannot hand a canvas to a worker; draw on the main thread then. Surface targets of this
 * device take an `OffscreenCanvas` from `canvas.transferControlToOffscreen()`. Disposing the device ends the worker.
 */
export async function createCanvas2dWorkerDevice(
  options: Canvas2dWorkerDeviceOptions = {},
): Promise<RemoteRenderDevice | undefined> {
  if (
    typeof Worker !== 'function' ||
    typeof OffscreenCanvas !== 'function' ||
    typeof HTMLCanvasElement !== 'function' ||
    !('transferControlToOffscreen' in HTMLCanvasElement.prototype)
  ) {
    return undefined;
  }
  let worker: Worker;
  try {
    worker = options.worker ?? new Worker(new URL('./render-worker-entry.js', import.meta.url), { type: 'module' });
  } catch {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failed = new Promise<undefined>((resolve) => {
    worker.addEventListener('error', () => {
      resolve(undefined);
    });
    timer = setTimeout(() => {
      resolve(undefined);
    }, options.timeoutMilliseconds ?? 10_000);
  });
  const device = await Promise.race([
    connectRenderWorker(worker as unknown as RenderEndpoint, () => {
      worker.terminate();
    }),
    failed,
  ]);
  clearTimeout(timer);
  if (!device) {
    worker.terminate();
  }
  return device;
}
