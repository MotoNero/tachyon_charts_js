// Themes: named sets of design tokens in the JSON format of the .NET version (Theme, ThemeTokens, ThemeColor and
// BuiltInThemes of the .NET version). The built-in themes come from the same files as there.
import { builtInThemeDocuments } from '../generated/themes';
import { defaultSurfaceStyle, type ChartSurfaceStyle } from '../pipeline/chart-surface-style';
import { parseColor, type Rgba8 } from '../render/types';
import type { ThemeDocument } from './theme-document';

export type {
  AnimationTokens,
  AxisTokens,
  CrosshairTokens,
  EffectTokens,
  GlowTokens,
  GridTokens,
  SurfaceTokens,
  TextTokens,
  ThemeDocument,
} from './theme-document';

/** A gradient from the top of a pane to its bottom. */
export interface ThemeGradient {
  /** The color at the top. */
  readonly start: Rgba8;
  /** The color at the bottom. */
  readonly end: Rgba8;
}

/** Reads a color of a theme, `#RRGGBB` or `#RRGGBBAA`. @throws Error for another form. */
export function parseThemeColor(text: string): Rgba8 {
  return parseColor(text);
}

/** Reads a plot area of a theme: a color or `linear(start, end)`. @throws Error for another form. */
export function parseThemeGradient(text: string): ThemeGradient {
  if (text.startsWith('#')) {
    const color = parseColor(text);
    return { start: color, end: color };
  }
  const match = /^linear\(([^,]+),([^)]+)\)$/i.exec(text.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error(`"${text}" is no plot area of the form #RRGGBB or linear(start, end).`);
  }
  return { start: parseColor(match[1].trim()), end: parseColor(match[2].trim()) };
}

function merge<T extends object>(parent: T | undefined, value: T | undefined): T | undefined {
  return parent === undefined && value === undefined ? undefined : ({ ...parent, ...value } as T);
}

/** A theme with the tokens of another on top: the tokens the other sets win. */
export function withOverrides(theme: ThemeDocument, overrides: ThemeDocument): ThemeDocument {
  const glow = merge(theme.effects?.glow, overrides.effects?.glow);
  const effects = merge(theme.effects, overrides.effects);
  return clean({
    name: overrides.name.trim() === '' ? theme.name : overrides.name,
    surface: merge(theme.surface, overrides.surface),
    grid: merge(theme.grid, overrides.grid),
    axis: merge(theme.axis, overrides.axis),
    text: merge(theme.text, overrides.text),
    palette: overrides.palette ?? theme.palette,
    crosshair: merge(theme.crosshair, overrides.crosshair),
    effects: effects && { ...effects, glow },
    colormap: overrides.colormap ?? theme.colormap,
    animation: merge(theme.animation, overrides.animation),
  });
}

// Leaves out the tokens without a value, so that a merged theme has the shape of a document.
function clean(theme: Record<string, unknown>): ThemeDocument {
  return Object.fromEntries(
    Object.entries(theme).filter(([, value]) => value !== undefined),
  ) as unknown as ThemeDocument;
}

/** The built-in themes: Tachyon Dark and Light, High Contrast, Instrument, Neon, Paper and Signal. */
export const builtInThemes: readonly ThemeDocument[] = Object.values(builtInThemeDocuments);

/** A built-in theme by its name, `dark` and `light` included, ignoring case. */
export function findBuiltInTheme(name: string): ThemeDocument | undefined {
  const wanted = name.trim().toLowerCase();
  const aliases: Record<string, string> = { dark: 'tachyon-dark', light: 'tachyon-light' };
  const key = aliases[wanted] ?? wanted;
  return builtInThemeDocuments[key] ?? builtInThemes.find((theme) => theme.name.toLowerCase() === wanted);
}

/**
 * Resolves the chain of base themes into one theme, looking names up in `catalog` first and then among the built-in
 * themes.
 * @throws Error when a base is unknown or the chain runs in a circle.
 */
export function resolveTheme(
  theme: ThemeDocument,
  catalog: ReadonlyMap<string, ThemeDocument> = new Map(),
): ThemeDocument {
  const visiting = new Set<string>();
  const resolve = (current: ThemeDocument): ThemeDocument => {
    const base = current.base;
    const own: ThemeDocument = { ...current };
    delete (own as { base?: string }).base;
    if (base === undefined) {
      return own;
    }
    const key = base.toLowerCase();
    if (visiting.has(key)) {
      throw new Error(`Theme inheritance contains a cycle at '${base}'.`);
    }
    visiting.add(key);
    const parent = catalog.get(base) ?? findBuiltInTheme(base);
    if (!parent) {
      throw new Error(`Base theme '${base}' is unknown.`);
    }
    const resolved = withOverrides(resolve(parent), own);
    visiting.delete(key);
    return resolved;
  };
  return resolve(theme);
}

/** Reads a theme from the JSON of the .NET version. @throws Error when it is no theme or has an unknown token. */
export function parseTheme(json: string): ThemeDocument {
  const value: unknown = JSON.parse(json);
  if (typeof value !== 'object' || value === null || typeof (value as { name?: unknown }).name !== 'string') {
    throw new Error('A theme document needs a name.');
  }
  const known = new Set([
    'name',
    'base',
    'surface',
    'grid',
    'axis',
    'text',
    'palette',
    'crosshair',
    'effects',
    'colormap',
    'animation',
  ]);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`The theme has unknown tokens: ${unknown.join(', ')}.`);
  }
  return value as ThemeDocument;
}

/** The colors of the background and grid passes of a resolved theme. */
export function toSurfaceStyle(theme: ThemeDocument): ChartSurfaceStyle {
  const fallback = defaultSurfaceStyle;
  const color = (text: string | undefined, otherwise: Rgba8): Rgba8 => (text ? parseColor(text) : otherwise);
  const plot = theme.surface?.plotArea ? parseThemeGradient(theme.surface.plotArea) : undefined;
  return {
    ...fallback,
    backgroundColor: color(theme.surface?.background, fallback.backgroundColor),
    plotGradientStart: plot?.start ?? fallback.plotGradientStart,
    plotGradientEnd: plot?.end ?? fallback.plotGradientEnd,
    borderColor: color(theme.surface?.border, fallback.borderColor),
    majorGridColor: color(theme.grid?.major, fallback.majorGridColor),
    minorGridColor: color(theme.grid?.minor, fallback.minorGridColor),
    bandColor: color(theme.grid?.band, fallback.bandColor),
  };
}
