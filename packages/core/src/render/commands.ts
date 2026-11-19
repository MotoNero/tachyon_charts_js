// The drawing commands of one frame and the styles they take, as in the .NET version.
import type { GpuBuffer, GpuTexture } from './resources';
import type { PixelRect, Rgba8 } from './types';

/** The X value of a point that interrupts a line. Real coordinates stay far below it. */
export const lineGap = 1e30;

/** The appearance of a line and the transform from buffer values to pixels. */
export interface PolylineStyle {
  /** The width in physical pixels; below one pixel the line is drawn one pixel wide with less coverage. */
  readonly widthInPixels: number;
  /** The color. */
  readonly color: Rgba8;
  /** Factors from buffer values to pixels; 1, 1 when left out. */
  readonly scaleX?: number;
  /** The factor from buffer Y values to pixels; 1 when left out. */
  readonly scaleY?: number;
  /** The pixel position of the buffer value zero; 0, 0 when left out. */
  readonly offsetX?: number;
  /** The pixel position of the buffer Y value zero; 0 when left out. */
  readonly offsetY?: number;
  /** Nothing is drawn outside of it; the whole target when left out. */
  readonly clip?: PixelRect;
  /** The reach of a glow around the line in pixels; no glow when left out. */
  readonly glowRadius?: number;
  /** The strength of the glow, 0..1. */
  readonly glowIntensity?: number;
}

/** A marker shape. */
export type MarkerShape = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross' | 'plus';

/**
 * The floats of one marker in a vertex buffer: x, y, size in pixels, color as a packed RGBA8 word
 * (red in the lowest byte), so 16 bytes per marker.
 */
export const markerStride = 16;

/** The appearance of a batch of markers and the transform of their positions. */
export interface MarkerStyle {
  /** The shape of all markers of the batch. */
  readonly shape: MarkerShape;
  /** The width of the border; 0 for none. */
  readonly borderWidthInPixels: number;
  /** The color of the border. */
  readonly borderColor: Rgba8;
  /** The factor from buffer X values to pixels; 1 when left out. */
  readonly scaleX?: number;
  /** The factor from buffer Y values to pixels; 1 when left out. */
  readonly scaleY?: number;
  /** The pixel position of the buffer X value zero; 0 when left out. */
  readonly offsetX?: number;
  /** The pixel position of the buffer Y value zero; 0 when left out. */
  readonly offsetY?: number;
  /** Multiplies the size of every marker; 1 when left out. */
  readonly sizeScale?: number;
  /** Nothing is drawn outside of it; the whole target when left out. */
  readonly clip?: PixelRect;
}

/** What a pixel shows when several texels of a raster fall on it. */
export type RasterReduction = 'nearest' | 'mean' | 'maximum';

/** How a texture of values becomes colors. */
export interface RasterStyle {
  /** The value at the start of the colormap. */
  readonly minimum: number;
  /** The value at the end of the colormap. */
  readonly maximum: number;
  /** Whether the colormap runs over the logarithm of the values. */
  readonly isLogarithmic?: boolean;
  /** The color of NaN; transparent when left out. */
  readonly missingColor?: Rgba8;
  /** The color below the minimum; the first color of the colormap when left out. */
  readonly belowColor?: Rgba8;
  /** The color above the maximum; the last color of the colormap when left out. */
  readonly aboveColor?: Rgba8;
  /** The part of the texture to show, in texture coordinates 0..1; all of it when left out. */
  readonly sectionX?: number;
  /** The top row of the part of the raster to show. */
  readonly sectionY?: number;
  /** The width of that part in texels. */
  readonly sectionWidth?: number;
  /** The height of that part in texels. */
  readonly sectionHeight?: number;
  /** Whether values blend between texel centers. */
  readonly isInterpolated?: boolean;
  /** What a pixel shows when several texels fall on it. */
  readonly reduction?: RasterReduction;
  /** Rows the texture is shifted by, for a ring of rows such as a scrolling spectrogram. */
  readonly rowShift?: number;
}

/**
 * The floats of one glyph: x, y, width, height of the quad in pixels, u and v of its two corners in the atlas,
 * color as a packed RGBA8 word, distance scale, rotation in radians, pivot x and y. 13 values, 52 bytes.
 */
export const glyphStride = 13;

/**
 * The floats of one corner of a mesh: x, y in pixels and the color as a packed RGBA8 word. 3 values, 12 bytes.
 */
export const meshVertexStride = 3;

/**
 * Records the drawing of one frame. Coordinates are physical pixels from the top left of the target. The commands
 * take effect in order with {@link CommandList.submit}; disposing without submitting discards them. After submit,
 * recording throws.
 */
export interface CommandList {
  /** Fills the whole target, whatever was drawn before. */
  clear(color: Rgba8): void;
  /** Fills a rectangle; an empty or non-finite one draws nothing. */
  fillRectangle(bounds: PixelRect, color: Rgba8): void;
  /** Fills a rectangle with a linear gradient, top to bottom when vertical, else left to right. */
  fillLinearGradient(bounds: PixelRect, startColor: Rgba8, endColor: Rgba8, vertical: boolean): void;
  /** Fills a triangle; one with a non-finite corner draws nothing. */
  fillTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, color: Rgba8): void;
  /**
   * Fills triangles with a color per corner in one draw call.
   * @param vertices - {@link meshVertexStride} values per corner, three corners per triangle.
   * @param count - The number of corners.
   */
  fillMesh(vertices: Float32Array, count: number, clip?: PixelRect): void;
  /** Marks the area of a text label with a rectangle; stands in for text where none is drawn, as in tests. */
  drawTextPlaceholder(bounds: PixelRect, color: Rgba8): void;
  /**
   * Draws an anti-aliased line through consecutive points with round joins and caps. The GPU transforms the points,
   * so a buffer that stays the same can follow the axes. Segments touching a {@link lineGap} point are left out.
   * @param points - A vertex buffer of x, y float pairs.
   */
  drawPolyline(points: GpuBuffer, firstPoint: number, pointCount: number, style: PolylineStyle): void;
  /**
   * Draws markers in one draw call.
   * @param markers - A vertex buffer with {@link markerStride} bytes per marker.
   */
  drawMarkers(markers: GpuBuffer, firstMarker: number, markerCount: number, style: MarkerStyle): void;
  /**
   * Draws glyphs from a distance field atlas in one draw call.
   * @param glyphs - {@link glyphStride} values per glyph.
   */
  drawGlyphs(atlas: GpuTexture, glyphs: Float32Array, count: number): void;
  /** Draws a texture on a rectangle, nearest texel, blended by its alpha. */
  drawImage(image: GpuTexture, bounds: PixelRect): void;
  /** Draws a texture of values on a rectangle, colored by a colormap texture. */
  drawRaster(values: GpuTexture, colormap: GpuTexture, bounds: PixelRect, style: RasterStyle): void;
  /**
   * Turns everything drawn after it by a quarter turn clockwise: (x, y) lands at (sum − y, x); clip rectangles turn
   * with it. A chart whose X axis runs down draws its series this way. `undefined` ends the turn; a new frame starts
   * without it.
   */
  setQuarterTurn(sum: number | undefined): void;
  /** Ends the frame and hands it to the device; a surface target shows it. */
  submit(): void;
  /** Discards the frame if it was not submitted. */
  dispose(): void;
}
