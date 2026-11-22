// What the shaders do, on the CPU, as MarkerSplatter, RasterPainter and GlyphRasterizer of the Skia backend of the
// .NET version: many markers into pixels, a raster through its colormap, distance field glyphs. The results are
// RGBA pixels without premultiplied alpha, as ImageData takes them.
import type { MarkerStyle, PixelRect, RasterStyle, Rgba8 } from '@tachyon-charts/core';

/** The number of markers from which on they are written into pixels instead of drawn one by one. */
export const splatCount = 200_000;

/** Whether markers of the style can be written into pixels: round or square ones without border. */
export function canSplat(style: MarkerStyle): boolean {
  return style.borderWidthInPixels <= 0 && (style.shape === 'circle' || style.shape === 'square');
}

/**
 * Writes markers into premultiplied pixels of the size of the target, in their order and without anti-aliasing,
 * which cannot be seen at this density; then takes the premultiplication out again.
 * @param floats - The buffer of the markers as floats: x, y, size, color.
 * @param words - The same buffer as words, for the color.
 */
export function splatMarkers(
  floats: Float32Array,
  words: Uint32Array,
  first: number,
  count: number,
  style: MarkerStyle,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  let [left, right, top, bottom] = [0, width, 0, height];
  if (style.clip) {
    const clip = style.clip;
    left = Math.max(Math.ceil(clip.x - 0.5), 0);
    right = Math.min(Math.ceil(clip.x + clip.width - 0.5), width);
    top = Math.max(Math.ceil(clip.y - 0.5), 0);
    bottom = Math.min(Math.ceil(clip.y + clip.height - 0.5), height);
  }
  const scaleX = style.scaleX ?? 1;
  const scaleY = style.scaleY ?? 1;
  const offsetX = style.offsetX ?? 0;
  const offsetY = style.offsetY ?? 0;
  const sizeScale = style.sizeScale ?? 1;
  const isCircle = style.shape === 'circle';
  for (let i = first; i < first + count; i++) {
    const x = Math.fround((floats[i * 4] as number) * scaleX + offsetX);
    const y = Math.fround((floats[i * 4 + 1] as number) * scaleY + offsetY);
    const half = Math.fround((floats[i * 4 + 2] as number) * sizeScale * 0.5);
    if (!(y + half >= top) || !(y - half < bottom) || !(x + half >= left) || !(x - half < right) || !(half > 0)) {
      continue;
    }
    const firstRow = Math.max(Math.round(y - half), top);
    const lastRow = Math.min(Math.max(Math.round(y + half), firstRow + 1), bottom);
    const firstColumn = Math.max(Math.round(x - half), left);
    const lastColumn = Math.min(Math.max(Math.round(x + half), firstColumn + 1), right);
    const color = words[i * 4 + 3] as number;
    const alpha = color >>> 24;
    const red = Math.trunc(((color & 255) * alpha) / 255);
    const green = Math.trunc((((color >>> 8) & 255) * alpha) / 255);
    const blue = Math.trunc((((color >>> 16) & 255) * alpha) / 255);
    const rest = 255 - alpha;
    for (let row = firstRow; row < lastRow; row++) {
      for (let column = firstColumn; column < lastColumn; column++) {
        if (isCircle && half > 1.5) {
          const dx = column + 0.5 - x;
          const dy = row + 0.5 - y;
          if (dx * dx + dy * dy > half * half) {
            continue;
          }
        }
        const at = (row * width + column) * 4;
        pixels[at] = red + Math.trunc(((pixels[at] as number) * rest) / 255);
        pixels[at + 1] = green + Math.trunc(((pixels[at + 1] as number) * rest) / 255);
        pixels[at + 2] = blue + Math.trunc(((pixels[at + 2] as number) * rest) / 255);
        pixels[at + 3] = alpha + Math.trunc(((pixels[at + 3] as number) * rest) / 255);
      }
    }
  }
  unpremultiply(pixels);
}

function unpremultiply(pixels: Uint8ClampedArray): void {
  for (let at = 0; at < pixels.length; at += 4) {
    const alpha = pixels[at + 3] as number;
    if (alpha > 0 && alpha < 255) {
      pixels[at] = Math.round(((pixels[at] as number) * 255) / alpha);
      pixels[at + 1] = Math.round(((pixels[at + 1] as number) * 255) / alpha);
      pixels[at + 2] = Math.round(((pixels[at + 2] as number) * 255) / alpha);
    }
  }
}

