// The grid of a ternary chart and the axes of parallel coordinates with their modifier, as TernaryGridOverlay,
// ParallelAxesOverlay and ParallelAxesModifier of the .NET version.
import { ZoomPanModifier } from '../input/navigation-modifiers';
import type { ChartBuilder } from '../fluent/chart-builder';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import type { PointerInputEvent } from '../input/primitives';
import { DipRect } from '../layout/chart-layout';
import { invariantCulture } from '../locale/culture';
import { formatFixed, formatWithPrefix } from '../locale/format';
import { roundHalfEven } from '../numerics/nice';
import { DoubleRange } from '../numerics/range';
import type { Rgba8 } from '../render/types';
import { ParallelCoordinatesSeries, TernaryProjection, TernarySeries } from '../series/scientific-series';
import { ChartOverlay, type OverlayCanvas } from './chart-overlay';

const f = Math.fround;
const divisions = 5;
const ternaryLabelSize = 12;
const parallelLabelSize = 11;
const headerHeight = 34;
const reach = 14;

/** The triangle of a ternary chart with lines every 20 % and the names of its corners. */
export class TernaryGridOverlay extends ChartOverlay {
  /**
   * @param labelA - The name of the top corner.
   * @param labelB - The name of the bottom left corner.
   * @param labelC - The name of the bottom right corner.
   */
  constructor(
    private readonly labelA: string,
    private readonly labelB: string,
    private readonly labelC: string,
  ) {
    super();
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const pane = canvas.layout.panes[0];
    if (!pane) {
      return;
    }
    const projection = TernaryProjection.fit(pane.x, pane.y, pane.width, pane.height);
    const text = canvas.colors.text;
    const line = { ...text, a: 60 };
    for (let i = 1; i < divisions; i++) {
      const share = i / divisions;
      const rest = 1 - share;
      canvas.drawLine(projection.toPoint(share, rest, 0), projection.toPoint(share, 0, rest), 1, line);
      canvas.drawLine(projection.toPoint(rest, share, 0), projection.toPoint(0, share, rest), 1, line);
      canvas.drawLine(projection.toPoint(rest, 0, share), projection.toPoint(0, rest, share), 1, line);
      const mark = projection.toPoint(share, 0, rest);
      canvas.drawText(
        formatFixed(share * 100, 0, invariantCulture),
        roundHalfEven(f(mark.x + 6)),
        roundHalfEven(f(mark.y + 4)),
        f(ternaryLabelSize * f(0.9)),
        text,
      );
    }
    const top = projection.toPoint(1, 0, 0);
    const left = projection.toPoint(0, 1, 0);
    const right = projection.toPoint(0, 0, 1);
    const edge = { ...text, a: 200 };
    canvas.drawLine(top, left, 1, edge);
    canvas.drawLine(left, right, 1, edge);
    canvas.drawLine(right, top, 1, edge);
    const centered = (label: string, x: number): number =>
      roundHalfEven(f(x - f(canvas.measureWidth(label, ternaryLabelSize) / 2)));
    const below = (y: number): number => roundHalfEven(f(y + ternaryLabelSize + 4));
    canvas.drawText(this.labelA, centered(this.labelA, top.x), roundHalfEven(f(top.y - 6)), ternaryLabelSize, text);
    canvas.drawText(this.labelB, centered(this.labelB, left.x), below(left.y), ternaryLabelSize, text);
    canvas.drawText(this.labelC, centered(this.labelC, right.x), below(right.y), ternaryLabelSize, text);
  }
}

/** One vertical axis per measure of parallel coordinates, with name, range and filter. */
export class ParallelAxesOverlay extends ChartOverlay {
  /**
   * @param series - The rows.
   * @param names - The names of the measures.
   */
  constructor(
    private readonly series: ParallelCoordinatesSeries,
    private readonly names: readonly string[],
  ) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.series.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const pane = canvas.layout.panes[0];
    if (!pane) {
      return;
    }
    const order = this.series.order;
    const width = pane.width / (order.length - 1);
    const line = { ...canvas.colors.text, a: 160 };
    order.forEach((column, place) => {
      const x = f(pane.x + place * width);
      canvas.drawLine({ x, y: f(pane.y) }, { x, y: f(pane.bottom) }, 1, line);
      const range = this.series.range(column);
      const filter = this.series.filter(column);
      if (filter) {
        const top = pane.y + ((range.max - filter.max) / (range.max - range.min)) * pane.height;
        const bottom = pane.y + ((range.max - filter.min) / (range.max - range.min)) * pane.height;
        canvas.fillRectangle(new DipRect(x - 4, top, 8, bottom - top), { ...canvas.colors.accent, a: 140 });
      }
      const label = (text: string, baseline: number): void => {
        const textWidth = canvas.measureWidth(text, parallelLabelSize);
        const at = Math.min(Math.max(x + 4, pane.x), pane.right - textWidth);
        canvas.drawText(text, roundHalfEven(at), roundHalfEven(baseline), parallelLabelSize, canvas.colors.text);
      };
      label(this.names[column] ?? '', pane.y + parallelLabelSize);
      label(formatWithPrefix(range.max, ''), pane.y + parallelLabelSize * 2.3);
      label(formatWithPrefix(range.min, ''), pane.bottom - 4);
    });
  }
}

