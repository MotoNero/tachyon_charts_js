// The tokens of a theme as the JSON files of the .NET version write them; without imports, so that the generated
// module of the built-in themes can name the type.

/** The background, the plot area and its border; colors are `#RRGGBB` or `#RRGGBBAA`. */
export interface SurfaceTokens {
  /** The color behind everything. */
  readonly background?: string;
  /** A color or `linear(top, bottom)`. */
  readonly plotArea?: string;
  /** The line around each pane. */
  readonly border?: string;
}

/** The grid lines and the bands between them. */
export interface GridTokens {
  /** The grid lines at the labeled ticks. */
  readonly major?: string;
  /** The grid lines at the ticks between. */
  readonly minor?: string;
  /** Every second space between labeled X ticks. */
  readonly band?: string;
}

/** The axes: their line, ticks, labels and titles. */
export interface AxisTokens {
  /** The line. */
  readonly line?: string;
  /** The tick marks. */
  readonly tick?: string;
  /** The labels. */
  readonly label?: string;
  /** The titles of the axes and of the chart. */
  readonly title?: string;
}

/** The text of a chart. */
export interface TextTokens {
  /** Families in order of preference, separated by commas; the first one the chart has is used. */
  readonly fontFamily?: string;
  /** The size of the labels; titles are 3 larger. */
  readonly size?: number;
}

/** The crosshair: its lines and the plates with the values at the axes. */
export interface CrosshairTokens {
  /** The line. */
  readonly line?: string;
  /** The plate behind a value at an axis. */
  readonly labelBackground?: string;
  /** The text on that plate. */
  readonly labelText?: string;
}

/** The glow of lines. */
export interface GlowTokens {
  /** Whether lines glow. */
  readonly enabled?: boolean;
  /** The reach of the glow in device-independent units. */
  readonly radius?: number;
  /** The strength of the glow, 0..1. */
  readonly intensity?: number;
}

/** Effects of the series. */
export interface EffectTokens {
  /** The glow of lines. */
  readonly glow?: GlowTokens;
  /** The opacity of the series, 0..1. */
  readonly seriesOpacity?: number;
}

/** The animation of changes. */
export interface AnimationTokens {
  /** The duration in milliseconds. */
  readonly durationMs?: number;
  /** The easing, such as `cubicOut`. */
  readonly easing?: string;
}

/**
 * A theme as the JSON files of the .NET version write it. Tokens left out are taken from the theme named in `base`, or
 * from the colors of a chart without a theme.
 */
export interface ThemeDocument {
  /** The name, such as "Tachyon Dark". */
  readonly name: string;
  /** The theme this one changes, such as `dark` or `light`. */
  readonly base?: string;
  /** The background, plot area and border. */
  readonly surface?: SurfaceTokens;
  /** The grid. */
  readonly grid?: GridTokens;
  /** The axes. */
  readonly axis?: AxisTokens;
  /** The text. */
  readonly text?: TextTokens;
  /** The colors of series that take them from the theme. */
  readonly palette?: readonly string[];
  /** The crosshair. */
  readonly crosshair?: CrosshairTokens;
  /** The effects of the series. */
  readonly effects?: EffectTokens;
  /** The name of the colormap of rasters. */
  readonly colormap?: string;
  /** The animation of changes. */
  readonly animation?: AnimationTokens;
}
