// The rows of a spectrogram one behind the other as a surface or as lines, the newest in front, as Waterfall3D of the
// .NET version.
import { Colormap, type DoubleRange, type SpectrogramData } from '@tachyon-charts/core';
import type { Material3D } from './surface';

/** Whether a waterfall shows a closed surface or a line per row. */
export type WaterfallStyle = 'surface' | 'lines';

/** The options of a waterfall. */
export interface Waterfall3DOptions {
  /** A surface or lines; a surface by default. */
  readonly style?: WaterfallStyle;
  /** Every how many rows a line runs, for lines; every eighth by default. */
  readonly lineSpacing?: number;
  /** The colors by height; Inferno by default. */
  readonly colormap?: Colormap;
  /** The heights the ends of the colormap stand for; the range of the upward axis by default. */
  readonly colorRange?: DoubleRange;
  /** How the surface takes the light. */
  readonly material?: Material3D;
}

/** The rows of a spectrogram one behind the other, the oldest at the back. */
export class Waterfall3D {
  /** A surface or lines. */
  readonly style: WaterfallStyle;
  /** Every how many rows a line runs, for lines. */
  readonly lineSpacing: number;
  /** The colors by height. */
  readonly colormap: Colormap;
  /** The heights the ends of the colormap stand for. */
  readonly colorRange: DoubleRange | undefined;
  /** How the surface takes the light. */
  readonly material: Material3D | undefined;

  /**
   * @param data - The rows; a new row moves the older ones back.
   * @param x - The range a row covers along X.
   * @param y - The range the rows cover along Y, the newest at its start.
   * @param options - Style, colors and material.
   */
  constructor(
    /** The rows. */
    readonly data: SpectrogramData,
    /** The range a row covers along X. */
    readonly x: DoubleRange,
    /** The range the rows cover along Y. */
    readonly y: DoubleRange,
    options: Waterfall3DOptions = {},
  ) {
    this.style = options.style ?? 'surface';
    this.lineSpacing = options.lineSpacing ?? 8;
    this.colormap = options.colormap ?? Colormap.builtIn('inferno');
    this.colorRange = options.colorRange;
    this.material = options.material;
  }

  /** Grows with each new row. */
  get version(): number {
    return this.data.totalRows;
  }
}
