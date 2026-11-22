// Render targets on WebGL 2: a texture that can be read back, and a canvas. All charts of a device share one context,
// so that buffers, textures and the glyph atlas serve all of them; a frame for a canvas is drawn on the canvas of the
// context and handed to the canvas of the chart as an ImageBitmap, without a copy.
import type { OffscreenRenderTarget, PixelSize, SurfaceHandle, SurfaceRenderTarget } from '@tachyon-charts/core';
import type { GlContext } from './context';

/** What a frame needs from a target. */
export abstract class WebGlTarget {
  private disposed = false;

  protected constructor(
    readonly device: GlContext,
    protected currentSize: PixelSize,
    protected currentDpiScale: number,
  ) {
    checkSize(currentSize, device.capabilities.maxTextureDimension, true);
  }

  get size(): PixelSize {
    return this.currentSize;
  }

  get dpiScale(): number {
    return this.currentDpiScale;
  }

  /** Binds the framebuffer a frame draws into; called once per frame. */
  abstract bind(): void;

  /** Shows what was drawn, once the frame is submitted. */
  abstract present(): void;

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
export class WebGlOffscreenTarget extends WebGlTarget implements OffscreenRenderTarget {
  private readonly texture: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;

  constructor(device: GlContext, size: PixelSize, dpiScale: number) {
    super(device, size, dpiScale);
    checkSize(size, device.capabilities.maxTextureDimension, false);
    const gl = device.gl;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size.width, size.height);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind(): void {
    this.device.gl.bindFramebuffer(this.device.gl.FRAMEBUFFER, this.framebuffer);
  }

  present(): void {
    // The texture keeps what was drawn; nothing to show.
  }

  readPixels(): Promise<Uint8Array> {
    this.ensureUsable();
    const gl = this.device.gl;
    const { width, height } = this.size;
    const row = width * 4;
    const flipped = new Uint8Array(row * height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // WebGL reads the bottom row first; the interface wants the top row first.
    const pixels = new Uint8Array(row * height);
    for (let y = 0; y < height; y++) {
      pixels.set(flipped.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    return Promise.resolve(pixels);
  }

  protected release(): void {
    this.device.gl.deleteFramebuffer(this.framebuffer);
    this.device.gl.deleteTexture(this.texture);
  }
}

/** A canvas as target; submitting a frame shows it. */
export class WebGlSurfaceTarget extends WebGlTarget implements SurfaceRenderTarget {
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly context: ImageBitmapRenderingContext;

  constructor(device: GlContext, surface: SurfaceHandle, size: PixelSize, dpiScale: number) {
    super(device, size, dpiScale);
    const canvas = surface.canvas as HTMLCanvasElement | OffscreenCanvas | null;
    const context = typeof canvas?.getContext === 'function' ? canvas.getContext('bitmaprenderer') : null;
    if (!canvas || !context) {
      throw new TypeError('The surface is no canvas that can show image bitmaps.');
    }
    this.canvas = canvas;
    this.context = context;
    this.applySize();
  }

  resize(size: PixelSize, dpiScale: number): void {
    this.ensureUsable();
    checkSize(size, this.device.capabilities.maxTextureDimension, true);
    this.currentSize = size;
    this.currentDpiScale = dpiScale;
    this.applySize();
  }

  bind(): void {
    // The canvas of the context takes the size of the target; setting it only when it differs keeps its buffer.
    const shared = this.device.canvas;
    if (shared.width !== this.size.width) {
      shared.width = this.size.width;
    }
    if (shared.height !== this.size.height) {
      shared.height = this.size.height;
    }
    this.device.gl.bindFramebuffer(this.device.gl.FRAMEBUFFER, null);
  }

  present(): void {
    const shared = this.device.canvas;
    if ('transferToImageBitmap' in shared) {
      this.context.transferFromImageBitmap(shared.transferToImageBitmap());
    }
  }

  protected release(): void {
    // The bitmap renderer holds nothing beyond the last frame.
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
