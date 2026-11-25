// A height field over a rectangle of the floor, colored by height, as Surface3D, Material3D and Contours3D of the
// .NET version.
import { Colormap, type Axis, type DoubleRange, type HeatmapData, type Rgba8 } from '@tachyon-charts/core';

/** How a surface takes the light. */
export interface Material3D {
  /** Whether light falls on the surface; true by default. */
  readonly isLit?: boolean;
  /** How much of the surface covers what lies behind, from 0 to 1; 1 by default. */
  readonly opacity?: number;
  /** The strength of the highlight; 0.18 by default. */
  readonly gloss?: number;
  /** How small the highlight is; 64 by default. */
  readonly sharpness?: number;
}

/** @internal A material with all its values. */
export interface FullMaterial {
  readonly isLit: boolean;
  readonly opacity: number;
  readonly gloss: number;
  readonly sharpness: number;
}

/** @internal The values of a material, with the defaults of the .NET version. */
export function fullMaterial(material: Material3D | undefined): FullMaterial {
  return {
    isLit: material?.isLit ?? true,
    opacity: material?.opacity ?? 1,
    gloss: material?.gloss ?? 0.18,
    sharpness: material?.sharpness ?? 64,
  };
}

/** Height lines of a surface: on the surface, pressed onto the floor and as cuts on the walls. */
export interface Contours3D {
  /** The heights of the lines, in units of the upward axis. */
  readonly levels: readonly number[];
  /** Their color; white, a little transparent, by default. */
  readonly color?: Rgba8;
  /** Their width in pixels; 1.25 by default. */
  readonly width?: number;
  /** Whether they also lie on the floor; true by default. */
  readonly onFloor?: boolean;
  /** Whether the walls show cuts through the surface; false by default. */
  readonly onWalls?: boolean;
}

/** @internal The distance of the cuts on the walls, in units of the box. */
export const wallDistance = 0.25;

/** Levels evenly spread inside a range, without its ends. */
export function evenContours(range: DoubleRange, count: number): Contours3D {
  const levels: number[] = [];
  const total = range.isEmpty ? 0 : Math.max(count, 0);
  for (let i = 0; i < total; i++) {
    levels.push(range.min + ((range.max - range.min) * (i + 1)) / (total + 1));
  }
  return { levels };
}

/** @internal The height of a missing value, which the shader leaves out. */
export const missingHeight = 1e30;

/** The options of a surface. */
export interface Surface3DOptions {
  /** The colors by height; Viridis by default. */
  readonly colormap?: Colormap;
  /** The heights the ends of the colormap stand for; the range of the values by default. */
  readonly colorRange?: DoubleRange;
  /** How the surface takes the light. */
  readonly material?: Material3D;
  /** Height lines. */
  readonly contours?: Contours3D;
}

/** A height field: one value per cell of a grid over a rectangle of the floor. */
export class Surface3D {
  /** The colors by height. */
  readonly colormap: Colormap;
  /** The heights the ends of the colormap stand for; the range of the values when left out. */
  readonly colorRange: DoubleRange | undefined;
  /** How the surface takes the light. */
  readonly material: Material3D | undefined;
  /** Height lines. */
  readonly contours: Contours3D | undefined;

  /**
   * @param data - The heights, one per cell; missing values leave a gap.
   * @param x - Where the columns lie along the X axis, the first at the start.
   * @param y - Where the rows lie along the Y axis, the first at the start.
   * @param options - Colors, material and height lines.
   */
  constructor(
    /** The heights. */
    readonly data: HeatmapData,
    /** Where the columns lie along the X axis. */
    readonly x: DoubleRange,
    /** Where the rows lie along the Y axis. */
    readonly y: DoubleRange,
    options: Surface3DOptions = {},
  ) {
    this.colormap = options.colormap ?? Colormap.builtIn('viridis');
    this.colorRange = options.colorRange;
    this.material = options.material;
    this.contours = options.contours;
  }

  /** Grows when the heights change. */
  get version(): number {
    return this.data.version;
  }

  /** @internal Writes the heights as places in the box, missing ones as a height far above the box. */
  writeHeights(axis: Axis, heights: Float32Array): void {
    const transform = axis.createTransform(-1, 2);
    const sign = axis.isHorizontal ? 1 : -1;
    const values = this.data.values;
    for (let i = 0; i < values.length; i++) {
      const value = values[i] as number;
      const place = sign * transform.toPixel(value);
      heights[i] = Number.isFinite(value) && Number.isFinite(place) ? place : missingHeight;
    }
  }
}
