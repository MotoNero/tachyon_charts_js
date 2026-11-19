// Value types of the rendering interface. They know no DOM and no graphics API, so that core stays free of both.

/** A size in physical pixels. */
export interface PixelSize {
  /** The width. */
  readonly width: number;
  /** The height. */
  readonly height: number;
}

/** A rectangle in physical pixels, measured from the top left of the target. */
export interface PixelRect {
  /** The left edge. */
  readonly x: number;
  /** The top edge. */
  readonly y: number;
  /** The width. */
  readonly width: number;
  /** The height. */
  readonly height: number;
}

/** A color with four channels from 0 to 255; alpha 255 is opaque. */
export interface Rgba8 {
  /** Red, 0 to 255. */
  readonly r: number;
  /** Green, 0 to 255. */
  readonly g: number;
  /** Blue, 0 to 255. */
  readonly b: number;
  /** Opacity, 0 (none) to 255 (full). */
  readonly a: number;
}

/**
 * Creates a color. The channels are clamped to 0..255 and rounded.
 * @param r - Red, 0..255.
 * @param g - Green, 0..255.
 * @param b - Blue, 0..255.
 * @param a - Alpha, 0..255; opaque when left out.
 */
export function rgba(r: number, g: number, b: number, a = 255): Rgba8 {
  const channel = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));
  return { r: channel(r), g: channel(g), b: channel(b), a: channel(a) };
}

/**
 * Packs a color into the 32-bit word that marker, glyph and mesh buffers hold: red in the lowest byte. Write it
 * through a `Uint32Array` over the same memory as the floats.
 */
export function packRgba8(color: Rgba8): number {
  return (((color.a & 255) << 24) | ((color.b & 255) << 16) | ((color.g & 255) << 8) | (color.r & 255)) >>> 0;
}

const wordViews = new WeakMap<ArrayBufferLike, Uint32Array>();

/**
 * The memory of a float array as 32-bit words, to read and write packed colors. A color with full alpha has the
 * bits of a NaN, which JavaScript may change on the way through a number, so colors go through words only. The view
 * covers the whole buffer and is made once per buffer: index it with `array.byteOffset / 4 + i`.
 */
export function wordsOf(array: Float32Array): Uint32Array {
  let words = wordViews.get(array.buffer);
  if (!words) {
    words = new Uint32Array(array.buffer, 0, Math.floor(array.buffer.byteLength / 4));
    wordViews.set(array.buffer, words);
  }
  return words;
}

/**
 * Reads a color from text as the themes write it: `#RRGGBB`, or `#RRGGBBAA` with the opacity last.
 * @param text - The color.
 * @returns The color.
 * @throws Error when the text is no such color.
 */
export function parseColor(text: string): Rgba8 {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text.trim());
  if (!match?.[1]) {
    throw new Error(`"${text}" is no color of the form #RRGGBB or #RRGGBBAA.`);
  }
  const value = Number.parseInt(match[1], 16);
  const alpha = match[2] ? Number.parseInt(match[2], 16) : 255;
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255, a: alpha };
}

/** The ways a buffer can be used; combine them with `|`. */
export const BufferUsage = {
  /** The buffer provides vertex data, for example the points of a line. */
  vertex: 1,
  /** The buffer provides uniform data. */
  uniform: 2,
  /** The buffer provides storage data, for example for compute shaders. */
  storage: 4,
} as const;

/** The pixel format of a texture. */
export type TextureFormat =
  /** Four 8-bit normalized channels, for images. */
  | 'rgba8unorm'
  /** One 8-bit normalized channel, for glyph atlases. */
  | 'r8unorm'
  /** One 32-bit float channel, for heatmap values. */
  | 'r32float';

/** Describes a buffer to create. */
export interface BufferDesc {
  /** The size in bytes, a multiple of 4 and greater than 0. */
  readonly sizeInBytes: number;
  /** A combination of {@link BufferUsage} flags, at least one. */
  readonly usage: number;
}

/** Describes a texture to create. */
export interface TextureDesc {
  /** The size in texels. */
  readonly size: PixelSize;
  /** The format of a texel. */
  readonly format: TextureFormat;
}

/** What a device supports. */
export interface DeviceCapabilities {
  /** The backend and adapter, for diagnostics. */
  readonly backendName: string;
  /** Whether compute shaders are available. */
  readonly supportsCompute: boolean;
  /** The largest buffer in bytes. */
  readonly maxBufferSize: number;
  /** The largest width or height of a texture or render target. */
  readonly maxTextureDimension: number;
  /** The highest MSAA sample count; 1 means none. */
  readonly maxSampleCount: number;
}

/**
 * Where a surface target presents its frames. Core does not know the type: a backend accepts the surfaces it can
 * draw on, such as a canvas or an offscreen canvas in a worker, and refuses the others.
 */
export interface SurfaceHandle {
  /** The kind of surface. */
  readonly kind: 'canvas';
  /** An `HTMLCanvasElement` or `OffscreenCanvas`. */
  readonly canvas: unknown;
}
