// Themes from the page: CSS custom properties as a second source beside the JSON files, and light or dark after the
// preference of the system.
import { findBuiltInTheme, withOverrides, type ThemeDocument } from '@tachyon-charts/core';

/** The custom properties a chart reads and the token each one sets. */
export const cssThemeProperties = {
  '--tachyon-background': 'surface.background',
  '--tachyon-plot-area': 'surface.plotArea',
  '--tachyon-border': 'surface.border',
  '--tachyon-grid-major': 'grid.major',
  '--tachyon-grid-minor': 'grid.minor',
  '--tachyon-grid-band': 'grid.band',
  '--tachyon-axis-line': 'axis.line',
  '--tachyon-axis-tick': 'axis.tick',
  '--tachyon-axis-label': 'axis.label',
  '--tachyon-axis-title': 'axis.title',
  '--tachyon-font-family': 'text.fontFamily',
  '--tachyon-font-size': 'text.size',
  '--tachyon-palette': 'palette',
  '--tachyon-crosshair-line': 'crosshair.line',
  '--tachyon-crosshair-label-background': 'crosshair.labelBackground',
  '--tachyon-crosshair-label-text': 'crosshair.labelText',
} as const;

/** A CSS color of any form as `#RRGGBBAA`, read through the style of an element; `undefined` if it is no color. */
export function cssColorToHex(value: string, element: Element): string | undefined {
  const text = value.trim();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(text)) {
    return text.toUpperCase();
  }
  const probe = element.ownerDocument.createElement('span');
  probe.style.color = text;
  if (probe.style.color === '') {
    return undefined;
  }
  probe.style.display = 'none';
  element.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(computed);
  if (!match) {
    return undefined;
  }
  const alpha =
    match[4] === undefined ? 1 : match[4].endsWith('%') ? Number.parseFloat(match[4]) / 100 : Number(match[4]);
  const hex = (channel: number): string =>
    Math.round(Math.min(Math.max(channel, 0), 255))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${hex(Number(match[1]))}${hex(Number(match[2]))}${hex(Number(match[3]))}${hex(alpha * 255)}`;
}

function gradientOf(value: string, element: Element): string | undefined {
  const inner = /^linear\((.+),(.+)\)$/i.exec(value.trim());
  if (!inner?.[1] || !inner[2]) {
    return cssColorToHex(value, element);
  }
  const start = cssColorToHex(inner[1], element);
  const end = cssColorToHex(inner[2], element);
  return start && end ? `linear(${start}, ${end})` : undefined;
}

/**
 * The theme an element asks for with custom properties such as `--tachyon-background`, on top of a base theme. Colors
 * take any CSS form; `--tachyon-plot-area` also `linear(top, bottom)`, `--tachyon-palette` a list separated by spaces.
 * Properties left out keep the base.
 */
export function themeFromCss(element: Element, base: ThemeDocument = preferredTheme()): ThemeDocument {
  const style = getComputedStyle(element);
  const tokens: Record<string, unknown> = {};
  for (const [property, path] of Object.entries(cssThemeProperties)) {
    const raw = style.getPropertyValue(property).trim();
    if (raw === '') {
      continue;
    }
    let value: unknown;
    if (path === 'surface.plotArea') {
      value = gradientOf(raw, element);
    } else if (path === 'text.fontFamily') {
      value = raw;
    } else if (path === 'text.size') {
      const size = Number.parseFloat(raw);
      value = Number.isFinite(size) && size > 0 ? size : undefined;
    } else if (path === 'palette') {
      const colors = raw.split(/\s+/).map((color) => cssColorToHex(color, element));
      value = colors.every((color) => color !== undefined) ? colors : undefined;
    } else {
      value = cssColorToHex(raw, element);
    }
    if (value === undefined) {
      continue;
    }
    const [group, token] = path.split('.') as [string, string | undefined];
    if (token === undefined) {
      tokens[group] = value;
    } else {
      tokens[group] = { ...(tokens[group] as Record<string, unknown> | undefined), [token]: value };
    }
  }
  return withOverrides(base, { name: '', ...tokens });
}

const darkQuery = '(prefers-color-scheme: dark)';

/** The built-in light or dark theme after the preference of the system; dark when the page cannot tell. */
export function preferredTheme(): ThemeDocument {
  const light = typeof matchMedia === 'function' && !matchMedia(darkQuery).matches;
  return findBuiltInTheme(light ? 'light' : 'dark') as ThemeDocument;
}

/**
 * Calls the listener with the preferred theme now and whenever the system switches between light and dark.
 * @returns A function that stops listening.
 */
export function watchPreferredTheme(listener: (theme: ThemeDocument) => void): () => void {
  listener(preferredTheme());
  if (typeof matchMedia !== 'function') {
    return () => undefined;
  }
  const query = matchMedia(darkQuery);
  const changed = (): void => {
    listener(preferredTheme());
  };
  query.addEventListener('change', changed);
  return () => {
    query.removeEventListener('change', changed);
  };
}
