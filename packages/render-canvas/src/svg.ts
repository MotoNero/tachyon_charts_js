// A device that writes SVG, as the vector target of the Skia backend of the .NET version: rectangles, triangles,
// lines and markers stay vectors; text, rasters and markers by the hundred thousand become pictures, which
// chartToSvg embeds as PNG.
import {
  BufferUsage,
  DeviceLostError,
  wordsOf,
  type BufferDesc,
  type CommandList,
  type DeviceCapabilities,
  type GpuBuffer,
  type GpuTexture,
  type MarkerShape,
  type MarkerStyle,
  type OffscreenRenderTarget,
  type PixelRect,
  type PixelSize,
  type PolylineStyle,
  type RasterStyle,
  type RenderDevice,
  type RenderTarget,
  type Rgba8,
  type SurfaceRenderTarget,
  type TextureDesc,
} from '@tachyon-charts/core';
import { canSplat, paintRaster, rasterizeGlyphs, splatCount, splatMarkers } from './painters';
import { CanvasBuffer, CanvasTexture } from './resources';
import { checkSize } from './targets';

const gap = 1e30;
const glowLayers = 5;

/** A picture of a frame, embedded once it is encoded. */
export interface SvgPicture {
  readonly pixels: ImageData;
  readonly placeholder: string;
}

const number = (value: number): string => String(Math.round(value * 1000) / 1000);

function color(value: Rgba8, alphaFactor = 1): string {
  const alpha = (value.a / 255) * alphaFactor;
  const rgb = `rgb(${String(value.r)},${String(value.g)},${String(value.b)})`;
  return alpha >= 1 ? `fill="${rgb}"` : `fill="${rgb}" fill-opacity="${number(alpha)}"`;
}

function stroke(value: Rgba8, alphaFactor: number): string {
  const alpha = (value.a / 255) * alphaFactor;
  const rgb = `rgb(${String(value.r)},${String(value.g)},${String(value.b)})`;
  return alpha >= 1 ? `stroke="${rgb}"` : `stroke="${rgb}" stroke-opacity="${number(alpha)}"`;
}

function wordColor(word: number): Rgba8 {
  return { r: word & 255, g: (word >>> 8) & 255, b: (word >>> 16) & 255, a: word >>> 24 };
}

function isDrawable(bounds: PixelRect): boolean {
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0
  );
}

const unitShapes: Record<Exclude<MarkerShape, 'circle' | 'square'>, readonly (readonly [number, number])[]> = {
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
  cross: [],
};

/** A target that keeps the last frame as SVG. */
export class SvgTarget implements OffscreenRenderTarget {
  /** The elements of the last frame. */
  content = '';
  /** The pictures the last frame refers to. */
  pictures: SvgPicture[] = [];
  private disposed = false;

  constructor(
    readonly device: SvgDevice,
    readonly size: PixelSize,
    readonly dpiScale: number,
  ) {
    checkSize(size, device.capabilities.maxTextureDimension, false);
  }

  /** An SVG target has no pixels. */
  readPixels(): Promise<Uint8Array> {
    return Promise.reject(new Error('An SVG target has no pixels; read its content.'));
  }

  dispose(): void {
    this.disposed = true;
  }

  ensureUsable(): void {
    if (this.disposed) {
      throw new Error('The render target is disposed.');
    }
    this.device.ensureUsable();
  }
}

/** A {@link @tachyon-charts/core#RenderDevice} that writes SVG; chartToSvg uses it. */
export class SvgDevice implements RenderDevice {
  /** What the device supports. */
  readonly capabilities: DeviceCapabilities = {
    backendName: 'SVG',
    supportsCompute: false,
    maxBufferSize: 2 ** 31 - 4,
    maxTextureDimension: 16_384,
    maxSampleCount: 1,
  };
  private disposed = false;
  private readonly frame = new SvgFrame(this);

  /** Draw calls issued so far. */
  drawCallCount = 0;