// Fewer than the shader reads: this runs on the CPU for every pixel.
const maximumSamples = 2;

interface RasterSource {
  readonly values: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly rowShift: number;
}

function load(source: RasterSource, column: number, row: number): number {
  const y = (Math.min(Math.max(row, 0), source.height - 1) + source.rowShift) % source.height;
  return source.values[y * source.width + Math.min(Math.max(column, 0), source.width - 1)] as number;
}

function reduce(
  source: RasterSource,
  x: number,
  y: number,
  footprintX: number,
  footprintY: number,
  maximum: boolean,
): number {
  const samplesX = Math.min(Math.max(Math.ceil(footprintX), 1), maximumSamples);
  const samplesY = Math.min(Math.max(Math.ceil(footprintY), 1), maximumSamples);
  let sum = 0;
  let highest = Number.NEGATIVE_INFINITY;
  let found = 0;
  for (let j = 0; j < samplesY; j++) {
    const row = Math.floor(y - footprintY / 2 + ((j + 0.5) * footprintY) / samplesY);
    for (let i = 0; i < samplesX; i++) {
      const value = load(source, Math.floor(x - footprintX / 2 + ((i + 0.5) * footprintX) / samplesX), row);
      if (!Number.isNaN(value)) {
        sum += value;
        highest = Math.max(highest, value);
        found++;
      }
    }
  }
  if (found === 0) {
    return Number.NaN;
  }
  return maximum ? highest : Math.fround(sum / found);
}

// Bilinear between the four texels around; NaN carries through the sums, like a missing neighbor in the shader.
function blend(source: RasterSource, x: number, y: number): number {
  const column = Math.floor(x);
  const row = Math.floor(y);
  const partX = x - column;
  const partY = y - row;
  const a = load(source, column, row);
  const b = load(source, column + 1, row);
  const c = load(source, column, row + 1);
  const d = load(source, column + 1, row + 1);
  const low = a + (b - a) * partX;
  const high = c + (d - c) * partX;
  return low + (high - low) * partY;
}

/**
 * Colors the pixels `left`..`left + width` × `top`..`top + height` of a raster on `bounds`, as raster.wgsl does.
 * @param table - The colormap, RGBA bytes.
 */
export function paintRaster(
  source: { readonly values: Float32Array; readonly width: number; readonly height: number },
  table: Uint8Array,
  pixels: Uint8ClampedArray,
  area: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  bounds: PixelRect,
  style: RasterStyle,
): void {
  const raster: RasterSource = { ...source, rowShift: style.rowShift ?? 0 };
  const sectionX0 = style.sectionX ?? 0;
  const sectionY0 = style.sectionY ?? 0;
  const scaleX = (style.sectionWidth ?? 1) / bounds.width;
  const scaleY = (style.sectionHeight ?? 1) / bounds.height;
  const entries = table.length / 4;
  const last = entries - 1;
  const tableColor = (index: number): Rgba8 => ({
    r: table[index * 4] as number,
    g: table[index * 4 + 1] as number,
    b: table[index * 4 + 2] as number,
    a: table[index * 4 + 3] as number,
  });
  const below = style.belowColor ?? tableColor(0);
  const above = style.aboveColor ?? tableColor(last);
  const missing = style.missingColor ?? { r: 0, g: 0, b: 0, a: 0 };
  const logMinimum = Math.log(style.minimum);
  const logFactor = 1 / (Math.log(style.maximum) - logMinimum);
  const factor = 1 / (style.maximum - style.minimum);
  const footprintX = Math.abs(scaleX) * raster.width;
  const footprintY = Math.abs(scaleY) * raster.height;
  const reduction = style.reduction ?? 'nearest';
  for (let y = 0; y < area.height; y++) {
    const sectionY = sectionY0 + (area.top + y + 0.5 - bounds.y) * scaleY;
    const row = Math.min(Math.max(Math.floor(sectionY * raster.height), 0), raster.height - 1);
    const line = ((row + raster.rowShift) % raster.height) * raster.width;
    for (let x = 0; x < area.width; x++) {
      const sectionX = sectionX0 + (area.left + x + 0.5 - bounds.x) * scaleX;
      let value: number;
      if (style.isInterpolated === true) {
        value = blend(raster, sectionX * raster.width - 0.5, sectionY * raster.height - 0.5);
      } else if (reduction === 'nearest') {
        value = raster.values[
          line + Math.min(Math.max(Math.floor(sectionX * raster.width), 0), raster.width - 1)
        ] as number;
      } else {
        value = reduce(
          raster,
          sectionX * raster.width,
          sectionY * raster.height,
          footprintX,
          footprintY,
          reduction === 'maximum',
        );
      }
      let color: Rgba8 | undefined;
      let index = -1;
      if (Number.isNaN(value)) {
        color = missing;
      } else if (value < style.minimum || (style.isLogarithmic === true && value <= 0)) {
        color = below;
      } else if (value > style.maximum) {
        color = above;
      } else {
        const position =
          style.isLogarithmic === true ? (Math.log(value) - logMinimum) * logFactor : (value - style.minimum) * factor;
        index = Math.min(Math.max(Math.floor(position * last + 0.5), 0), last);
      }
      const at = (y * area.width + x) * 4;
      if (color) {
        pixels[at] = color.r;
        pixels[at + 1] = color.g;
        pixels[at + 2] = color.b;
        pixels[at + 3] = color.a;
      } else {
        pixels[at] = table[index * 4] as number;
        pixels[at + 1] = table[index * 4 + 1] as number;
        pixels[at + 2] = table[index * 4 + 2] as number;
        pixels[at + 3] = table[index * 4 + 3] as number;
      }
    }
  }
}

