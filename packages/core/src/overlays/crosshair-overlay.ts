// A crosshair with the values of the axes at it, a snapped point and the values of all series (CrosshairOverlay of the
// .NET version, without the line another chart of a group sets, which comes with the groups).
import type { Axis, AxisPosition } from '../axes/axis';
import type { HitResult } from '../hit-testing/hit-test';
import type { Point } from '../input/primitives';
import { DipRect, type AxisPlacement } from '../layout/chart-layout';
import { chartText } from '../locale/culture';
import type { ChartSeries } from '../pipeline/chart-series';
import type { Rgba8 } from '../render/types';
import { ChartOverlay, type OverlayCanvas } from './chart-overlay';

const f = Math.fround;
const markerSize = 4;
const swatch = 12;
const boxPadding = 6;
const boxOffset = 14;

interface AxisText {
  readonly axis: Axis;
  readonly value: number;
  readonly stamp: number;
  readonly text: string;
}

interface AxisLabel {
  readonly bounds: DipRect;
  readonly side: AxisPosition;
  readonly text: string;
}

/** Formats the Y value of a hit, as the axis of the series writes cursor values. */
export function formatHitY(hit: HitResult): string {
  return hit.series.yAxis.formatCursorValue(hit.y);
}

/** Places the value of an axis next to the axis line; where it would reach the title, it moves into the plot. */
function place(
  axis: Axis,
  bounds: DipRect,
  along: number,
  width: number,
  height: number,
  title: number,
): [number, number] {
  const room = axis.title === undefined || axis.isHidden ? 0 : title;
  switch (axis.position) {
    case 'bottom':
      return [along - width / 2, bounds.y + 2 + height <= bounds.bottom - room ? bounds.y + 2 : bounds.y - height - 2];
    case 'top':
      return [
        along - width / 2,
        bounds.bottom - height - 2 >= bounds.y + room ? bounds.bottom - height - 2 : bounds.bottom + 2,
      ];
    case 'left':
      return [
        bounds.right - width - 2 >= bounds.x + room ? bounds.right - width - 2 : bounds.right + 2,
        along - height / 2,
      ];
    default:
      return [bounds.x + 2 + width <= bounds.right - room ? bounds.x + 2 : bounds.x - width - 2, along - height / 2];
  }
}

/** A crosshair at a position, with the values of the axes there and, on request, of every series. */
export class CrosshairOverlay extends ChartOverlay {
  /** The series of the chart, to color the values of axes that share a side. */
  series: readonly ChartSeries[] = [];
  private position: Point | undefined;
  private snapped: HitResult | undefined;
  private values: readonly HitResult[] = [];
  private texts: string[] = [];
  private header: string | undefined;
  private readonly axisTexts: AxisText[] = [];
  private readonly axisLabels: AxisLabel[] = [];

  /** Where the cross is, `undefined` while hidden. */
  get at(): Point | undefined {
    return this.position;
  }

  /** The values of the series shown in the box. */
  get shownValues(): readonly HitResult[] {
    return this.values;
  }

  /**
   * Shows the cross at a position; on a snapped point, if there is one. `values` and `header` fill the box beside it.
   * The texts are formatted here, so that drawing a frame formats nothing.
   */
  show(position: Point, snapped?: HitResult, values: readonly HitResult[] = [], header?: string): void {
    this.texts = values.map((hit) => (hit.series.name ? `${hit.series.name}: ${formatHitY(hit)}` : formatHitY(hit)));
    this.values = [...values];
    this.header = header;
    this.position = position;
    this.snapped = snapped;
    this.changed();
  }

  /** Hides the cross. */
  hide(): void {
    if (this.position) {
      this.position = undefined;
      this.snapped = undefined;
      this.values = [];
      this.texts = [];
      this.header = undefined;
      this.changed();
    }
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    if (this.position) {
      this.drawCross(canvas, this.position);
    }
  }

  private center(canvas: OverlayCanvas, hit: HitResult, fallback: Point): Point {
    return canvas.pointOf(hit.series.xAxis, hit.series.yAxis, hit.x, hit.y) ?? fallback;
  }

  private drawCross(canvas: OverlayCanvas, position: Point): void {
    const center = this.snapped ? this.center(canvas, this.snapped, position) : position;
    const pane = canvas.paneAt(center);
    if (!pane) {
      return;
    }
    const color = canvas.colors.crosshair;
    canvas.clip = pane;
    canvas.drawLine({ x: center.x, y: f(pane.y) }, { x: center.x, y: f(pane.bottom) }, 1, color);
    canvas.drawLine({ x: f(pane.x), y: center.y }, { x: f(pane.right), y: center.y }, 1, color);
    canvas.clip = undefined;
    if (this.snapped) {
      canvas.fillRectangle(
        new DipRect(center.x - markerSize, center.y - markerSize, markerSize * 2, markerSize * 2),
        canvas.colors.accent,
      );
    }
    this.drawAxisLabels(canvas, center);
    if (this.values.length > 0) {
      this.drawValues(canvas, center, pane);
    }
  }