  /** Bytes written to buffers and textures so far. */
  uploadedByteCount = 0;

  readonly isLost = false;
  readonly lostReason: string | undefined = undefined;

  onLost(): () => void {
    return () => undefined;
  }

  simulateLoss(): void {
    throw new DeviceLostError('An SVG device cannot be lost.');
  }

  createBuffer(desc: BufferDesc): GpuBuffer {
    this.ensureUsable();
    return new CanvasBuffer(this, desc.sizeInBytes, desc.usage);
  }

  createTexture(desc: TextureDesc): GpuTexture {
    this.ensureUsable();
    return new CanvasTexture(this, desc.size, desc.format);
  }

  createOffscreenTarget(size: PixelSize, dpiScale: number): OffscreenRenderTarget {
    this.ensureUsable();
    return new SvgTarget(this, size, dpiScale);
  }

  createSurfaceTarget(): SurfaceRenderTarget {
    throw new TypeError('An SVG device draws into SVG targets only.');
  }

  beginFrame(target: RenderTarget): CommandList {
    this.ensureUsable();
    if (!(target instanceof SvgTarget) || target.device !== this) {
      throw new TypeError('The target belongs to another device.');
    }
    if (this.frame.isActive) {
      throw new Error('A frame is still being recorded; submit or dispose it first.');
    }
    return this.frame.begin(target);
  }

  whenIdle(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
  }

  ensureUsable(): void {
    if (this.disposed) {
      throw new Error('The render device is disposed.');
    }
  }
}

class SvgFrame implements CommandList {
  private target: SvgTarget | undefined;
  private parts: string[] = [];
  private pictures: SvgPicture[] = [];
  private definitions: string[] = [];
  private nextId = 0;
  private turned = false;

  constructor(private readonly device: SvgDevice) {}

  get isActive(): boolean {
    return this.target !== undefined;
  }

  begin(target: SvgTarget): this {
    this.target = target;
    this.parts = [];
    this.pictures = [];
    this.definitions = [];
    this.turned = false;
    return this;
  }

  clear(value: Rgba8): void {
    this.recording();
    // A clear covers everything: what came before has no effect.
    this.parts = [];
    this.pictures = [];
    const { width, height } = (this.target as SvgTarget).size;
    this.parts.push(`<rect width="${String(width)}" height="${String(height)}" ${color(value)}/>`);
  }

  fillRectangle(bounds: PixelRect, value: Rgba8): void {
    this.recording();
    if (isDrawable(bounds)) {
      this.parts.push(
        `<rect x="${number(bounds.x)}" y="${number(bounds.y)}" width="${number(bounds.width)}" height="${number(bounds.height)}" ${color(value)}/>`,
      );
      this.device.drawCallCount++;
    }
  }

  fillLinearGradient(bounds: PixelRect, startColor: Rgba8, endColor: Rgba8, vertical: boolean): void {
    this.recording();
    if (!isDrawable(bounds)) {
      return;
    }
    const id = `g${String(this.nextId++)}`;
    const end = vertical ? 'x2="0" y2="1"' : 'x2="1" y2="0"';
    const stop = (offset: number, value: Rgba8): string =>
      `<stop offset="${String(offset)}" stop-color="rgb(${String(value.r)},${String(value.g)},${String(value.b)})" stop-opacity="${number(value.a / 255)}"/>`;
    this.definitions.push(
      `<linearGradient id="${id}" x1="0" y1="0" ${end}>${stop(0, startColor)}${stop(1, endColor)}</linearGradient>`,
    );
    this.parts.push(
      `<rect x="${number(bounds.x)}" y="${number(bounds.y)}" width="${number(bounds.width)}" height="${number(bounds.height)}" fill="url(#${id})"/>`,
    );
    this.device.drawCallCount++;
  }

  fillTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, value: Rgba8): void {
    this.recording();
    if ([ax, ay, bx, by, cx, cy].every(Number.isFinite)) {
      this.parts.push(
        `<path d="M${number(ax)} ${number(ay)}L${number(bx)} ${number(by)}L${number(cx)} ${number(cy)}Z" ${color(value)}/>`,
      );
      this.device.drawCallCount++;
    }
  }

  // One path per color, each triangle in the mean of its corners: triangles of their own would show hairlines between
  // them in a viewer, as the vector target of the .NET version knows.
  fillMesh(vertices: Float32Array, count: number, clip?: PixelRect): void {
    this.recording();
    const corners = Math.min(count, Math.floor(vertices.length / 3));
    const usable = corners - (corners % 3);
    if (usable <= 0) {
      return;
    }
    const words = wordsOf(vertices);
    const base = vertices.byteOffset / 4;
    const paths = new Map<number, string[]>();
    for (let i = 0; i < usable; i += 3) {
      const mean = meanColor(
        words[base + i * 3 + 2] as number,
        words[base + i * 3 + 5] as number,
        words[base + i * 3 + 8] as number,
      );
      const path = paths.get(mean) ?? [];
      paths.set(mean, path);
      path.push(
        `M${number(vertices[i * 3] as number)} ${number(vertices[i * 3 + 1] as number)}L${number(vertices[i * 3 + 3] as number)} ${number(vertices[i * 3 + 4] as number)}L${number(vertices[i * 3 + 6] as number)} ${number(vertices[i * 3 + 7] as number)}Z`,
      );
    }
    const open = this.openClip(clip);
    for (const [word, path] of paths) {
      this.parts.push(`<path d="${path.join('')}" ${color(wordColor(word))}/>`);
    }
    this.closeClip(open);
    this.device.drawCallCount++;
  }

  drawTextPlaceholder(bounds: PixelRect, value: Rgba8): void {
    this.fillRectangle(bounds, value);
  }

  drawPolyline(points: GpuBuffer, firstPoint: number, pointCount: number, style: PolylineStyle): void {
    this.recording();
    const buffer = vertexSource(points, this.device);
    if (pointCount < 2) {
      return;
    }
    const positions = buffer.floats.subarray(firstPoint * 2, (firstPoint + pointCount) * 2);
    const path = segmentsPath(positions, style);
    if (path === '') {
      return;
    }
    const width = style.widthInPixels <= 1 ? 1 : style.widthInPixels;
    const open = this.openClip(style.clip);
    const radius = style.glowRadius ?? 0;
    if (radius > 0) {
      // As the Skia backend: a few wider strokes, lightened so that they do not add up.
      const intensity = style.glowIntensity ?? 0;
      for (let layer = glowLayers; layer >= 1; layer--) {
        const reach = layer / glowLayers;
        const alpha = (style.color.a / 255) * intensity * Math.exp(-2 * reach * reach);
        const glow = {
          r: Math.trunc(style.color.r * alpha),
          g: Math.trunc(style.color.g * alpha),
          b: Math.trunc(style.color.b * alpha),
          a: 255,
        };
        this.parts.push(
          `<path d="${path}" fill="none" ${stroke(glow, 1)} stroke-width="${number(width + 2 * radius * reach)}" stroke-linecap="round" stroke-linejoin="round" style="mix-blend-mode:lighten"/>`,
        );
      }
    }
    this.parts.push(
      `<path d="${path}" fill="none" ${stroke(style.color, Math.min(style.widthInPixels, 1))} stroke-width="${number(width)}" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
    this.closeClip(open);
    this.device.drawCallCount++;
  }

  drawMarkers(markers: GpuBuffer, firstMarker: number, markerCount: number, style: MarkerStyle): void {
    this.recording();
    const buffer = vertexSource(markers, this.device);
    if (markerCount < 1) {
      return;
    }
    const target = this.target as SvgTarget;
    if (markerCount >= splatCount && canSplat(style)) {
      const { width, height } = target.size;
      const image = new ImageData(width, height);
      splatMarkers(buffer.floats, buffer.words, firstMarker, markerCount, style, image.data, width, height);
      this.picture(image, 0, 0);
      return;
    }
    const scaleX = style.scaleX ?? 1;
    const scaleY = style.scaleY ?? 1;
    const offsetX = style.offsetX ?? 0;
    const offsetY = style.offsetY ?? 0;
    const sizeScale = style.sizeScale ?? 1;
    const border = style.borderWidthInPixels;
    const open = this.openClip(style.clip);
    for (let i = firstMarker; i < firstMarker + markerCount; i++) {
      const x = (buffer.floats[i * 4] as number) * scaleX + offsetX;
      const y = (buffer.floats[i * 4 + 1] as number) * scaleY + offsetY;
      const size = (buffer.floats[i * 4 + 2] as number) * sizeScale;
      if (![x, y, size].every(Number.isFinite) || size <= 0) {
        continue;
      }
      if (border > 0) {
        this.parts.push(shape(x, y, size, style.shape, color(style.borderColor)));
      }
      const inner = size - 2 * border;
      if (inner > 0) {
        this.parts.push(shape(x, y, inner, style.shape, color(wordColor(buffer.words[i * 4 + 3] as number))));
      }
    }
    this.closeClip(open);
    this.device.drawCallCount++;
  }

  drawGlyphs(atlas: GpuTexture, glyphs: Float32Array, count: number): void {
    this.recording();
    const texture = textureSource(atlas, this.device);
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
      (this.target as SvgTarget).size,
    );
    if (image) {
      this.picture(new ImageData(image.pixels, image.width, image.height), image.left, image.top);
    }
  }

  drawImage(image: GpuTexture, bounds: PixelRect): void {
    this.recording();
    const texture = textureSource(image, this.device);
    if (!isDrawable(bounds)) {
      return;
    }
    const pixels = new ImageData(new Uint8ClampedArray(texture.bytes), texture.size.width, texture.size.height);
    this.picture(pixels, bounds.x, bounds.y, bounds.width, bounds.height);
  }

  drawRaster(values: GpuTexture, colormap: GpuTexture, bounds: PixelRect, style: RasterStyle): void {
    this.recording();
    const source = textureSource(values, this.device);
    const table = textureSource(colormap, this.device);
    if (!isDrawable(bounds)) {
      return;
    }
    const left = Math.ceil(bounds.x - 0.5);
    const top = Math.ceil(bounds.y - 0.5);
    const width = Math.ceil(bounds.x + bounds.width - 0.5) - left;
    const height = Math.ceil(bounds.y + bounds.height - 0.5) - top;
    if (width <= 0 || height <= 0) {
      return;
    }
    const image = new ImageData(width, height);
    paintRaster(
      { values: source.floats, width: source.size.width, height: source.size.height },
      table.bytes.subarray(0, table.size.width * 4),
      image.data,
      { left, top, width, height },
      bounds,
      style,
    );
    this.picture(image, left, top);
  }

  setQuarterTurn(sum: number | undefined): void {
    this.recording();
    if (this.turned) {
      this.parts.push('</g>');
      this.turned = false;
    }
    if (sum !== undefined) {
      this.parts.push(`<g transform="matrix(0 1 -1 0 ${number(sum)} 0)">`);
      this.turned = true;
    }
  }

  submit(): void {
    this.recording();
    this.setQuarterTurn(undefined);
    const target = this.target as SvgTarget;
    const definitions = this.definitions.length > 0 ? `<defs>${this.definitions.join('')}</defs>` : '';
    target.content = definitions + this.parts.join('\n');
    target.pictures = this.pictures;
    this.target = undefined;
  }

  dispose(): void {
    this.target = undefined;
  }

  private picture(pixels: ImageData, x: number, y: number, width = pixels.width, height = pixels.height): void {
    const placeholder = `#picture-${String(this.nextId++)}`;
    this.pictures.push({ pixels, placeholder });
    this.parts.push(
      `<image x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" preserveAspectRatio="none" style="image-rendering:pixelated" href="${placeholder}"/>`,
    );
    this.device.drawCallCount++;
  }

  private openClip(clip: PixelRect | undefined): boolean {
    if (!clip) {
      return false;
    }
    const id = `c${String(this.nextId++)}`;
    this.definitions.push(
      `<clipPath id="${id}"><rect x="${number(clip.x)}" y="${number(clip.y)}" width="${number(clip.width)}" height="${number(clip.height)}"/></clipPath>`,
    );
    this.parts.push(`<g clip-path="url(#${id})">`);
    return true;
  }

  private closeClip(open: boolean): void {
    if (open) {
      this.parts.push('</g>');
    }
  }

  private recording(): void {
    if (!this.target) {
      throw new Error('The frame is not recording: it was submitted or disposed.');
    }
    this.target.ensureUsable();
  }
}

