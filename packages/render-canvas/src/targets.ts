// Render targets of Canvas 2D: a canvas that can be read back, and a canvas on the page. A frame draws on a canvas of
// its target first and shows it with submit, so that a frame disposed without submit leaves no trace.
import type { OffscreenRenderTarget, PixelSize, SurfaceHandle, SurfaceRenderTarget } from '@tachyon-charts/core';
import type { CanvasContext } from './resources';

/** A 2D context of an OffscreenCanvas or of a canvas of the page. */
export type Context2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** A canvas of the given size: an OffscreenCanvas where there is one, else one of the document. */
export function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** The 2D context of a canvas; throws when it has none. */
export function context2d(canvas: OffscreenCanvas | HTMLCanvasElement, readsBack = false): Context2D {
  const context = canvas.getContext('2d', { willReadFrequently: readsBack }) as Context2D | null;
  if (!context) {
    throw new TypeError('The canvas has no 2D context.');
  }
  return context;
}

/** What a frame needs from a target. */
export abstract class CanvasTarget {
  private disposed = false;
  private back: OffscreenCanvas | HTMLCanvasElement | undefined;
  private backContext: Context2D | undefined;
  private drawing = false;

  protected constructor(
    readonly device: CanvasContext,
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

  /**
   * Starts a frame: the canvas it draws on, of the size of the target, with the content shown last. A frame before
   * that was not shown is wiped out by a copy of what is shown.
   */
  beginDrawing(): Context2D {
    const { width, height } = this.size;
    if (this.back?.width !== width || this.back.height !== height) {
      this.back = makeCanvas(width, height);
      this.backContext = context2d(this.back, true);
      this.copyShown(this.backContext);
    } else if (this.drawing) {
      this.copyShown(this.backContext as Context2D);
    }
    this.drawing = true;
    return this.backContext as Context2D;
  }

  /** Shows what the frame drew. */
  present(): void {
    if (this.back) {
      this.show(this.back);
    }
    this.drawing = false;
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.back = undefined;
      this.backContext = undefined;
    }
  }

  ensureUsable(): void {
    if (this.disposed) {
      throw new Error('The render target is disposed.');
    }
    this.device.ensureUsable();
  }

  /** Puts the drawn canvas where it is shown. */
  protected abstract show(drawn: OffscreenCanvas | HTMLCanvasElement): void;

  /** Copies what is shown into a new drawing canvas, so that frames without a clear draw on top of it. */
  protected abstract copyShown(into: Context2D): void;
}

export function checkSize(size: PixelSize, limit: number, allowEmpty: boolean): void {
  const lowest = allowEmpty ? 0 : 1;
  const fine = (value: number): boolean => Number.isInteger(value) && value >= lowest && value <= limit;
  if (!fine(size.width) || !fine(size.height)) {
    throw new RangeError(
      `A target needs a size from ${String(lowest)} to ${String(limit)} on each side, not ${String(size.width)} × ${String(size.height)}.`,
    );
  }
}

function replace(context: Context2D, drawn: OffscreenCanvas | HTMLCanvasElement): void {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'copy';
  context.globalAlpha = 1;
  context.drawImage(drawn, 0, 0);
  context.restore();
}

/** A canvas as target that is not on screen; its content can be read back. */
export class CanvasOffscreenTarget extends CanvasTarget implements OffscreenRenderTarget {
  private readonly front: OffscreenCanvas | HTMLCanvasElement;
  private readonly frontContext: Context2D;

  constructor(device: CanvasContext, size: PixelSize, dpiScale: number) {
    super(device, size, dpiScale);
    checkSize(size, device.capabilities.maxTextureDimension, false);
    this.front = makeCanvas(size.width, size.height);
    this.frontContext = context2d(this.front, true);
  }

  readPixels(): Promise<Uint8Array> {
    this.ensureUsable();
    const { width, height } = this.size;
    const image = this.frontContext.getImageData(0, 0, width, height);
    return Promise.resolve(new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength));
  }

  protected show(drawn: OffscreenCanvas | HTMLCanvasElement): void {
    replace(this.frontContext, drawn);
  }

  protected copyShown(into: Context2D): void {
    replace(into, this.front);
  }
}

/** A canvas of the page as target; submitting a frame shows it. */
export class CanvasSurfaceTarget extends CanvasTarget implements SurfaceRenderTarget {
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly context: Context2D;

  constructor(device: CanvasContext, surface: SurfaceHandle, size: PixelSize, dpiScale: number) {
    super(device, size, dpiScale);
    const canvas = surface.canvas as HTMLCanvasElement | OffscreenCanvas | null;
    const context = typeof canvas?.getContext === 'function' ? (canvas.getContext('2d') as Context2D | null) : null;
    if (!canvas || !context) {
      throw new TypeError('The surface is no canvas with a 2D context.');
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

  protected show(drawn: OffscreenCanvas | HTMLCanvasElement): void {
    replace(this.context, drawn);
  }

  protected copyShown(into: Context2D): void {
    if (this.canvas.width > 0 && this.canvas.height > 0) {
      replace(into, this.canvas);
    }
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