/** The fields of one glyph, as the 13 values of a glyph in the command list. */
interface Glyph {
  x: number;
  y: number;
  width: number;
  height: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  color: number;
  distanceScale: number;
  rotation: number;
  pivotX: number;
  pivotY: number;
}

function readGlyph(values: Float32Array, words: Uint32Array, base: number, index: number, into: Glyph): Glyph {
  const at = index * 13;
  into.x = values[at] as number;
  into.y = values[at + 1] as number;
  into.width = values[at + 2] as number;
  into.height = values[at + 3] as number;
  into.u0 = values[at + 4] as number;
  into.v0 = values[at + 5] as number;
  into.u1 = values[at + 6] as number;
  into.v1 = values[at + 7] as number;
  into.color = words[base + at + 8] as number;
  into.distanceScale = values[at + 9] as number;
  into.rotation = values[at + 10] as number;
  into.pivotX = values[at + 11] as number;
  into.pivotY = values[at + 12] as number;
  return into;
}

function extent(glyph: Glyph): [number, number, number, number] {
  if (glyph.rotation === 0) {
    return [glyph.x, glyph.y, glyph.x + glyph.width, glyph.y + glyph.height];
  }
  const cosine = Math.cos(glyph.rotation);
  const sine = Math.sin(glyph.rotation);
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 4; corner++) {
    const offsetX = glyph.x + glyph.width * (corner & 1) - glyph.pivotX;
    const offsetY = glyph.y + glyph.height * (corner >> 1) - glyph.pivotY;
    const x = glyph.pivotX + offsetX * cosine - offsetY * sine;
    const y = glyph.pivotY + offsetX * sine + offsetY * cosine;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

// Small text gets slightly stronger strokes, as in the shader.
function embolden(distanceScale: number): number {
  return Math.min(Math.max((16 - distanceScale * 5) / 8, 0), 1) * 0.15;
}

// Bilinear in each channel, like the sampler of the shader, then the median.
function sample(atlas: Uint8Array, size: number, u: number, v: number): number {
  const x = u * size - 0.5;
  const y = v * size - 0.5;
  const x0 = Math.min(Math.max(Math.floor(x), 0), size - 1);
  const y0 = Math.min(Math.max(Math.floor(y), 0), size - 1);
  const x1 = Math.min(x0 + 1, size - 1);
  const y1 = Math.min(y0 + 1, size - 1);
  const fx = Math.min(Math.max(x - x0, 0), 1);
  const fy = Math.min(Math.max(y - y0, 0), 1);
  const channel = (k: number): number => {
    const texel = (column: number, row: number): number => atlas[(row * size + column) * 4 + k] as number;
    const upper = texel(x0, y0) + (texel(x1, y0) - texel(x0, y0)) * fx;
    const lower = texel(x0, y1) + (texel(x1, y1) - texel(x0, y1)) * fx;
    return (upper + (lower - upper) * fy) / 255;
  };
  const [r, g, b] = [channel(0), channel(1), channel(2)];
  return Math.max(Math.min(r, g), Math.min(Math.max(r, g), b));
}

/** The pixels of glyphs: their place in the target and RGBA without premultiplied alpha. */
export interface GlyphImage {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Evaluates distance field glyphs with the formula of the text shader, into an image of the box they cover.
 * @returns The image, or undefined when no glyph is visible.
 */
export function rasterizeGlyphs(
  atlas: Uint8Array,
  atlasSize: number,
  glyphs: Float32Array,
  words: Uint32Array,
  count: number,
  target: { readonly width: number; readonly height: number },
): GlyphImage | undefined {
  const base = glyphs.byteOffset / 4;
  const glyph: Glyph = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    u0: 0,
    v0: 0,
    u1: 0,
    v1: 0,
    color: 0,
    distanceScale: 0,
    rotation: 0,
    pivotX: 0,
    pivotY: 0,
  };
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const [minX, minY, maxX, maxY] = extent(readGlyph(glyphs, words, base, i, glyph));
    left = Math.min(left, Math.max(Math.floor(minX), 0));
    top = Math.min(top, Math.max(Math.floor(minY), 0));
    right = Math.max(right, Math.min(Math.ceil(maxX), target.width));
    bottom = Math.max(bottom, Math.min(Math.ceil(maxY), target.height));
  }
  if (!(right > left) || !(bottom > top)) {
    return undefined;
  }
  const width = right - left;
  const height = bottom - top;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < count; i++) {
    drawGlyph(atlas, atlasSize, readGlyph(glyphs, words, base, i, glyph), pixels, left, top, width, height);
  }
  return { left, top, width, height, pixels };
}

