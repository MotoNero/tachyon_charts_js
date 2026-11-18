// Render targets on WebGPU: a texture that can be read back, and a canvas.
import type { OffscreenRenderTarget, PixelSize, SurfaceHandle, SurfaceRenderTarget } from '@tachyon-charts/core';
import type { DeviceContext } from './context';

/** What a frame needs from a target. */
export abstract class WebGpuTarget {
  private disposed = false;

  protected constructor(
    readonly device: DeviceContext,
    protected currentSize: PixelSize,
    protected currentDpiScale: number,
    /** The texture format frames are drawn in; pipelines are made for it. */
    readonly format: GPUTextureFormat,
  ) {
    checkSize(currentSize, device.capabilities.maxTextureDimension, true);
  }

  get size(): PixelSize {
    return this.currentSize;
  }

  get dpiScale(): number {
    return this.currentDpiScale;
  }

  /** The view a frame draws into; called once per frame. */
  abstract frameView(): GPUTextureView;

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.release();
    }
  }

  protected abstract release(): void;

  ensureUsable(): void {
    if (this.disposed) {
      throw new Error('The render target is disposed.');
    }
    this.device.ensureUsable();
  }
}

function checkSize(size: PixelSize, limit: number, allowEmpty: boolean): void {
  const lowest = allowEmpty ? 0 : 1;
  const fine = (value: number): boolean => Number.isInteger(value) && value >= lowest && value <= limit;
  if (!fine(size.width) || !fine(size.height)) {
    throw new RangeError(
      `A target needs a size from ${String(lowest)} to ${String(limit)} on each side, not ${String(size.width)} × ${String(size.height)}.`,
    );
  }
}

/** A texture as target; its content can be read back. */
export class WebGpuOffscreenTarget extends WebGpuTarget implements OffscreenRenderTarget {
  private readonly texture: GPUTexture;
  private readonly view: GPUTextureView;

  constructor(device: DeviceContext, size: PixelSize, dpiScale: number) {
    super(device, size, dpiScale, 'rgba8unorm');
    checkSize(size, device.capabilities.maxTextureDimension, false);
    this.texture = device.gpu.createTexture({
      size: { width: size.width, height: size.height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.view = this.texture.createView();
  }

  frameView(): GPUTextureView {
    return this.view;
  }

  async readPixels(): Promise<Uint8Array> {
    this.ensureUsable();
    const { width, height } = this.size;
    const row = width * 4;
    // Copies into buffers go in rows of a multiple of 256 bytes; the padding is cut off afterwards.
    const padded = Math.ceil(row / 256) * 256;
    const gpu = this.device.gpu;
    const staging = gpu.createBuffer({
      size: padded * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: this.texture },
        { buffer: staging, bytesPerRow: padded },
        { width, height },
      );
      gpu.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const source = new Uint8Array(staging.getMappedRange());
      const pixels = new Uint8Array(row * height);
      for (let y = 0; y < height; y++) {
        pixels.set(source.subarray(y * padded, y * padded + row), y * row);
      }
      staging.unmap();
      return pixels;
    } finally {
      staging.destroy();
    }
  }

  protected release(): void {
    this.texture.destroy();
  }
}

/** A canvas as target; submitting a frame shows it. */
export class WebGpuSurfaceTarget extends WebGpuTarget implements SurfaceRenderTarget {
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly context: GPUCanvasContext;

  constructor(
    device: DeviceContext,
    surface: SurfaceHandle,
    size: PixelSize,
    dpiScale: number,
    format: GPUTextureFormat,
  ) {
    super(device, size, dpiScale, format);
    const canvas = surface.canvas as HTMLCanvasElement | OffscreenCanvas | null;
    const context = typeof canvas?.getContext === 'function' ? canvas.getContext('webgpu') : null;
    if (!canvas || !context) {
      throw new TypeError('The surface is no canvas with a WebGPU context.');
    }
    this.canvas = canvas;
    this.context = context;
    // Opaque like the windows of the .NET version: the chart paints its own background.
    context.configure({ device: device.gpu, format, alphaMode: 'opaque' });
    this.applySize();
  }

  resize(size: PixelSize, dpiScale: number): void {
    this.ensureUsable();
    checkSize(size, this.device.capabilities.maxTextureDimension, true);
    this.currentSize = size;
    this.currentDpiScale = dpiScale;
    this.applySize();
  }

  frameView(): GPUTextureView {
    return this.context.getCurrentTexture().createView();
  }

  protected release(): void {
    this.context.unconfigure();
  }

  private applySize(): void {
    // Changing the size clears a canvas, so it is only set when it differs.
    if (this.canvas.width !== this.size.width) {
      this.canvas.width = this.size.width;
    }
    if (this.canvas.height !== this.size.height) {
      this.canvas.height = this.size.height;
    }
  }
}
