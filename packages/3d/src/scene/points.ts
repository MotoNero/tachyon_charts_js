// Points in space kept in a ring, and the lines and scatters that show them, as Points3D, Line3D and Scatter3D of the
// .NET version; finding points with the pointer comes with its part.
import type { Axis, Rgba8 } from '@tachyon-charts/core';
import { Point3D } from './matrix';

const opaqueCode = 255;
const sizeStep = 0.25;

/** @internal A size in pixels as the alpha byte the scatter shader reads: steps of a quarter pixel. */
export function toSizeCode(size: number): number {
  return Math.min(Math.max(Math.round(size / sizeStep), 1), opaqueCode - 1);
}

/** A ring of points with colors: once full, each new point takes the place of the oldest. */
export class Points3D {
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly zs: Float64Array;
  private readonly colors: Uint32Array;
  private written = 0;

  /**
   * @param capacity - The number of points the ring keeps, at least 1.
   * @throws RangeError for a capacity below 1.
   */
  constructor(
    /** The number of points the ring keeps. */
    readonly capacity: number,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`A ring needs room for at least one point, not ${String(capacity)}.`);
    }
    this.xs = new Float64Array(capacity);
    this.ys = new Float64Array(capacity);
    this.zs = new Float64Array(capacity);
    this.colors = new Uint32Array(capacity);
  }

  /**
   * Points from lists of the same length, with a color each if given.
   * @throws RangeError for lists of different lengths.
   */
  static from(x: readonly number[], y: readonly number[], z: readonly number[], colors?: readonly Rgba8[]): Points3D {
    if (x.length !== y.length || x.length !== z.length || (colors && colors.length !== x.length)) {
      throw new RangeError('All lists need the same length.');
    }
    const points = new Points3D(Math.max(x.length, 1));
    x.forEach((value, i) => {
      points.append(value, y[i] as number, z[i] as number, colors?.[i]);
    });
    return points;
  }

  /** The number of points ever appended; grows with each one. */
  get total(): number {
    return this.written;
  }

  /** The number of points the ring holds. */
  get count(): number {
    return Math.min(this.written, this.capacity);
  }

  /**
   * Appends a point; without a color it takes the color of its line or scatter. A size in pixels makes the color
   * opaque and sets the size of the point in a scatter.
   */
  append(x: number, y: number, z: number, color?: Rgba8, size?: number): void {
    const slot = this.written % this.capacity;
    this.xs[slot] = x;
    this.ys[slot] = y;
    this.zs[slot] = z;
    const alpha = size === undefined ? (color?.a ?? 0) : toSizeCode(size);
    this.colors[slot] = color ? (color.r | (color.g << 8) | (color.b << 16) | (alpha << 24)) >>> 0 : 0;
    this.written++;
  }

  /** Appends a gap: the line breaks here. */
  appendGap(): void {
    this.append(Number.NaN, Number.NaN, Number.NaN);
  }

  /** @internal A point by its place among the held points, the oldest first. */
  read(index: number): Point3D {
    const slot = (Math.max(this.written - this.capacity, 0) + index) % this.capacity;
    return new Point3D(this.xs[slot] as number, this.ys[slot] as number, this.zs[slot] as number);
  }

  /**
   * @internal Writes points from a running number on as places in the box and colors: 16 bytes each, as the shaders
   * read them; a missing or foreign color takes the fallback, and an opaque one the size code.
   */
  copyTo(
    first: number,
    floats: Float32Array,
    words: Uint32Array,
    count: number,
    map: BoxMap,
    fallback: Rgba8,
    size: number,
  ): void {
    const fallbackCode = (fallback.r | (fallback.g << 8) | (fallback.b << 16) | (fallback.a << 24)) >>> 0;
    for (let i = 0; i < count; i++) {
      const slot = (first + i) % this.capacity;
      let color = this.colors[slot] as number;
      if (color >>> 24 === 0) {
        color = fallbackCode;
      }
      if (color >>> 24 === opaqueCode) {
        color = ((color & 0xffffff) | (size << 24)) >>> 0;
      }
      map.write(this.xs[slot] as number, this.ys[slot] as number, this.zs[slot] as number, floats, i * 4);
      words[i * 4 + 3] = color;
    }
  }
}

/** @internal The place far outside that stands for a gap, as the shaders know it. */
export const gapPlace = 1e30;

/** Maps values of the three axes of a scene into the box from -1 to 1. */
export class BoxMap {
  private readonly x;
  private readonly y;
  private readonly z;
  private readonly signs: [number, number, number];