function drawGlyph(
  atlas: Uint8Array,
  atlasSize: number,
  glyph: Glyph,
  pixels: Uint8ClampedArray,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  const [minX, minY, maxX, maxY] = extent(glyph);
  const firstX = Math.max(Math.floor(minX), left);
  const firstY = Math.max(Math.floor(minY), top);
  const lastX = Math.min(Math.ceil(maxX), left + width);
  const lastY = Math.min(Math.ceil(maxY), top + height);
  const cosine = Math.cos(glyph.rotation);
  const sine = Math.sin(glyph.rotation);
  const alpha = glyph.color >>> 24;
  const extra = embolden(glyph.distanceScale);
  for (let y = firstY; y < lastY; y++) {
    for (let x = firstX; x < lastX; x++) {
      // The pixel, turned back into the unrotated glyph.
      const pixelX = x + 0.5 - glyph.pivotX;
      const pixelY = y + 0.5 - glyph.pivotY;
      const localX = glyph.pivotX + pixelX * cosine + pixelY * sine;
      const localY = glyph.pivotY - pixelX * sine + pixelY * cosine;
      const u = (localX - glyph.x) / glyph.width;
      const v = (localY - glyph.y) / glyph.height;
      if (u < 0 || u > 1 || v < 0 || v > 1) {
        continue;
      }
      const distance = sample(
        atlas,
        atlasSize,
        glyph.u0 + (glyph.u1 - glyph.u0) * u,
        glyph.v0 + (glyph.v1 - glyph.v0) * v,
      );
      const coverage = Math.min(Math.max((distance - 0.5) * glyph.distanceScale + 0.5 + extra, 0), 1);
      const covered = Math.trunc(coverage * alpha + 0.5);
      const at = ((y - top) * width + (x - left)) * 4;
      if (covered > (pixels[at + 3] as number)) {
        pixels[at] = glyph.color & 255;
        pixels[at + 1] = (glyph.color >>> 8) & 255;
        pixels[at + 2] = (glyph.color >>> 16) & 255;
        pixels[at + 3] = covered;
      }
    }
  }
}

/**
 * Fills triangles with a color per corner, as Skia draws vertices: the pixels whose centers are inside, the colors
 * blended between the corners, without anti-aliasing; triangles that overlap blend over each other.
 * @param vertices - x, y and the packed color of each corner, three corners per triangle.
 * @returns The image of the box the triangles cover within `area`, or undefined when they cover nothing.
 */
