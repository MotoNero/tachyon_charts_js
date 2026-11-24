// Legends: a box of the series with their colors and names in the plot or beside it, the series under the pointer
// highlighted, a click switching a series off and on, as LegendOverlay and LegendModifier of the .NET version.
import type { ChartInteraction } from '../input/chart-interaction';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import type { Point, PointerInputEvent } from '../input/primitives';
import { DipRect, type ReservedRoom } from '../layout/chart-layout';
import type { ChartSeries } from '../pipeline/chart-series';
import type { ChartSurface } from '../pipeline/chart-surface';
import { ChartOverlay, type OverlayCanvas } from './chart-overlay';

const margin = 8;
const padding = 6;
const swatchSize = 12;
const swatchGap = 6;
const itemGap = 16;

/** Where a legend stands: in a corner of the plot, or beside, above or below it, where it takes room. */
export type LegendPlacement =
  'topRight' | 'topLeft' | 'bottomRight' | 'bottomLeft' | 'right' | 'left' | 'top' | 'bottom';

/** A series in a legend and where its row is. */
export interface LegendRow {
  /** The series. */
  readonly series: ChartSeries;
  /** The row in device-independent units. */
  readonly bounds: DipRect;
}

interface ShownSeries {
  readonly series: ChartSeries;
  readonly index: number;
}

function nameOf(series: ChartSeries, index: number): string {
  return series.name !== undefined && series.name.length > 0 ? series.name : `Series ${String(index + 1)}`;
}

/** A legend of the series of a chart, all of them or those with the given names. */
export class LegendOverlay extends ChartOverlay {
  private rowList: LegendRow[] = [];
  private where: LegendPlacement = 'topRight';
  private heading: string | undefined;
  private names: readonly string[] | undefined;

  /** @param chart - The chart whose series the legend shows. */
  constructor(private readonly chart: ChartSurface) {
    super();
  }

  /** The rows of the last frame. */
  get rows(): readonly LegendRow[] {
    return this.rowList;
  }

  /** Where the legend stands; the top right corner of the plot by default. */
  get placement(): LegendPlacement {
    return this.where;
  }

  set placement(value: LegendPlacement) {
    this.where = value;
    this.layoutChanged();
  }

  /** A title above the rows, if any. */
  get title(): string | undefined {
    return this.heading;
  }

  set title(value: string | undefined) {
    this.heading = value;
    this.layoutChanged();
  }

  /** The names of the series the legend shows; all series when left out. */
  get seriesNames(): readonly string[] | undefined {
    return this.names;
  }

  set seriesNames(value: readonly string[] | undefined) {
    this.names = value ? [...value] : undefined;
    this.layoutChanged();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    let sum = super.version;
    for (const series of this.chart.series) {
      sum += series.stateVersion;
    }
    return sum;
  }

  /** Draws the legend anew, after a series changed. */
  refresh(): void {
    this.changed();
  }

  /** {@inheritDoc ChartOverlay.reservedRoom} */
  override reservedRoom(measurer: {
    readonly lineHeight: number;
    measureWidth(text: string): number;
  }): ReservedRoom | undefined {
    const where = this.where;
    if (where !== 'right' && where !== 'left' && where !== 'top' && where !== 'bottom') {
      return undefined;
    }
    const shown = this.shown();
    if (shown.length === 0) {
      return undefined;
    }
    const height = measurer.lineHeight + 4;
    if (where === 'top' || where === 'bottom') {
      const band = height + padding * 2 + (this.heading === undefined ? 0 : height) + margin;
      return where === 'top'
        ? { left: 0, top: band, right: 0, bottom: 0 }
        : { left: 0, top: 0, right: 0, bottom: band };
    }
    let width = 0;
    for (const item of shown) {
      width = Math.max(width, measurer.measureWidth(nameOf(item.series, item.index)));
    }
    width =
      Math.max(width + swatchSize + swatchGap, this.heading === undefined ? 0 : measurer.measureWidth(this.heading)) +
      padding * 2 +
      margin;
    return where === 'left'
      ? { left: width, top: 0, right: 0, bottom: 0 }
      : { left: 0, top: 0, right: width, bottom: 0 };
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const shown = this.shown();
    if (shown.length === 0) {
      this.rowList = [];
      return;
    }
    const size = canvas.labelSize;
    const rowHeight = canvas.lineHeight(size) + 4;
    const titleHeight = this.heading === undefined ? 0 : rowHeight;
    const isRow = this.where === 'top' || this.where === 'bottom';
    const widths = shown.map(
      (item) => canvas.measureWidth(nameOf(item.series, item.index), size) + swatchSize + swatchGap,
    );
    let textWidth = Math.max(...widths);
    let rowWidth = widths.reduce((sum, width, i) => sum + width + (i > 0 ? itemGap : 0), 0);
    if (this.heading !== undefined) {
      const titleWidth = canvas.measureWidth(this.heading, size);
      textWidth = Math.max(textWidth, titleWidth);
      rowWidth = Math.max(rowWidth, titleWidth);
    }
    const width = (isRow ? rowWidth : textWidth) + padding * 2;
    const height = titleHeight + (isRow ? rowHeight : rowHeight * shown.length) + padding * 2;
    const [left, top] = this.place(canvas, width, height);
    canvas.fillRectangle(new DipRect(left, top, width, height), { ...canvas.colors.background, a: 220 });
    if (this.heading !== undefined) {
      canvas.drawText(
        this.heading,
        left + padding,
        top + padding + rowHeight - rowHeight * 0.28,
        size,
        canvas.colors.text,
      );
    }
    const rows: LegendRow[] = [];
    let x = left + padding;
    shown.forEach((item, i) => {
      const itemWidth = widths[i] as number;
      const row = isRow
        ? new DipRect(x, top + padding + titleHeight, itemWidth, rowHeight)
        : new DipRect(left, top + padding + titleHeight + rowHeight * i, width, rowHeight);
      x += itemWidth + itemGap;
      rows.push({ series: item.series, bounds: row });
      drawRow(canvas, item.series, nameOf(item.series, item.index), row, isRow ? row.x : left + padding);
    });
    this.rowList = rows;
  }