  // A point on each curve, then a box beside the cross that stays inside the pane.
  private drawValues(canvas: OverlayCanvas, center: Point, pane: DipRect): void {
    canvas.clip = pane;
    for (const hit of this.values) {
      const point = canvas.pointOf(hit.series.xAxis, hit.series.yAxis, hit.x, hit.y);
      if (point) {
        const dot = new DipRect(point.x - markerSize, point.y - markerSize, markerSize * 2, markerSize * 2);
        canvas.fillRectangle(dot, hit.series.accentColor);
        canvas.drawRectangle(dot, canvas.colors.background);
      }
    }
    canvas.clip = undefined;
    const size = canvas.labelSize;
    const line = f(canvas.lineHeight(size) + 2);
    let width = this.header === undefined ? 0 : canvas.measureWidth(this.header, size);
    for (const text of this.texts) {
      width = Math.max(width, f(f(canvas.measureWidth(text, size) + swatch) + boxPadding));
    }
    const rows = this.texts.length + (this.header === undefined ? 0 : 1);
    const boxWidth = f(width + boxPadding * 2);
    const boxHeight = f(f(rows * line) + boxPadding * 2);
    const x = center.x + boxOffset + boxWidth > pane.right ? center.x - boxOffset - boxWidth : center.x + boxOffset;
    const y = center.y + boxOffset + boxHeight > pane.bottom ? center.y - boxOffset - boxHeight : center.y + boxOffset;
    const box = new DipRect(Math.max(x, pane.x), Math.max(y, pane.y), boxWidth, boxHeight);
    const colors = canvas.colors;
    canvas.fillRectangle(box, { ...colors.background, a: 235 });
    canvas.drawRectangle(box, { ...colors.accent, a: 140 });
    let baseline = box.y + boxPadding + line * 0.78;
    if (this.header !== undefined) {
      canvas.drawText(this.header, box.x + boxPadding, baseline, size, colors.text);
      baseline += line;
    }
    this.texts.forEach((text, i) => {
      const series = (this.values[i] as HitResult).series;
      canvas.fillRectangle(
        new DipRect(box.x + boxPadding, baseline - line * 0.62, swatch - 4, swatch - 4),
        series.accentColor,
      );
      canvas.drawText(text, box.x + boxPadding + swatch + boxPadding, baseline, size, colors.text);
      baseline += line;
    });
  }

  // The text of each axis is kept while its value stays, so that a resting cross formats nothing per frame.
  private textOf(axis: Axis, value: number): string {
    const stamp = axis.version + chartText.version;
    const index = this.axisTexts.findIndex((entry) => entry.axis === axis);
    const kept = this.axisTexts[index];
    if (kept && Object.is(kept.value, value) && kept.stamp === stamp) {
      return kept.text;
    }
    const text = axis.formatCursorValue(value);
    const entry = { axis, value, stamp, text };
    if (index >= 0) {
      this.axisTexts[index] = entry;
    } else {
      this.axisTexts.push(entry);
    }
    return text;
  }

  /**
   * Draws the value of each axis at the cross. A value another axis on that side already shows is left out, a
   * different one moves beside the others, and with several axes on a side each takes the color of its curve.
   */
  private drawAxisLabels(canvas: OverlayCanvas, center: Point): void {
    this.axisLabels.length = 0;
    const placements = canvas.layout.axes;
    for (const placement of placements) {
      const axis = placement.axis;
      const along = axis.isHorizontal ? center.x : center.y;
      const curve = this.curveOf(axis);
      const value = canvas.valueAt(axis, along);
      if (!isAlong(placement, along) || (axis.isHidden && !curve) || value === undefined) {
        continue;
      }
      const text = this.textOf(axis, value);
      if (!this.axisLabels.some((label) => label.side === axis.position && label.text === text)) {
        this.drawAxisLabel(
          canvas,
          placement,
          along,
          text,
          curve && sharesSide(placements, placement) ? curve : undefined,
        );
      }
    }
  }

  private drawAxisLabel(
    canvas: OverlayCanvas,
    placement: AxisPlacement,
    along: number,
    text: string,
    curve: ChartSeries | undefined,
  ): void {
    const { axis, bounds } = placement;
    const size = canvas.labelSize;
    const width = canvas.measureWidth(text, size) + 8;
    const height = canvas.lineHeight(size) + 2;
    const [x, y] = place(axis, bounds, along, width, height, canvas.lineHeight(size) + 4);
    const label = this.free(new DipRect(x, y, width, height), axis.isHorizontal, bounds);
    this.axisLabels.push({ bounds: label, side: axis.position, text });
    const colors = canvas.colors;
    const [fill, ink]: [Rgba8, Rgba8] = curve
      ? [curve.accentColor, colors.background]
      : [colors.crosshairLabelFill, colors.crosshairLabelText];
    canvas.drawLabel(text, label.x, label.y, fill, ink);
  }

  // The first visible curve on an axis.
  private curveOf(axis: Axis): ChartSeries | undefined {
    return this.series.find((series) => series.isVisible && (series.yAxis === axis || series.xAxis === axis));
  }

  // Moves a label off the ones drawn before: below the others beside a standing axis, or above where it ends.
  private free(label: DipRect, isHorizontal: boolean, bounds: DipRect): DipRect {
    const step = label.height + 2;
    let direction = 1;
    let current = label;
    for (let tries = 0; tries < 16 && this.overlaps(current); tries++) {
      current = new DipRect(current.x, current.y + direction * step, current.width, current.height);
      if (!isHorizontal && direction > 0 && current.bottom > bounds.bottom) {
        direction = -1;
        current = label;
      }
    }
    return current;
  }

  private overlaps(label: DipRect): boolean {
    return this.axisLabels.some(
      ({ bounds: other }) =>
        label.x < other.right && other.x < label.right && label.y < other.bottom && other.y < label.bottom,
    );
  }
}

function sharesSide(placements: readonly AxisPlacement[], placement: AxisPlacement): boolean {
  return placements.some((other) => other.axis !== placement.axis && other.axis.position === placement.axis.position);
}

// Whether a position along an axis lies on the axis.
function isAlong(placement: AxisPlacement, along: number): boolean {
  const bounds = placement.bounds;
  return placement.axis.isHorizontal
    ? along >= bounds.x && along <= bounds.right
    : along >= bounds.y && along <= bounds.bottom;
}
