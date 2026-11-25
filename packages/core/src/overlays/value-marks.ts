// The newest value of a series on a plate at its axis and the values of points and bars beside them, as LastValueMarks
// and ValueLabelMarks of the .NET version.
import type { DipRect, ChartLayoutResult } from '../layout/chart-layout';
import { DipRect as Rect } from '../layout/chart-layout';
import type { Point } from '../input/primitives';
import { chartText } from '../locale/culture';
import { formatFixed } from '../locale/format';
import type { ChartSeries } from '../pipeline/chart-series';
import type { ValueLabel } from '../pipeline/value-label';
import type { Rgba8 } from '../render/types';
import { spreadLabels } from '../layout/spread';
import type { OverlayCanvas } from './chart-overlay';

const lastValueSize = 11;
const platePadding = 4;
const labelPadding = 3;
const labelDistance = 4;
const f = Math.fround;

function contrastTo(color: Rgba8): Rgba8 {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b > 150
    ? { r: 20, g: 20, b: 20, a: 255 }
    : { r: 255, g: 255, b: 255, a: 255 };
}

// F0 to F6 by the span of the axis: about three significant digits of the visible range.
function digitsFor(span: number): number {
  return Math.min(Math.max(Math.ceil(-Math.log10(Math.max(span, 1e-12) / 1000)), 0), 6);
}

// "#,0.###": at most three decimals, thousands grouped, as the .NET version writes the values of points.
function formatValue(value: number): string {
  const culture = chartText.culture;
  const separator = culture.decimalSeparator;
  const group = separator === ',' ? '.' : ',';
  const fixed = formatFixed(value, 3, culture);
  const [whole = '', fraction = ''] = fixed.split(separator);
  const trimmed = fraction.replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return trimmed.length > 0 ? `${grouped}${separator}${trimmed}` : grouped;
}

/** @internal Whether a series shows its last value. */
export function hasLastValues(series: readonly ChartSeries[]): boolean {
  return series.some((item) => item.showsLastValue);
}

/** @internal Whether a series shows the values of its points. */
export function hasValueLabels(series: readonly ChartSeries[]): boolean {
  return series.some((item) => item.showsValues);
}

interface Entry {
  readonly y: number;
  readonly value: number;
  readonly color: Rgba8;
  readonly isRight: boolean;
  readonly span: number;
}

// The placement of the vertical axis of a series; a hidden axis puts the plate at the right edge of the plot.
function placeOf(layout: ChartLayoutResult, series: ChartSeries): { bounds: DipRect; isRight: boolean } | undefined {
  const placement = layout.axes.find((item) => item.axis === series.yAxis);
  if (placement) {
    return { bounds: placement.bounds, isRight: placement.bounds.x >= layout.plotArea.right - 1 };
  }
  const plot = layout.plotArea;
  return layout.panes.length > 0 ? { bounds: new Rect(plot.right, plot.y, 0, plot.height), isRight: true } : undefined;
}

/** @internal Draws a plate with the newest value of each series that asks for it, moved apart where they meet. */
export function drawLastValues(canvas: OverlayCanvas, layout: ChartLayoutResult, series: readonly ChartSeries[]): void {
  const entries: Entry[] = [];
  for (const item of series) {
    const value = item.showsLastValue ? item.latestValue() : undefined;
    const place = value === undefined ? undefined : placeOf(layout, item);
    if (value === undefined || !place) {
      continue;
    }
    // A Y axis lying along the bottom or top, with the X axis down, gets its plates under or over the plot.
    if (item.yAxis.isHorizontal) {
      drawAlong(canvas, layout, item, value);
      continue;
    }
    const transform = item.yAxis.createTransform(place.bounds.y, place.bounds.height);
    const y = transform.toPixel(value);
    if (!Number.isFinite(y)) {
      continue;
    }
    // A value outside the view sticks to the edge, so that it still shows where it lies.
    entries.push({
      y: Math.min(Math.max(y, place.bounds.y), place.bounds.bottom),
      value,
      color: item.accentColor,
      isRight: place.isRight,
      span: item.yAxis.visibleRange.length,
    });
  }
  if (entries.length === 0) {
    return;
  }
  // Sorted from the top, then spread apart within the plot area; a stable sort as the insertion sort of .NET.
  entries.sort((a, b) => a.y - b.y);
  const line = canvas.lineHeight(lastValueSize) + 2;
  const places = entries.map((entry) => entry.y);
  spreadLabels(places, layout.plotArea.y + line / 2, layout.plotArea.bottom - line / 2, line);
  entries.forEach((entry, i) => {
    drawPlate(canvas, layout, entry, f(places[i] as number), line);
  });
}