export function rasterizeMesh(
  vertices: Float32Array,
  words: Uint32Array,
  count: number,
  area: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
): GlyphImage | undefined {
  const base = vertices.byteOffset / 4;
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const x = vertices[i * 3] as number;
    const y = vertices[i * 3 + 1] as number;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  const boxLeft = Math.max(Math.floor(left), area.left);
  const boxTop = Math.max(Math.floor(top), area.top);
  const boxRight = Math.min(Math.ceil(right), area.right);
  const boxBottom = Math.min(Math.ceil(bottom), area.bottom);
  if (!(boxRight > boxLeft) || !(boxBottom > boxTop)) {
    return undefined;
  }
  const width = boxRight - boxLeft;
  const height = boxBottom - boxTop;
  const premultiplied = new Float32Array(width * height * 4);
  for (let i = 0; i + 2 < count; i += 3) {
    fillTriangle(vertices, words, base, i, premultiplied, boxLeft, boxTop, width, height);
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < pixels.length; at += 4) {
    const alpha = premultiplied[at + 3] as number;
    if (alpha > 0) {
      pixels[at] = Math.round(((premultiplied[at] as number) / alpha) * 255);
      pixels[at + 1] = Math.round(((premultiplied[at + 1] as number) / alpha) * 255);
      pixels[at + 2] = Math.round(((premultiplied[at + 2] as number) / alpha) * 255);
      pixels[at + 3] = Math.round(alpha * 255);
    }
  }
  return { left: boxLeft, top: boxTop, width, height, pixels };
}

function channelOf(word: number, shift: number): number {
  return ((word >>> shift) & 255) / 255;
}

function fillTriangle(
  vertices: Float32Array,
  words: Uint32Array,
  base: number,
  first: number,
  into: Float32Array,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  const ax = vertices[first * 3] as number;
  const ay = vertices[first * 3 + 1] as number;
  const bx = vertices[first * 3 + 3] as number;
  const by = vertices[first * 3 + 4] as number;
  const cx = vertices[first * 3 + 6] as number;
  const cy = vertices[first * 3 + 7] as number;
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (!Number.isFinite(area) || area === 0) {
    return;
  }
  // Premultiplied colors of the corners: red, green, blue, alpha of each.
  const corner = (index: number): [number, number, number, number] => {
    const word = words[base + index * 3 + 2] as number;
    const alpha = channelOf(word, 24);
    return [channelOf(word, 0) * alpha, channelOf(word, 8) * alpha, channelOf(word, 16) * alpha, alpha];
  };
  const [ra, ga, ba, aa] = corner(first);
  const [rb, gb, bb, ab] = corner(first + 1);
  const [rc, gc, bc, ac] = corner(first + 2);
  const firstX = Math.max(Math.floor(Math.min(ax, bx, cx)), left);
  const lastX = Math.min(Math.ceil(Math.max(ax, bx, cx)), left + width);
  const firstY = Math.max(Math.floor(Math.min(ay, by, cy)), top);
  const lastY = Math.min(Math.ceil(Math.max(ay, by, cy)), top + height);
  for (let y = firstY; y < lastY; y++) {
    const py = y + 0.5;
    for (let x = firstX; x < lastX; x++) {
      const px = x + 0.5;
      // Barycentric weights; all of one sign inside, whichever way the triangle turns.
      const wa = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
      const wb = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
      const wc = 1 - wa - wb;
      if (wa < 0 || wb < 0 || wc < 0) {
        continue;
      }
      const at = ((y - top) * width + (x - left)) * 4;
      const alpha = wa * aa + wb * ab + wc * ac;
      const red = wa * ra + wb * rb + wc * rc;
      const green = wa * ga + wb * gb + wc * gc;
      const blue = wa * ba + wb * bb + wc * bc;
      const rest = 1 - alpha;
      into[at] = red + (into[at] as number) * rest;
      into[at + 1] = green + (into[at + 1] as number) * rest;
      into[at + 2] = blue + (into[at + 2] as number) * rest;
      into[at + 3] = alpha + (into[at + 3] as number) * rest;
    }
  }
}
