// The command list of one frame on Canvas 2D, as SkiaCommandList of the .NET version: lines as strokes with round caps
// and joins (up to one pixel as thin lines with less coverage), the glow as a few wider strokes, markers as paths or,
// many of them, written into pixels, text, rasters and many markers on the CPU and drawn as images. The commands draw
// on a canvas of the target; submit shows it.
import {
  BufferUsage,
  packRgba8,
  wordsOf,
  type CommandList,
  type GpuBuffer,
  type GpuTexture,
  type MarkerShape,
  type MarkerStyle,
  type PixelRect,
  type PolylineStyle,
  type RasterStyle,
  type Rgba8,
} from '@tachyon-charts/core';
import { canSplat, paintRaster, rasterizeGlyphs, rasterizeMesh, splatCount, splatMarkers } from './painters';
import { CanvasBuffer, CanvasTexture, type CanvasContext } from './resources';
import { context2d, makeCanvas, type CanvasTarget, type Context2D } from './targets';

const gap = 1e30;
const glowLayers = 5;
const minimumPointsPerColumn = 3;

const finite = (...values: number[]): boolean => values.every(Number.isFinite);

function css(color: Rgba8, alphaFactor = 1): string {
  return `rgba(${String(color.r)},${String(color.g)},${String(color.b)},${String(Math.round(color.a * alphaFactor) / 255)})`;
}

function cssWord(word: number): string {
  return `rgba(${String(word & 255)},${String((word >>> 8) & 255)},${String((word >>> 16) & 255)},${String((word >>> 24) / 255)})`;
}

function isDrawable(bounds: PixelRect): boolean {
  return finite(bounds.x, bounds.y, bounds.width, bounds.height) && bounds.width > 0 && bounds.height > 0;
}

// The marker shapes on a unit square, as the paths of the Skia backend.
const shapePoints: Partial<Record<MarkerShape, readonly (readonly [number, number])[]>> = {
  triangle: [
    [0, -1.1547005],
    [1, 0.57735027],
    [-1, 0.57735027],
  ],
  diamond: [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ],
  plus: [
    [-0.34, -1],
    [0.34, -1],
    [0.34, -0.34],
    [1, -0.34],
    [1, 0.34],
    [0.34, 0.34],
    [0.34, 1],
    [-0.34, 1],
    [-0.34, 0.34],
    [-1, 0.34],
    [-1, -0.34],
    [-0.34, -0.34],
  ],
};

export class CanvasFrame implements CommandList {
  private target: CanvasTarget | undefined;
  private context: Context2D | undefined;
  private turned = false;
  private readonly triangle = new Float32Array(9);
  private scratch: OffscreenCanvas | HTMLCanvasElement | undefined;
  private scratchContext: Context2D | undefined;

  constructor(private readonly device: CanvasContext) {}

  /** Whether a frame is being recorded. */
  get isActive(): boolean {
    return this.target !== undefined;
  }

  /** Starts a frame on the target. */
  begin(target: CanvasTarget): this {
    if (target.size.width === 0 || target.size.height === 0) {
      throw new RangeError('A target without size gets no frames; stop drawing until it has one.');
    }
    this.target = target;
    this.context = target.beginDrawing();
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.globalCompositeOperation = 'source-over';
    this.context.globalAlpha = 1;
    this.turned = false;
    return this;
  }

  clear(color: Rgba8): void {
    const context = this.recording();
    const { width, height } = (this.target as CanvasTarget).size;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = 'copy';
    context.fillStyle = css(color);
    context.fillRect(0, 0, width, height);
    context.restore();
  }

  fillRectangle(bounds: PixelRect, color: Rgba8): void {
    const context = this.recording();
    if (!isDrawable(bounds)) {
      return;
    }
    // Without anti-aliasing, as the Skia backend: the pixels whose centers are inside.
    const left = Math.round(bounds.x);
    const top = Math.round(bounds.y);
    const right = Math.round(bounds.x + bounds.width);
    const bottom = Math.round(bounds.y + bounds.height);
    context.fillStyle = css(color);
    context.fillRect(left, top, right - left, bottom - top);
    this.device.drawCallCount++;
  }