function drawPlate(canvas: OverlayCanvas, layout: ChartLayoutResult, entry: Entry, y: number, line: number): void {
  const text = formatFixed(entry.value, digitsFor(entry.span), chartText.culture);
  const width = canvas.measureWidth(text, lastValueSize) + platePadding * 2;
  const plot = layout.plotArea;
  const left = entry.isRight ? plot.right + 4 : plot.x - 4 - width;
  canvas.fillRectangle(new Rect(left, y - line / 2, width, line), entry.color);
  const tip = f(entry.isRight ? plot.right : plot.x);
  const edge = f(entry.isRight ? left : left + width);
  canvas.fillTriangle(
    { x: tip, y: f(entry.y) },
    { x: edge, y: f(y - line / 2) },
    { x: edge, y: f(y + line / 2) },
    entry.color,
  );
  canvas.drawText(text, left + platePadding, y + line * 0.3, lastValueSize, contrastTo(entry.color));
}

// A plate at the value on a Y axis that lies along the bottom or top, with its tip at the edge of the plot.
function drawAlong(canvas: OverlayCanvas, layout: ChartLayoutResult, series: ChartSeries, value: number): void {
  const position = canvas.positionOf(series.yAxis, value);
  if (position === undefined || !Number.isFinite(position)) {
    return;
  }
  const text = formatFixed(value, digitsFor(series.yAxis.visibleRange.length), chartText.culture);
  const plot = layout.plotArea;
  const x = Math.min(Math.max(position, plot.x), plot.right);
  const line = canvas.lineHeight(lastValueSize) + 2;
  const width = canvas.measureWidth(text, lastValueSize) + platePadding * 2;
  const isTop = series.yAxis.position === 'top';
  const top = isTop ? plot.y - 4 - line : plot.bottom + 4;
  const color = series.accentColor;
  canvas.fillRectangle(new Rect(x - width / 2, top, width, line), color);
  const tip = f(isTop ? plot.y : plot.bottom);
  const edge = f(isTop ? top + line : top);
  canvas.fillTriangle({ x: f(x), y: tip }, { x: f(x - 4), y: edge }, { x: f(x + 4), y: edge }, color);
  canvas.drawText(text, x - width / 2 + platePadding, top + line * 0.8, lastValueSize, contrastTo(color));
}

// The X axis may lie vertically, as with the X axis downwards; each axis then gives the other coordinate.
function placeLabel(canvas: OverlayCanvas, series: ChartSeries, label: ValueLabel): Point | undefined {
  const pane = canvas.layout.panes[0];
  const own = pane ? series.placeValueLabel(pane, label) : undefined;
  if (own) {
    return own;
  }
  const x = canvas.positionOf(series.xAxis, label.x);
  const y = canvas.positionOf(series.yAxis, label.y);
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  return series.xAxis.isHorizontal ? { x: f(x), y: f(y) } : { x: f(y), y: f(x) };
}

function covers(placed: readonly DipRect[], area: DipRect): boolean {
  return placed.some(
    (other) =>
      area.x < other.x + other.width &&
      other.x < area.x + area.width &&
      area.y < other.y + other.height &&
      other.y < area.y + area.height,
  );
}

/** @internal Writes the values of the points of each series that asks for it, leaving out labels that would overlap. */
export function drawValueLabels(
  canvas: OverlayCanvas,
  layout: ChartLayoutResult,
  series: readonly ChartSeries[],
): void {
  const placed: DipRect[] = [];
  const plot = layout.plotArea;
  const line = canvas.lineHeight(canvas.labelSize);
  const back = { ...canvas.colors.background, a: 190 };
  for (const item of series) {
    if (!item.showsValues) {
      continue;
    }
    const labels: ValueLabel[] = [];
    item.collectValueLabels(item.xAxis.visibleRange, item.yAxis.visibleRange, labels);
    for (const label of labels) {
      const point = placeLabel(canvas, item, label);
      if (!point || point.x < plot.x || point.x > plot.right || point.y < plot.y || point.y > plot.bottom) {
        continue;
      }
      const text = formatValue(label.value);
      const width = canvas.measureWidth(text, canvas.labelSize) + 2 * labelPadding;
      const height = line + labelPadding;
      let area: DipRect;
      if (label.place === 'center') {
        area = new Rect(point.x - width / 2, point.y - height / 2, width, height);
      } else if (label.place === 'right') {
        area = new Rect(point.x + labelDistance, point.y - height / 2, width, height);
      } else {
        area = new Rect(point.x - width / 2, point.y - labelDistance - height, width, height);
      }
      if (covers(placed, area)) {
        continue;
      }
      placed.push(area);
      canvas.fillRectangle(area, back);
      canvas.drawText(
        text,
        roundHalfEven(area.x + labelPadding),
        roundHalfEven(area.y + labelPadding / 2 + line * 0.8),
        canvas.labelSize,
        canvas.colors.text,
      );
    }
  }
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  return rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
}
