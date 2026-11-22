// The Canvas 2D device, the last fallback as the Skia backend of the .NET version: buffers and textures live in the
// memory of the CPU, frames draw on canvases. It works wherever a canvas has a 2D context, in a worker too.
import {
  DeviceLostError,
  type BufferDesc,
  type CommandList,
  type DeviceCapabilities,
  type GpuBuffer,
  type GpuTexture,
  type OffscreenRenderTarget,
  type PixelSize,
  type RenderDevice,
  type RenderTarget,
  type SurfaceHandle,
  type SurfaceRenderTarget,
  type TextureDesc,
} from '@tachyon-charts/core';
import { CanvasFrame } from './frame';
import { CanvasBuffer, CanvasTexture } from './resources';
import { CanvasOffscreenTarget, CanvasSurfaceTarget, CanvasTarget } from './targets';

/**
 * Creates a Canvas 2D device.
 * @returns The device, or `undefined` where there is neither an OffscreenCanvas nor a document to make canvases in.
 */
export function createCanvas2dDevice(): Canvas2dDevice | undefined {
  if (typeof OffscreenCanvas !== 'function' && typeof document === 'undefined') {
    return undefined;
  }
  return new Canvas2dDevice();
}

/** A {@link @tachyon-charts/core#RenderDevice} on Canvas 2D. Create it with {@link createCanvas2dDevice}. */
export class Canvas2dDevice implements RenderDevice {
  /** What the device supports. */
  readonly capabilities: DeviceCapabilities = {
    backendName: 'Canvas 2D',
    supportsCompute: false,
    maxBufferSize: 2 ** 31 - 4,
    maxTextureDimension: 16_384,
    maxSampleCount: 1,
  };
  private disposed = false;
  private lost: string | undefined;
  private readonly lostListeners = new Set<(reason: string) => void>();
  private readonly frame = new CanvasFrame(this);

  /** Draw calls issued so far. */
  drawCallCount = 0;

  /** Bytes written to buffers and textures so far. */
  uploadedByteCount = 0;

  /** Whether the device was lost; only `simulateLoss` loses it. */
  get isLost(): boolean {
    return this.lost !== undefined;
  }

  /** Why the device was lost, `undefined` while it works. */
  get lostReason(): string | undefined {
    return this.lost;
  }

  /** No errors are kept: Canvas 2D throws where it fails. */
  get errors(): readonly string[] {
    return [];
  }

  /** Calls the listener once when the device is lost, at once if it is lost already; returns a function that removes it. */
  onLost(listener: (reason: string) => void): () => void {
    if (this.lost !== undefined) {
      listener(this.lost);
      return () => undefined;
    }
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  /** Loses the device on purpose, to test what an application does then. */
  simulateLoss(): void {
    this.ensureNotDisposed();
    if (this.lost !== undefined) {
      return;
    }
    this.lost = 'The device loss was simulated.';
    const listeners = [...this.lostListeners];
    this.lostListeners.clear();
    for (const listener of listeners) {
      listener(this.lost);
    }
  }

  /** Creates a buffer in the memory of the CPU. */
  createBuffer(desc: BufferDesc): GpuBuffer {
    this.ensureUsable();
    return new CanvasBuffer(this, desc.sizeInBytes, desc.usage);
  }

  /** Creates a texture in the memory of the CPU. */
  createTexture(desc: TextureDesc): GpuTexture {
    this.ensureUsable();
    return new CanvasTexture(this, desc.size, desc.format);
  }

  /** Creates a target that is not on screen; its content can be read back. */
  createOffscreenTarget(size: PixelSize, dpiScale: number): OffscreenRenderTarget {
    this.ensureUsable();
    return new CanvasOffscreenTarget(this, size, dpiScale);
  }

  /** Creates a target that shows its frames on a canvas. */
  createSurfaceTarget(surface: SurfaceHandle, size: PixelSize, dpiScale: number): SurfaceRenderTarget {
    this.ensureUsable();
    return new CanvasSurfaceTarget(this, surface, size, dpiScale);
  }

  /** Starts a frame for a target of this device. */
  beginFrame(target: RenderTarget): CommandList {
    this.ensureUsable();
    if (!(target instanceof CanvasTarget) || target.device !== this) {
      throw new TypeError('The target belongs to another device.');
    }
    if (this.frame.isActive) {
      throw new Error('A frame is still being recorded; submit or dispose it first.');
    }
    target.ensureUsable();
    return this.frame.begin(target);
  }

  /** Resolves at once: Canvas 2D draws when told. */
  whenIdle(): Promise<void> {
    this.ensureNotDisposed();
    return Promise.resolve();
  }

  /** Frees the device. */
  dispose(): void {
    this.disposed = true;
    this.lostListeners.clear();
  }

  /** Throws when the device is disposed or lost; every member that creates or draws calls it first. */
  ensureUsable(): void {
    this.ensureNotDisposed();
    if (this.lost !== undefined) {
      throw new DeviceLostError(this.lost);
    }
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('The render device is disposed.');
    }
  }
}