  private layoutChanged(): void {
    this.chart.invalidateLayout();
    this.changed();
  }

  // The series this legend shows, with their number among all series for a default name.
  private shown(): ShownSeries[] {
    const names = this.names;
    const shown: ShownSeries[] = [];
    this.chart.series.forEach((series, index) => {
      if (!names || (series.name !== undefined && names.includes(series.name))) {
        shown.push({ series, index });
      }
    });
    return shown;
  }

  private place(canvas: OverlayCanvas, width: number, height: number): [number, number] {
    const plot = canvas.layout.plotArea;
    switch (this.where) {
      case 'topLeft':
        return [plot.x + margin, plot.y + margin];
      case 'bottomRight':
        return [plot.right - width - margin, plot.bottom - height - margin];
      case 'bottomLeft':
        return [plot.x + margin, plot.bottom - height - margin];
      case 'right':
        return [canvas.chartWidth - margin - width, plot.y];
      case 'left':
        return [margin, plot.y];
      case 'top':
        return [plot.x + (plot.width - width) / 2, topOfBand(canvas, height)];
      case 'bottom':
        return [plot.x + (plot.width - width) / 2, canvas.chartHeight - margin - height];
      default:
        return [plot.right - width - margin, plot.y + margin];
    }
  }
}

// Right above the plot and the labels of a top axis.
function topOfBand(canvas: OverlayCanvas, height: number): number {
  let top = canvas.layout.plotArea.y;
  for (const placement of canvas.layout.axes) {
    if (placement.axis.position === 'top' && !placement.axis.isHidden) {
      top = Math.min(top, placement.bounds.y);
    }
  }
  return top - height - margin / 2;
}

function drawRow(canvas: OverlayCanvas, item: ChartSeries, name: string, row: DipRect, start: number): void {
  if (item.isHighlighted) {
    canvas.fillRectangle(row, { ...canvas.colors.text, a: 40 });
  }
  const swatch = new DipRect(start, row.y + (row.height - swatchSize) / 2, swatchSize, swatchSize);
  if (item.isVisible) {
    canvas.fillRectangle(swatch, item.accentColor);
  } else {
    canvas.drawRectangle(swatch, item.accentColor);
  }
  const text = item.isVisible ? canvas.colors.text : { ...canvas.colors.text, a: 110 };
  canvas.drawText(name, swatch.right + swatchGap, row.y + row.height - row.height * 0.28, canvas.labelSize, text);
}

/**
 * Operates the legends of a chart: the pointer on a row highlights its series, a click switches it off and on. A chart
 * without a legend gets one in the top right corner of the plot.
 */
export class LegendModifier extends ChartModifier {
  /** The priority, above zooming, panning and the crosshair. */
  static readonly defaultPriority = 35;
  private added: LegendOverlay | undefined;
  private highlighted: ChartSeries | undefined;

  constructor() {
    super(LegendModifier.defaultPriority);
  }

  /** The legend this modifier added, if the chart had none. */
  get overlay(): LegendOverlay | undefined {
    return this.added;
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const interaction = this.interaction;
    if (!interaction) {
      return 'ignored';
    }
    const row = input.kind === 'exited' ? undefined : findRow(interaction.chart, input.position);
    if (input.kind === 'moved' || input.kind === 'exited') {
      this.highlight(interaction, row);
      return 'ignored';
    }
    if (input.kind === 'pressed' && input.changedButton === 'primary' && row) {
      interaction.run(() => {
        row.isVisible = !row.isVisible;
        refresh(interaction.chart);
      });
      return 'handled';
    }
    return 'ignored';
  }

  /** {@inheritDoc ChartModifier.onAttached} */
  protected override onAttached(interaction: ChartInteraction): void {
    if (interaction.chart.overlays.some((overlay) => overlay instanceof LegendOverlay)) {
      return;
    }
    const added = new LegendOverlay(interaction.chart);
    this.added = added;
    interaction.chart.addOverlay(added);
  }

  /** {@inheritDoc ChartModifier.onDetached} */
  protected override onDetached(interaction: ChartInteraction): void {
    if (this.added) {
      interaction.chart.removeOverlay(this.added);
      this.added = undefined;
    }
  }

  private highlight(interaction: ChartInteraction, series: ChartSeries | undefined): void {
    const previous = this.highlighted;
    if (previous === series) {
      return;
    }
    this.highlighted = series;
    interaction.run(() => {
      if (previous) {
        previous.isHighlighted = false;
      }
      if (series) {
        series.isHighlighted = true;
      }
      refresh(interaction.chart);
    });
  }
}

function findRow(chart: ChartSurface, position: Point): ChartSeries | undefined {
  for (const overlay of chart.overlays) {
    if (!(overlay instanceof LegendOverlay)) {
      continue;
    }
    for (const row of overlay.rows) {
      const bounds = row.bounds;
      if (
        position.x >= bounds.x &&
        position.x <= bounds.right &&
        position.y >= bounds.y &&
        position.y <= bounds.bottom
      ) {
        return row.series;
      }
    }
  }
  return undefined;
}

function refresh(chart: ChartSurface): void {
  for (const overlay of chart.overlays) {
    if (overlay instanceof LegendOverlay) {
      overlay.refresh();
    }
  }
}