  fillLinearGradient(bounds: PixelRect, startColor: Rgba8, endColor: Rgba8, vertical: boolean): void {
    const context = this.recording();
    if (!isDrawable(bounds)) {
      return;
    }
    const gradient = vertical
      ? context.createLinearGradient(bounds.x, bounds.y, bounds.x, bounds.y + bounds.height)
      : context.createLinearGradient(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y);
    gradient.addColorStop(0, css(startColor));
    gradient.addColorStop(1, css(endColor));
    context.fillStyle = gradient;
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    this.device.drawCallCount++;
  }

  // Without anti-aliasing, as the Skia backend fills triangles: the pixels whose centers are inside.
  fillTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, color: Rgba8): void {
    this.recording();
    if (!finite(ax, ay, bx, by, cx, cy)) {
      return;
    }
    const corners = this.triangle;
    const words = wordsOf(corners);
    const packed = packRgba8(color);
    corners.set([ax, ay, 0, bx, by, 0, cx, cy, 0]);
    words[2] = packed;
    words[5] = packed;
    words[8] = packed;
    this.fillMesh(corners, 3);
  }

  // Canvas 2D has no colors per corner: the triangles are filled on the CPU, as Skia draws vertices, and drawn as an
  // image.
  fillMesh(vertices: Float32Array, count: number, clip?: PixelRect): void {
    const context = this.recording();
    const corners = Math.min(count, Math.floor(vertices.length / 3));
    const usable = corners - (corners % 3);
    if (usable <= 0) {
      return;
    }
    const limit = this.device.capabilities.maxTextureDimension;
    const area = clip
      ? {
          left: Math.ceil(clip.x - 0.5),
          top: Math.ceil(clip.y - 0.5),
          right: Math.ceil(clip.x + clip.width - 0.5),
          bottom: Math.ceil(clip.y + clip.height - 0.5),
        }
      : { left: -limit, top: -limit, right: limit, bottom: limit };
    const image = rasterizeMesh(vertices, wordsOf(vertices), usable, area);
    if (image) {
      this.drawPixels(context, new ImageData(image.pixels, image.width, image.height), image.left, image.top);
    }
    this.device.drawCallCount++;
  }

  drawTextPlaceholder(bounds: PixelRect, color: Rgba8): void {
    this.fillRectangle(bounds, color);
  }

  drawPolyline(points: GpuBuffer, firstPoint: number, pointCount: number, style: PolylineStyle): void {
    const context = this.recording();
    const buffer = this.vertexSource(points);
    if (pointCount < 2) {
      return;
    }
    checkRange(points, firstPoint, pointCount, 8);
    const positions = buffer.floats.subarray(firstPoint * 2, (firstPoint + pointCount) * 2);
    const width = style.widthInPixels;
    context.save();
    this.clipTo(context, style.clip);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    // Widths below one pixel get less coverage, as in the line shader; up to one pixel the line is one pixel wide.
    const lineWidth = width <= 1 ? 1 : width;
    if ((style.glowRadius ?? 0) > 0) {
      this.drawGlow(context, positions, style, lineWidth);
    }
    context.lineWidth = lineWidth;
    context.strokeStyle = css(style.color, Math.min(width, 1));
    this.strokeSegments(context, positions, style);
    context.restore();
    this.device.drawCallCount++;
  }

  drawMarkers(markers: GpuBuffer, firstMarker: number, markerCount: number, style: MarkerStyle): void {
    const context = this.recording();
    const buffer = this.vertexSource(markers);
    if (markerCount < 1) {
      return;
    }
    checkRange(markers, firstMarker, markerCount, 16);
    if (markerCount >= splatCount && canSplat(style)) {
      const { width, height } = (this.target as CanvasTarget).size;
      const image = new ImageData(width, height);
      splatMarkers(buffer.floats, buffer.words, firstMarker, markerCount, style, image.data, width, height);
      this.drawPixels(context, image, 0, 0);
      this.device.drawCallCount++;
      return;
    }
    const scaleX = style.scaleX ?? 1;
    const scaleY = style.scaleY ?? 1;
    const offsetX = style.offsetX ?? 0;
    const offsetY = style.offsetY ?? 0;
    const sizeScale = style.sizeScale ?? 1;
    const border = style.borderWidthInPixels;
    const borderColor = border > 0 ? css(style.borderColor) : '';
    context.save();
    this.clipTo(context, style.clip);
    for (let i = firstMarker; i < firstMarker + markerCount; i++) {
      const x = Math.fround((buffer.floats[i * 4] as number) * scaleX + offsetX);
      const y = Math.fround((buffer.floats[i * 4 + 1] as number) * scaleY + offsetY);
      const size = Math.fround((buffer.floats[i * 4 + 2] as number) * sizeScale);
      if (!finite(x, y, size) || size <= 0) {
        continue;
      }
      if (border > 0) {
        context.fillStyle = borderColor;
        this.fillShape(context, x, y, size, style.shape);
      }
      const inner = size - 2 * border;
      if (inner > 0) {
        context.fillStyle = cssWord(buffer.words[i * 4 + 3] as number);
        this.fillShape(context, x, y, inner, style.shape);
      }
    }
    context.restore();
    this.device.drawCallCount++;
  }

  drawGlyphs(atlas: GpuTexture, glyphs: Float32Array, count: number): void {
    const context = this.recording();
    const texture = this.textureSource(atlas);
    if (texture.format !== 'rgba8unorm') {
      throw new TypeError('The atlas must be RGBA.');
    }
    const usable = Math.min(count, Math.floor(glyphs.length / 13));
    if (usable <= 0) {
      return;
    }
    const image = rasterizeGlyphs(
      texture.bytes,
      texture.size.width,
      glyphs,
      wordsOf(glyphs),
      usable,
      (this.target as CanvasTarget).size,
    );
    if (image) {
      this.drawPixels(context, new ImageData(image.pixels, image.width, image.height), image.left, image.top);
    }
    this.device.drawCallCount++;
  }

  drawImage(image: GpuTexture, bounds: PixelRect): void {
    const context = this.recording();
    const texture = this.textureSource(image);
    if (texture.format !== 'rgba8unorm') {
      throw new TypeError('The image must be RGBA.');
    }
    if (!isDrawable(bounds)) {
      return;
    }
    const { width, height } = texture.size;
    const pixels = new ImageData(new Uint8ClampedArray(texture.bytes), width, height);
    const scratch = this.scratchFor(width, height);
    scratch.putImageData(pixels, 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(scratch.canvas, 0, 0, width, height, bounds.x, bounds.y, bounds.width, bounds.height);
    this.device.drawCallCount++;
  }

  drawRaster(values: GpuTexture, colormap: GpuTexture, bounds: PixelRect, style: RasterStyle): void {
    const context = this.recording();
    const source = this.textureSource(values);
    const table = this.textureSource(colormap);
    if (source.format !== 'r32float' || table.format !== 'rgba8unorm') {
      throw new TypeError('A raster takes r32float values and an RGBA colormap.');
    }
    if (!isDrawable(bounds)) {
      return;
    }
    // The pixels whose centers are inside, like the rasterization of a GPU.
    const left = Math.ceil(bounds.x - 0.5);
    const top = Math.ceil(bounds.y - 0.5);
    const right = Math.ceil(bounds.x + bounds.width - 0.5);
    const bottom = Math.ceil(bounds.y + bounds.height - 0.5);
    if (right <= left || bottom <= top) {
      return;
    }
    const area = { left, top, width: right - left, height: bottom - top };
    const image = new ImageData(area.width, area.height);
    paintRaster(
      { values: source.floats, width: source.size.width, height: source.size.height },
      table.bytes.subarray(0, table.size.width * 4),
      image.data,
      area,
      bounds,
      style,
    );
    this.drawPixels(context, image, left, top);
    this.device.drawCallCount++;
  }

  // The turn is a transform of the context, so every kind of drawing and every clip turns alike.
  setQuarterTurn(sum: number | undefined): void {
    const context = this.recording();
    if (this.turned) {
      context.restore();
      this.turned = false;
    }
    if (sum !== undefined) {
      context.save();
      context.transform(0, 1, -1, 0, sum, 0);
      this.turned = true;
    }
  }

  submit(): void {
    this.recording();
    this.setQuarterTurn(undefined);
    (this.target as CanvasTarget).present();
    this.finish();
  }

  dispose(): void {
    // Without submit the frame is not shown; the target wipes it out with its next frame.
    if (this.isActive) {
      if (this.turned) {
        this.context?.restore();
      }
      this.finish();
    }
  }

  private finish(): void {
    this.target = undefined;
    this.context = undefined;
    this.turned = false;
  }

  private clipTo(context: Context2D, clip: PixelRect | undefined): void {
    if (clip) {
      context.beginPath();
      context.rect(clip.x, clip.y, clip.width, clip.height);
      context.clip();
    }
  }

  // Pixels drawn as an image at their place: through a scratch canvas, since putImageData ignores the transform and
  // blending.
  private drawPixels(context: Context2D, image: ImageData, left: number, top: number): void {
    const scratch = this.scratchFor(image.width, image.height);
    scratch.putImageData(image, 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(scratch.canvas, 0, 0, image.width, image.height, left, top, image.width, image.height);
  }

  private scratchFor(width: number, height: number): Context2D {
    if (!this.scratch || this.scratch.width < width || this.scratch.height < height) {
      this.scratch = makeCanvas(Math.max(width, this.scratch?.width ?? 0), Math.max(height, this.scratch?.height ?? 0));
      this.scratchContext = context2d(this.scratch);
    }
    const scratch = this.scratchContext as Context2D;
    scratch.clearRect(0, 0, width, height);
    return scratch;
  }

  private fillShape(context: Context2D, x: number, y: number, size: number, shape: MarkerShape): void {
    const half = size * 0.5;
    context.beginPath();
    if (shape === 'circle') {
      context.arc(x, y, half, 0, Math.PI * 2);
    } else if (shape === 'square') {
      context.rect(x - half, y - half, size, size);
    } else {
      const points = shapePoints[shape === 'cross' ? 'plus' : shape] ?? [];
      const turn = shape === 'cross';
      points.forEach(([px, py], i) => {
        // The cross is the plus turned by 45 degrees.
        const sx = turn ? (px - py) * 0.70710678 : px;
        const sy = turn ? (px + py) * 0.70710678 : py;
        if (i === 0) {
          context.moveTo(x + sx * half, y + sy * half);
        } else {
          context.lineTo(x + sx * half, y + sy * half);
        }
      });
      context.closePath();
    }
    context.fill();
  }

  private strokeSegments(context: Context2D, positions: Float32Array, style: PolylineStyle): void {
    const width = (this.target as CanvasTarget).size.width;
    const count = positions.length / 2;
    if (count > width * minimumPointsPerColumn && isAscending(positions)) {
      this.strokeColumns(context, positions, style);
      return;
    }
    const scaleX = style.scaleX ?? 1;
    const scaleY = style.scaleY ?? 1;
    const offsetX = style.offsetX ?? 0;
    const offsetY = style.offsetY ?? 0;
    // Skia draws each segment on its own, so that neighbors blend where they overlap; two paths of every other
    // segment do the same with two strokes.
    for (const parity of [1, 2]) {
      context.beginPath();
      for (let i = parity; i < count; i += 2) {
        const x0 = positions[(i - 1) * 2] as number;
        const x1 = positions[i * 2] as number;
        if (x0 < gap && x1 < gap) {
          context.moveTo(
            Math.fround(x0 * scaleX + offsetX),
            Math.fround((positions[i * 2 - 1] as number) * scaleY + offsetY),
          );
          context.lineTo(
            Math.fround(x1 * scaleX + offsetX),
            Math.fround((positions[i * 2 + 1] as number) * scaleY + offsetY),
          );
        }
      }
      context.stroke();
    }
  }

  // A dense line holds several points per pixel column, and each would paint the same pixels again: one stroke from
  // the lowest to the highest point of a column shows the same.
  private strokeColumns(context: Context2D, positions: Float32Array, style: PolylineStyle): void {
    const scaleX = style.scaleX ?? 1;
    const scaleY = style.scaleY ?? 1;
    const offsetX = style.offsetX ?? 0;
    const offsetY = style.offsetY ?? 0;
    const columns = new Columns(context);
    context.beginPath();
    for (let i = 0; i < positions.length; i += 2) {
      const x = positions[i] as number;
      if (x >= gap) {
        columns.flush();
        columns.break();
        continue;
      }
      columns.add(Math.fround(x * scaleX + offsetX), Math.fround((positions[i + 1] as number) * scaleY + offsetY));
    }
    columns.flush();
    context.stroke();
  }

  // Simplified as in the Skia backend: a few wider strokes instead of a smooth falloff, lightened so that they do
  // not add up.
  private drawGlow(context: Context2D, positions: Float32Array, style: PolylineStyle, lineWidth: number): void {
    const radius = style.glowRadius ?? 0;
    const intensity = style.glowIntensity ?? 0;
    context.save();
    context.globalCompositeOperation = 'lighten';
    for (let layer = glowLayers; layer >= 1; layer--) {
      const reach = layer / glowLayers;
      const alpha = (style.color.a / 255) * intensity * Math.exp(-2 * reach * reach);
      context.lineWidth = lineWidth + 2 * radius * reach;
      context.strokeStyle = `rgb(${String(Math.trunc(style.color.r * alpha))},${String(Math.trunc(style.color.g * alpha))},${String(Math.trunc(style.color.b * alpha))})`;
      this.strokeSegments(context, positions, style);
    }
    context.restore();
  }

  private vertexSource(buffer: GpuBuffer): CanvasBuffer {
    if (!(buffer instanceof CanvasBuffer) || buffer.device !== this.device) {
      throw new TypeError('The buffer belongs to another device.');
    }
    if ((buffer.usage & BufferUsage.vertex) === 0) {
      throw new TypeError('The buffer was not created for vertex data.');
    }
    buffer.ensureUsable();
    return buffer;
  }

  private textureSource(texture: GpuTexture): CanvasTexture {
    if (!(texture instanceof CanvasTexture) || texture.device !== this.device) {
      throw new TypeError('The texture belongs to another device.');
    }
    texture.ensureUsable();
    return texture;
  }

  private recording(): Context2D {
    if (!this.target || !this.context) {
      throw new Error('The frame is not recording: it was submitted or disposed.');
    }
    this.target.ensureUsable();
    return this.context;
  }
}

// The lowest and highest point of each pixel column, joined to the column before.
class Columns {
  private column = Number.NEGATIVE_INFINITY;
  private low = 0;
  private high = 0;
  private hasPrevious = false;
  private lastY = 0;
  private lastX = 0;

  constructor(private readonly context: Context2D) {}

  add(x: number, y: number): void {
    const current = Math.floor(x);
    if (current === this.column) {
      this.low = Math.min(this.low, y);
      this.high = Math.max(this.high, y);
      return;
    }
    this.flush();
    this.column = current;
    this.low = y;
    this.high = y;
  }

  break(): void {
    this.column = Number.NEGATIVE_INFINITY;
    this.hasPrevious = false;
  }

  flush(): void {
    if (this.column === Number.NEGATIVE_INFINITY) {
      return;
    }
    const x = this.column + 0.5;
    if (this.hasPrevious) {
      this.context.moveTo(this.lastX, this.lastY);
      this.context.lineTo(x, Math.abs(this.lastY - this.low) < Math.abs(this.lastY - this.high) ? this.low : this.high);
    }
    this.context.moveTo(x, this.low);
    this.context.lineTo(x, this.high);
    this.lastX = x;
    this.lastY = this.high;
    this.hasPrevious = true;
    this.column = Number.NEGATIVE_INFINITY;
  }
}

function isAscending(positions: Float32Array): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i] as number;
    if (x < gap) {
      if (x < previous) {
        return false;
      }
      previous = x;
    }
  }
  return true;
}

function checkRange(buffer: GpuBuffer, first: number, count: number, size: number): void {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(count) ||
    first < 0 ||
    (first + count) * size > buffer.sizeInBytes
  ) {
    throw new RangeError(
      `${String(count)} elements from ${String(first)} do not fit into a buffer of ${String(buffer.sizeInBytes)} bytes.`,
    );
  }
}