function vertexSource(buffer: GpuBuffer, device: SvgDevice): CanvasBuffer {
  if (!(buffer instanceof CanvasBuffer) || buffer.device !== device) {
    throw new TypeError('The buffer belongs to another device.');
  }
  if ((buffer.usage & BufferUsage.vertex) === 0) {
    throw new TypeError('The buffer was not created for vertex data.');
  }
  buffer.ensureUsable();
  return buffer;
}

function textureSource(texture: GpuTexture, device: SvgDevice): CanvasTexture {
  if (!(texture instanceof CanvasTexture) || texture.device !== device) {
    throw new TypeError('The texture belongs to another device.');
  }
  texture.ensureUsable();
  return texture;
}

// The segments of a line as one path; points next to a gap are left out.
function segmentsPath(positions: Float32Array, style: PolylineStyle): string {
  const scaleX = style.scaleX ?? 1;
  const scaleY = style.scaleY ?? 1;
  const offsetX = style.offsetX ?? 0;
  const offsetY = style.offsetY ?? 0;
  const path: string[] = [];
  let open = false;
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i] as number;
    if (x >= gap) {
      open = false;
      continue;
    }
    const px = number(x * scaleX + offsetX);
    const py = number((positions[i + 1] as number) * scaleY + offsetY);
    path.push(open ? `L${px} ${py}` : `M${px} ${py}`);
    open = true;
  }
  // A single point without a neighbor draws nothing, as on the screen.
  return path.filter((part, i) => part.startsWith('L') || path[i + 1]?.startsWith('L')).join('');
}

function shape(x: number, y: number, size: number, kind: MarkerShape, fill: string): string {
  const half = size / 2;
  if (kind === 'circle') {
    return `<circle cx="${number(x)}" cy="${number(y)}" r="${number(half)}" ${fill}/>`;
  }
  if (kind === 'square') {
    return `<rect x="${number(x - half)}" y="${number(y - half)}" width="${number(size)}" height="${number(size)}" ${fill}/>`;
  }
  const turn = kind === 'cross';
  const points = unitShapes[turn ? 'plus' : kind];
  const d = points
    .map(([px, py], i) => {
      const sx = turn ? (px - py) * 0.70710678 : px;
      const sy = turn ? (px + py) * 0.70710678 : py;
      return `${i === 0 ? 'M' : 'L'}${number(x + sx * half)} ${number(y + sy * half)}`;
    })
    .join('');
  return `<path d="${d}Z" ${fill}/>`;
}

function meanColor(a: number, b: number, c: number): number {
  const channel = (shift: number): number =>
    Math.trunc((((a >>> shift) & 255) + ((b >>> shift) & 255) + ((c >>> shift) & 255)) / 3);
  return ((channel(24) << 24) | (channel(16) << 16) | (channel(8) << 8) | channel(0)) >>> 0;
}
