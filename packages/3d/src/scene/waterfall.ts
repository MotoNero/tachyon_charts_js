// The rows of a spectrogram one behind the other as a surface or as lines, the newest in front, as Waterfall3D of the
// .NET version.
import { Colormap, DoubleRange, type SpectrogramData, type SpectrumDisplay } from '@tachyon-charts/core';
import type { Material3D } from './surface';

/** Whether a waterfall shows a closed surface or a line per row. */
export type WaterfallStyle = 'surface' | 'lines';

/** The options of a waterfall. */
export interface Waterfall3DOptions {
  /** A surface or lines; a surface by default. */
  readonly style?: WaterfallStyle;
  /** The spectrum whose history the waterfall shows; its mask and markers then show in the box too. */
  readonly display?: SpectrumDisplay;
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
  /** The spectrum whose history the waterfall shows, if any. */
  readonly display: SpectrumDisplay | undefined;

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
    this.display = options.display;
  }

  /**
   * A waterfall of the history of a spectrum: its mask stands as a red fence across the depth, its markers as orange
   * frames numbered at the level of the newest trace, and the levels of the spectrum set the height of the box.
   * @param display - The spectrum.
   * @param depth - The range the rows cover along Y.
   * @param options - Style, colors and material.
   */
  static from(display: SpectrumDisplay, depth: DoubleRange, options: Waterfall3DOptions = {}): Waterfall3D {
    return new Waterfall3D(display.history, new DoubleRange(display.historyStart, display.historyStop), depth, {
      ...options,
      display,
    });
  }

  /** Grows with each new row and, for a spectrum, with each change of its mask, markers and levels. */
  get version(): number {
    return this.data.totalRows + (this.display?.version ?? 0);
  }
}
