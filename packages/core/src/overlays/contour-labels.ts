// The values of contour lines along the lines, as ContourLabels of the .NET version. The places come from a coarse
// marching squares pass over the values, made once per change of data or levels; each frame takes at most one place
// per level and tile of the screen, upright along the line, and leaves out labels that would touch one already placed.
// A plate in the color of the background hides the line under the text.
import { chartText } from '../locale/culture';
import { formatGeneral } from '../locale/format';
import type { ChartSeries } from '../pipeline/chart-series';
import { ContourSeries } from '../series/contour-series';
import type { ChartLayoutResult } from '../layout/chart-layout';
import type { Point } from '../input/primitives';
import type { OverlayCanvas } from './chart-overlay';

const mostCells = 96;
const tile = 240;
const mostLabels = 120;
const size = 11;
const sameLevelDistance = 200;
const f = Math.fround;

/** A place on a line: its level, the point in grid units and the direction of the line there. */
export interface ContourPlace {
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly directionX: number;
  readonly directionY: number;
}

interface Cache {
  version: number;
  levels: Float32Array | undefined;
  places: ContourPlace[];
  texts: Map<number, string>;
  language: number;
}

const caches = new WeakMap<ContourSeries, Cache>();

/** Whether a series of the chart writes the values of its lines. */
export function hasContourLabels(series: readonly ChartSeries[]): boolean {
  return series.some((item) => item instanceof ContourSeries && item.showsLabels);
}

/** Writes the labels of all contour series that ask for them. */
export function drawContourLabels(
  canvas: OverlayCanvas,
  layout: ChartLayoutResult,
  series: readonly ChartSeries[],
): void {
  for (const item of series) {
    if (item instanceof ContourSeries && item.showsLabels) {
      drawOne(canvas, layout, item);
    }
  }
}

/** The places on the lines: the middle of each crossing of a coarse cell, with its direction. */
export function findContourPlaces(series: ContourSeries): ContourPlace[] {
  const { width, height, values } = series.data;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / mostCells));
  const places: ContourPlace[] = [];
  const crossings: number[] = [];
  for (const level of series.currentLevels) {
    for (let row = 0; row + step < height; row += step) {
      for (let column = 0; column + step < width; column += step) {
        // The corners of the coarse cell, clockwise from the top left.
        const a = values[row * width + column] as number;
        const b = values[row * width + column + step] as number;
        const c = values[(row + step) * width + column + step] as number;
        const d = values[(row + step) * width + column] as number;
        if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) {
          continue;
        }
        crossings.length = 0;
        cross(a, b, level, column, row, column + step, row, crossings);
        cross(b, c, level, column + step, row, column + step, row + step, crossings);
        cross(c, d, level, column + step, row + step, column, row + step, crossings);
        cross(d, a, level, column, row + step, column, row, crossings);
        if (crossings.length === 4) {
          const [x0, y0, x1, y1] = crossings as [number, number, number, number];
          places.push({
            level,
            x: f(f(x0 + x1) / 2),
            y: f(f(y0 + y1) / 2),
            directionX: f(x1 - x0),
            directionY: f(y1 - y0),
          });
        }
      }
    }
  }
  return places;
}

/** Turns an angle so that text never stands on its head. */
export function upright(angle: number): number {
  let turned = angle;
  while (turned > Math.PI / 2) {
    turned = f(turned - Math.PI);
  }
  while (turned < -Math.PI / 2) {
    turned = f(turned + Math.PI);
  }
  return turned;
}

// At most two crossings of a cell are kept, as the four places of the .NET version hold two points.
function cross(
  from: number,
  to: number,
  level: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  crossings: number[],
): void {
  if (from < level === to < level || crossings.length >= 8) {
    return;
  }
  const share = f(f(level - from) / f(to - from));
  crossings.push(f(startX + f(f(endX - startX) * share)), f(startY + f(f(endY - startY) * share)));
}

function refresh(series: ContourSeries): Cache {
  let cache = caches.get(series);
  if (!cache) {
    cache = { version: -1, levels: undefined, places: [], texts: new Map(), language: -1 };
    caches.set(series, cache);
  }
  const levels = series.currentLevels;
  if (cache.version !== series.data.version || cache.levels !== levels) {
    cache.places = findContourPlaces(series);
    cache.version = series.data.version;
    cache.levels = levels;
  }
  if (cache.language !== chartText.version) {
    cache.texts.clear();
    cache.language = chartText.version;
  }
  return cache;
}

function textOf(cache: Cache, level: number): string {
  let text = cache.texts.get(level);
  if (text === undefined) {
    text = formatGeneral(level, 4, chartText.culture);
    cache.texts.set(level, text);
  }
  return text;
}

interface Placed {
  readonly center: Point;
  readonly radius: number;
  readonly level: number;
}

function drawOne(canvas: OverlayCanvas, layout: ChartLayoutResult, series: ContourSeries): void {
  const cache = refresh(series);
  const pane = layout.panes[0];
  if (!pane) {
    return;
  }
  const taken = new Set<string>();
  const placed: Placed[] = [];
  const line = canvas.lineHeight(size);
  for (const place of cache.places) {
    if (placed.length >= mostLabels) {
      break;
    }
    const [x, y] = series.gridPoint(place.x, place.y);
    const [x2, y2] = series.gridPoint(place.x + place.directionX, place.y + place.directionY);
    const start = canvas.pointOf(series.xAxis, series.yAxis, x, y);
    const end = canvas.pointOf(series.xAxis, series.yAxis, x2, y2);
    if (!start || !end) {
      continue;
    }
    const text = textOf(cache, place.level);
    const half = f(f(canvas.measureWidth(text, size) / 2) + 2);
    const center = { x: f(start.x), y: f(start.y) };
    if (
      center.x < pane.x + half ||
      center.x > pane.right - half ||
      center.y < pane.y + half ||
      center.y > pane.bottom - half
    ) {
      continue;
    }
    // One label per level and tile, and none that would touch another.
    const key = `${String(Math.floor(center.x / tile))} ${String(Math.floor(center.y / tile))} ${String(place.level)}`;
    if (touches(placed, center, half, place.level) || taken.has(key)) {
      continue;
    }
    taken.add(key);
    placed.push({ center, radius: half, level: place.level });
    const angle = upright(Math.fround(Math.atan2(f(end.y - start.y), f(end.x - start.x))));
    plate(canvas, center, angle, half, f(f(line / 2) + 1));
    canvas.drawTurnedText(text, center, angle, size, canvas.colors.text);
  }
}

// Labels never touch, and labels of the same line keep a wide distance.
function touches(placed: readonly Placed[], center: Point, radius: number, level: number): boolean {
  return placed.some((other) => {
    const distance = Math.hypot(other.center.x - center.x, other.center.y - center.y);
    return distance < radius + other.radius || (other.level === level && distance < sameLevelDistance);
  });
}

function plate(canvas: OverlayCanvas, center: Point, angle: number, halfWidth: number, halfHeight: number): void {
  const alongX = f(Math.cos(angle));
  const alongY = f(Math.sin(angle));
  const corner = (along: number, across: number): Point => ({
    x: f(f(center.x + f(alongX * along)) - f(alongY * across)),
    y: f(f(center.y + f(alongY * along)) + f(alongX * across)),
  });
  const a = corner(-halfWidth, -halfHeight);
  const b = corner(halfWidth, -halfHeight);
  const c = corner(halfWidth, halfHeight);
  const d = corner(-halfWidth, halfHeight);
  const color = { ...canvas.colors.background, a: 170 };
  canvas.fillTriangle(a, b, c, color);
  canvas.fillTriangle(a, c, d, color);
}
