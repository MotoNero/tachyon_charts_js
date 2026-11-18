// The WebGPU device: adapter and device, capabilities, loss, and the life cycle of everything created from it.
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
import type { DeviceContext } from './context';
import { WebGpuFrame } from './frame';
import { WebGpuBuffer, WebGpuTexture } from './resources';
import { WebGpuOffscreenTarget, WebGpuSurfaceTarget, WebGpuTarget } from './targets';

/** Options for {@link createWebGpuDevice}. */
export interface WebGpuDeviceOptions {
  /** Which adapter to prefer; the fast one when left out. */
  readonly powerPreference?: GPUPowerPreference;
  /** The WebGPU entry point; `navigator.gpu` of the page or worker when left out. */
  readonly gpu?: GPU;
}

// Most validation errors repeat the same message every frame; a few are enough to see what went wrong.
const keptErrors = 20;

/**
 * Creates a WebGPU device with the largest buffers and textures the adapter allows.
 * @returns The device, or `undefined` when the browser has no WebGPU or no suitable adapter; callers then fall back.
 */
export async function createWebGpuDevice(options: WebGpuDeviceOptions = {}): Promise<WebGpuDevice | undefined> {
  const gpu = options.gpu ?? (globalThis.navigator as Navigator | undefined)?.gpu;
  if (!gpu) {
    return undefined;
  }
  const adapter = await gpu.requestAdapter({ powerPreference: options.powerPreference ?? 'high-performance' });
  if (!adapter) {
    return undefined;
  }
  const limits = adapter.limits;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: limits.maxBufferSize,
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
      maxTextureDimension2D: limits.maxTextureDimension2D,
    },
  });
  const info = adapter.info;
  const name = [info.vendor, info.architecture].filter((part) => part !== '').join(' ');
  return new WebGpuDevice(
    device,
    {
      backendName: name === '' ? 'WebGPU' : `WebGPU (${name})`,
      supportsCompute: true,
      maxBufferSize: device.limits.maxBufferSize,
      maxTextureDimension: device.limits.maxTextureDimension2D,
      maxSampleCount: 4,
    },
    gpu.getPreferredCanvasFormat(),
  );
}

/** A {@link RenderDevice} on WebGPU. Create it with {@link createWebGpuDevice}. */
export class WebGpuDevice implements RenderDevice, DeviceContext {
  private disposed = false;
  private lost: string | undefined;
  private readonly lostListeners = new Set<(reason: string) => void>();
  private readonly validationErrors: string[] = [];
  private readonly frame = new WebGpuFrame(this);

  /** Draw calls issued so far. */
  drawCallCount = 0;
  /** Bytes written to buffers and textures so far. */
  uploadedByteCount = 0;

  /**
   * @param gpu - The WebGPU device; the other parts of this package draw with it.
   * @param capabilities - What the device supports.
   * @param canvasFormat - The texture format canvases show best on this machine.
   */
  constructor(
    readonly gpu: GPUDevice,
    readonly capabilities: DeviceCapabilities,
    readonly canvasFormat: GPUTextureFormat = 'bgra8unorm',
  ) {
    void gpu.lost.then((info) => {
      // Disposing destroys the device on purpose; that is no loss.
      if (!this.disposed) {
        this.markLost(info.message === '' ? `The device was lost (${info.reason}).` : info.message);
      }
    });
    gpu.addEventListener('uncapturederror', (event) => {
      if (this.validationErrors.length < keptErrors) {
        this.validationErrors.push(event.error.message);
      }
    });
  }

  get isLost(): boolean {
    return this.lost !== undefined;
  }

  get lostReason(): string | undefined {
    return this.lost;
  }

  /** The first errors WebGPU reported without a caller to throw to, for diagnostics and tests. */
  get errors(): readonly string[] {
    return this.validationErrors;
  }

  onLost(listener: (reason: string) => void): () => void {
    if (this.lost !== undefined) {
      listener(this.lost);
      return () => undefined;
    }
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  simulateLoss(): void {
    this.ensureNotDisposed();
    this.markLost('The device loss was simulated.');
    this.gpu.destroy();
  }

  createBuffer(desc: BufferDesc): GpuBuffer {
    this.ensureUsable();
    return new WebGpuBuffer(this, desc.sizeInBytes, desc.usage);
  }

  createTexture(desc: TextureDesc): GpuTexture {
    this.ensureUsable();
    return new WebGpuTexture(this, desc.size, desc.format);
  }

  createOffscreenTarget(size: PixelSize, dpiScale: number): OffscreenRenderTarget {
    this.ensureUsable();
    return new WebGpuOffscreenTarget(this, size, dpiScale);
  }

  createSurfaceTarget(surface: SurfaceHandle, size: PixelSize, dpiScale: number): SurfaceRenderTarget {
    this.ensureUsable();
    return new WebGpuSurfaceTarget(this, surface, size, dpiScale, this.canvasFormat);
  }

  beginFrame(target: RenderTarget): CommandList {
    this.ensureUsable();
    if (!(target instanceof WebGpuTarget) || target.device !== this) {
      throw new TypeError('The target belongs to another device.');
    }
    if (this.frame.isActive) {
      throw new Error('A frame is still being recorded; submit or dispose it first.');
    }
    target.ensureUsable();
    return this.frame.begin(target);
  }

  async whenIdle(): Promise<void> {
    this.ensureNotDisposed();
    if (this.lost === undefined) {
      await this.gpu.queue.onSubmittedWorkDone();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lostListeners.clear();
    this.gpu.destroy();
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

  private markLost(reason: string): void {
    if (this.lost !== undefined) {
      return;
    }
    this.lost = reason;
    const listeners = [...this.lostListeners];
    this.lostListeners.clear();
    for (const listener of listeners) {
      listener(reason);
    }
  }
}