/**
 * Operates parallel coordinates: dragging an axis at its name moves it, dragging along an axis keeps only the rows of
 * that range, a double click anywhere shows all rows again.
 */
export class ParallelAxesModifier extends ChartModifier {
  private place = -1;
  private isMoving = false;
  private startY = 0;

  constructor() {
    super(ZoomPanModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const chart = this.interaction?.chart;
    const pane = chart?.currentLayout?.panes[0];
    const series = chart?.series.find((s) => s instanceof ParallelCoordinatesSeries);
    if (!pane || !series) {
      return 'ignored';
    }
    const count = series.order.length;
    const width = pane.width / (count - 1);
    if (input.kind === 'pressed' && input.changedButton === 'primary') {
      // Anywhere in the plot: nobody hits a thin axis twice in a row.
      if (input.clickCount >= 2) {
        series.clearFilters();
        this.place = -1;
        return 'handled';
      }
      const place = roundHalfEven((input.position.x - pane.x) / width);
      if (place < 0 || place >= count || Math.abs(pane.x + place * width - input.position.x) > reach) {
        return 'ignored';
      }
      this.place = place;
      this.isMoving = input.position.y <= pane.y + headerHeight;
      this.startY = input.position.y;
      return 'capture';
    }
    if (this.place < 0) {
      return 'ignored';
    }
    if (input.kind === 'moved') {
      return 'handled';
    }
    if (input.kind === 'released') {
      if (this.isMoving) {
        const target = Math.min(Math.max(roundHalfEven((input.position.x - pane.x) / width), 0), count - 1);
        series.moveAxis(this.place, target);
      } else if (Math.abs(input.position.y - this.startY) > 2) {
        const column = series.order[this.place] as number;
        const range = series.range(column);
        const toValue = (y: number): number => range.max - ((y - pane.y) / pane.height) * (range.max - range.min);
        const first = toValue(this.startY);
        const second = toValue(input.position.y);
        series.setFilter(column, new DoubleRange(Math.min(first, second), Math.max(first, second)));
      }
      this.place = -1;
      return 'release';
    }
    return 'ignored';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.place = -1;
  }
}

/**
 * Describes a ternary diagram: hidden axes, the points of three shares and the triangle with the names of its corners.
 * @param builder - The description.
 * @param a - The shares of the top corner.
 * @param b - The shares of the left corner.
 * @param c - The shares of the right corner.
 * @param names - The names of the corners: top, left, right.
 */
export function ternary(
  builder: ChartBuilder,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  c: ArrayLike<number>,
  names: readonly [string, string, string] = ['A', 'B', 'C'],
): ChartBuilder {
  return builder
    .xAxis((axis) => axis.numeric('x').range(0, 1).hidden())
    .yAxis((axis) => axis.numeric('y').range(0, 1).hidden())
    .addSeries((x, y) => new TernarySeries(a, b, c, x, y), 'x', 'y')
    .addOverlay(() => new TernaryGridOverlay(names[0], names[1], names[2]));
}

/**
 * Describes parallel coordinates: an axis per measure with its name, the lines of all rows, and moving and filtering
 * the axes with the pointer.
 * @param builder - The description.
 * @param columns - The values of each measure.
 * @param names - The names of the measures.
 * @param color - The color of the lines, with little opacity so that many lines show where they gather.
 */
export function parallelCoordinates(
  builder: ChartBuilder,
  columns: readonly ArrayLike<number>[],
  names: readonly string[],
  color?: Rgba8,
): ChartBuilder {
  return builder
    .xAxis((axis) => axis.numeric('x').range(0, 1).hidden())
    .yAxis((axis) => axis.numeric('y').range(0, 1).hidden())
    .addSeries(
      (x, y) => {
        const series = new ParallelCoordinatesSeries(columns, x, y);
        if (color) {
          series.color = color;
        }
        return series;
      },
      'x',
      'y',
    )
    .addOverlay(
      (chart) =>
        new ParallelAxesOverlay(
          chart.series.find((series) => series instanceof ParallelCoordinatesSeries) as ParallelCoordinatesSeries,
          names,
        ),
    )
    .addModifier(() => new ParallelAxesModifier());
}
