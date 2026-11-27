// Spheres at points in space, as large as a value each, as Bubbles3D of the .NET version.
import type { Rgba8 } from '@tachyon-charts/core';
import { fallbackColor } from './points';
import type { Material3D } from './surface';

/** Whether the diameter of a bubble is in units of the X axis or in pixels. */
export type BubbleSizeUnit = 'data' | 'screen';

/** The options of bubbles. */
export interface Bubbles3DOptions {
  /** Whether the values show as labels above their points; labels that would cover others are left out. */
  readonly showsValues?: boolean;
  /** Whether the diameters are in units of the X axis or in pixels; in units of the X axis by default. */
  readonly sizeUnit?: BubbleSizeUnit;
  /** The color of all bubbles; the next color of the theme when left out. */
  readonly color?: Rgba8;
  /** A color for each bubble. */
  readonly colors?: readonly Rgba8[];
  /** A value for each bubble, for its label. */
  readonly values?: readonly number[];
  /** How the bubbles take the light; a little glossy by default. */
  readonly material?: Material3D;
}

/** Spheres at points in space, each with its diameter. */
export class Bubbles3D {
  /** Whether the values show as labels above their points. */
  readonly showsValues: boolean;
  /** Whether the diameters are in units of the X axis or in pixels. */
  readonly sizeUnit: BubbleSizeUnit;
  /** A color for each bubble. */
  readonly colors: readonly Rgba8[] | undefined;
  /** A value for each bubble. */
  readonly values: readonly number[] | undefined;
  /** How the bubbles take the light. */
  readonly material: Material3D;
  private readonly own: Rgba8 | undefined;

  /**
   * @param x - The X values.
   * @param y - The Y values.
   * @param z - The Z values.
   * @param diameters - The diameters; a bubble without a positive diameter is left out.
   * @param options - Unit, colors, values and material.
   * @throws RangeError for lists of different lengths.
   */
  constructor(
    /** The X values. */
    readonly x: readonly number[],
    /** The Y values. */
    readonly y: readonly number[],
    /** The Z values. */
    readonly z: readonly number[],
    /** The diameters. */
    readonly diameters: readonly number[],
    options: Bubbles3DOptions = {},
  ) {
    if (y.length !== x.length || z.length !== x.length || diameters.length !== x.length) {
      throw new RangeError(
        `The lists hold ${String(x.length)}, ${String(y.length)}, ${String(z.length)} and ${String(diameters.length)} entries, they need the same number.`,
      );
    }
    if (options.colors && options.colors.length !== x.length) {
      throw new RangeError(`There are ${String(options.colors.length)} colors for ${String(x.length)} bubbles.`);
    }
    if (options.values && options.values.length !== x.length) {
      throw new RangeError(`There are ${String(options.values.length)} values for ${String(x.length)} bubbles.`);
    }
    this.sizeUnit = options.sizeUnit ?? 'data';
    this.own = options.color;
    this.colors = options.colors;
    this.values = options.values;
    this.material = options.material ?? { gloss: 0.35, sharpness: 40 };
    this.showsValues = options.showsValues ?? false;
  }

  /** The number of bubbles. */
  get count(): number {
    return this.x.length;
  }

  /** The color of all bubbles, or the fallback. */
  get color(): Rgba8 {
    return this.own ?? fallbackColor;
  }

  /** @internal Whether the bubbles have a color of their own. */
  get hasOwnColor(): boolean {
    return this.own !== undefined;
  }

  /** The bubbles do not change. */
  readonly version = 0;

  /**
   * Diameters whose volumes grow with the values: the largest value gets `largest`, none less than `smallest`, a
   * value that is not positive none.
   */
  static scaleToVolume(values: readonly number[], smallest: number, largest: number): number[] {
    let most = 0;
    for (const value of values) {
      if (Number.isFinite(value) && value > most) {
        most = value;
      }
    }
    return values.map((value) =>
      Number.isFinite(value) && value > 0 ? Math.max(smallest, largest * Math.cbrt(value / most)) : Number.NaN,
    );
  }
}