  /**
   * @param xAxis - The axis from left to right.
   * @param yAxis - The axis from front to back.
   * @param zAxis - The upward axis.
   */
  constructor(xAxis: Axis, yAxis: Axis, zAxis: Axis) {
    this.x = xAxis.createTransform(-1, 2);
    this.y = yAxis.createTransform(-1, 2);
    this.z = zAxis.createTransform(-1, 2);
    this.signs = [xAxis.isHorizontal ? 1 : -1, yAxis.isHorizontal ? 1 : -1, zAxis.isHorizontal ? 1 : -1];
  }

  /** A point of the data as a place in the box. */
  toBox(point: Point3D): Point3D {
    return new Point3D(
      this.signs[0] * this.x.toPixel(point.x),
      this.signs[1] * this.y.toPixel(point.y),
      this.signs[2] * this.z.toPixel(point.z),
    );
  }

  /** Writes a point as three floats in the box; a point that is not finite there becomes the gap. */
  write(x: number, y: number, z: number, into: Float32Array, at: number): void {
    const px = Math.fround(this.signs[0] * this.x.toPixel(x));
    const py = Math.fround(this.signs[1] * this.y.toPixel(y));
    const pz = Math.fround(this.signs[2] * this.z.toPixel(z));
    if (Number.isFinite(px + py + pz)) {
      into[at] = px;
      into[at + 1] = py;
      into[at + 2] = pz;
    } else {
      into[at] = gapPlace;
      into[at + 1] = 0;
      into[at + 2] = 0;
    }
  }
}

/** The fallback color of elements without a color of their own and without a theme palette. */
export const fallbackColor: Rgba8 = { r: 90, g: 170, b: 255, a: 255 };

/** The options of a line in space. */
export interface Line3DOptions {
  /** Whether the values show as labels above their points; labels that would cover others are left out. */
  readonly showsValues?: boolean;
  /** The color; the next color of the theme when left out. */
  readonly color?: Rgba8;
  /** The width in pixels; 1.5 by default. */
  readonly width?: number;
  /** Whether the line lies over everything else; false by default. */
  readonly drawsOnTop?: boolean;
}

/** A line through points in space, as wide on the screen wherever it runs. */
export class Line3D {
  /** Whether the values show as labels above their points. */
  readonly showsValues: boolean;
  /** The width in pixels. */
  readonly width: number;
  /** Whether the line lies over everything else. */
  readonly drawsOnTop: boolean;
  private readonly own: Rgba8 | undefined;

  /**
   * @param points - The points; a gap breaks the line.
   * @param options - Color, width and whether it lies on top.
   */
  constructor(
    /** The points. */
    readonly points: Points3D,
    options: Line3DOptions = {},
  ) {
    this.own = options.color;
    this.width = options.width ?? 1.5;
    this.drawsOnTop = options.drawsOnTop ?? false;
    this.showsValues = options.showsValues ?? false;
  }

  /** The color of its own, or the fallback. */
  get color(): Rgba8 {
    return this.own ?? fallbackColor;
  }

  /** @internal Whether the line has a color of its own. */
  get hasOwnColor(): boolean {
    return this.own !== undefined;
  }

  /** Grows with each appended point. */
  get version(): number {
    return this.points.total;
  }
}

/** The options of points in space. */
export interface Scatter3DOptions {
  /** Whether the values show as labels above their points; labels that would cover others are left out. */
  readonly showsValues?: boolean;
  /** The color of points without one of their own; the next color of the theme when left out. */
  readonly color?: Rgba8;
  /** The size of points without one of their own, in pixels; 3 by default. */
  readonly size?: number;
  /** The most points drawn, the newest; 15 million by default. */
  readonly pointBudget?: number;
}

/** Points in space, each a round spot of its size and color. */
export class Scatter3D {
  /** Whether the values show as labels above their points. */
  readonly showsValues: boolean;
  /** The size of points without one of their own, in pixels. */
  readonly size: number;
  /** The most points drawn, the newest. */
  readonly pointBudget: number;
  private readonly own: Rgba8 | undefined;

  /**
   * @param points - The points.
   * @param options - Color, size and budget.
   */
  constructor(
    /** The points. */
    readonly points: Points3D,
    options: Scatter3DOptions = {},
  ) {
    this.own = options.color;
    this.size = options.size ?? 3;
    this.pointBudget = options.pointBudget ?? 15_000_000;
    this.showsValues = options.showsValues ?? false;
  }

  /** The color of its own, or the fallback. */
  get color(): Rgba8 {
    return this.own ?? fallbackColor;
  }

  /** @internal Whether the scatter has a color of its own. */
  get hasOwnColor(): boolean {
    return this.own !== undefined;
  }

  /** Grows with each appended point. */
  get version(): number {
    return this.points.total;
  }
}
