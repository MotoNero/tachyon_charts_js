// Arranges titles, axes and panes in the size of a chart (ChartLayout of the .NET version).
import type { Axis, TextMeasurer } from '../axes/axis';
import type { PixelRect } from '../render/types';

/** A rectangle in device-independent units. */
export class DipRect {
  /** The empty rectangle at the origin. */
  static readonly empty = new DipRect(0, 0, 0, 0);

  constructor(
    /** The left edge. */
    readonly x: number,
    /** The top edge. */
    readonly y: number,
    /** The width. */
    readonly width: number,
    /** The height. */
    readonly height: number,
  ) {}

  /** The right edge. */
  get right(): number {
    return this.x + this.width;
  }

  /** The bottom edge. */
  get bottom(): number {
    return this.y + this.height;
  }

  /** The rectangle in physical pixels, with the edges on whole pixels so that neighbors share them. */
  toPixels(dpiScale: number): PixelRect {
    // Not Math.round of halves to even: that would collapse a line from 115.5 to 116.5 to no height.
    const left = Math.floor(this.x * dpiScale + 0.5);
    const top = Math.floor(this.y * dpiScale + 0.5);
    const right = Math.floor(this.right * dpiScale + 0.5);
    const bottom = Math.floor(this.bottom * dpiScale + 0.5);
    return {
      x: Math.fround(left),
      y: Math.fround(top),
      width: Math.fround(right - left),
      height: Math.fround(bottom - top),
    };
  }
}

/** A size in device-independent units. */
export interface DipSize {
  /** The width. */
  readonly width: number;
  /** The height. */
  readonly height: number;
}

/** One of the Y areas stacked in a chart, for example a channel of an oscilloscope. */
export interface LayoutPane {
  /** The vertical axes of the pane, inner ones of a side first. */
  readonly axes: readonly Axis[];
  /** The share of the height against the other panes; 1 when left out. */
  readonly weight?: number;
}

/** Room at the edges of a chart that the layout keeps free, such as for a legend. */
export interface ReservedRoom {
  /** Room at the left edge. */
  readonly left: number;
  /** Room at the top, below the title. */
  readonly top: number;
  /** Room at the right edge. */
  readonly right: number;
  /** Room at the bottom edge. */
  readonly bottom: number;
}

/** The distances of a layout in device-independent units. */
export interface ChartLayoutOptions {
  /** The free space around the chart; 8. */
  readonly padding?: number;
  /** Room kept free inside the padding; room on top lies below the title. */
  readonly reserved?: ReservedRoom;
  /** The length of tick marks; 5. */
  readonly tickLength?: number;
  /** The distance between tick marks and labels; 3. */
  readonly labelGap?: number;
  /** The distance between neighboring axes; 4. */
  readonly axisGap?: number;
  /**
   * The distance between stacked panes; 8. It grows to the line height if necessary, because the last label of a pane
   * reaches half a line beyond it, as does the first label of the next.
   */
  readonly paneGap?: number;
  /** The distance below the chart title; 6. */
  readonly titleGap?: number;
  /** The smallest distance of the plot from the left edge, so that plots of several charts line up; 0. */
  readonly minimumPlotLeft?: number;
  /** The smallest distance of the plot from the right edge; 0. */
  readonly minimumPlotRight?: number;
}

/** Where an axis sits. */
export interface AxisPlacement {
  /** The axis. */
  readonly axis: Axis;
  /** Where it sits, ticks, labels and title included. */
  readonly bounds: DipRect;
}

/** The arranged parts of a chart. */
export interface ChartLayoutResult {
  /** The line of the title; empty without one. */
  readonly title: DipRect;
  /** The area of all panes and the gaps between them. */
  readonly plotArea: DipRect;
  /** The panes, top first. */
  readonly panes: readonly DipRect[];
  /** Where each visible axis sits. */
  readonly axes: readonly AxisPlacement[];
}

interface Distances {
  readonly tickLength: number;
  readonly labelGap: number;
  readonly axisGap: number;
}

const noRoom: ReservedRoom = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * Arranges titles, axes and panes in the size of a chart. The height of horizontal axes does not depend on the width,
 * so one pass suffices: horizontal axes give the pane heights, those give the ticks and widths of the vertical axes,
 * and those the plot width.
 * @throws RangeError when the size is not finite or negative, there is no pane, a weight is not positive or an axis
 * sits on the wrong side.
 */
export function arrangeChart(
  size: DipSize,
  title: string | undefined,
  horizontalAxes: readonly Axis[],
  panes: readonly LayoutPane[],
  measurer: TextMeasurer,
  options: ChartLayoutOptions = {},
): ChartLayoutResult {
  validate(size, horizontalAxes, panes);
  const padding = options.padding ?? 8;
  const reserved = options.reserved ?? noRoom;
  const distances: Distances = {
    tickLength: options.tickLength ?? 5,
    labelGap: options.labelGap ?? 3,
    axisGap: options.axisGap ?? 4,
  };
  const left = padding + reserved.left;
  let top = padding;
  const right = size.width - padding - reserved.right;
  const bottom = size.height - padding - reserved.bottom;
  let titleBounds = DipRect.empty;
  if (title) {
    titleBounds = new DipRect(left, top, Math.max(right - left, 0), measurer.lineHeight);
    top += measurer.lineHeight + (options.titleGap ?? 6);
  }
  // Room on top comes below the title, so that a legend there sits between title and plot.
  top += reserved.top;

  const topAxes = horizontalAxes.filter((axis) => axis.position === 'top');
  const bottomAxes = horizontalAxes.filter((axis) => axis.position === 'bottom');
  const topThicknesses = topAxes.map((axis) => horizontalThickness(axis, measurer, distances));
  const bottomThicknesses = bottomAxes.map((axis) => horizontalThickness(axis, measurer, distances));

  // Vertical labels center on their tick, the outermost must stay inside the chart.
  const halfLine = measurer.lineHeight / 2;
  const paneGap = Math.max(options.paneGap ?? 8, measurer.lineHeight);
  const plotTop = Math.max(top + stacked(topThicknesses, distances), halfLine);
  const plotBottom = Math.max(
    Math.min(bottom - stacked(bottomThicknesses, distances), size.height - halfLine),
    plotTop,
  );
  const paneHeights = distributeHeights(plotBottom - plotTop, panes, paneGap);

  const leftColumns = measureColumns(panes, paneHeights, 'left', measurer, distances);
  const rightColumns = measureColumns(panes, paneHeights, 'right', measurer, distances);
  let plotLeft = left + stacked(leftColumns, distances);
  let plotRight = Math.max(right - stacked(rightColumns, distances), plotLeft);
  [plotLeft, plotRight] = keepLabelsInside(horizontalAxes, plotLeft, plotRight, size.width, measurer);
  plotLeft = Math.max(plotLeft, options.minimumPlotLeft ?? 0);
  plotRight = Math.max(Math.min(plotRight, size.width - (options.minimumPlotRight ?? 0)), plotLeft);
  const plotWidth = plotRight - plotLeft;

  const paneBounds: DipRect[] = [];
  const placements: AxisPlacement[] = [];
  let paneTop = plotTop;
  panes.forEach((pane, i) => {
    const height = paneHeights[i] ?? 0;
    const bounds = new DipRect(plotLeft, paneTop, plotWidth, height);
    paneBounds.push(bounds);
    placeVertical(pane, bounds, leftColumns, rightColumns, distances, placements);
    paneTop += height + paneGap;
  });

  const plotArea = new DipRect(plotLeft, plotTop, plotWidth, plotBottom - plotTop);
  placeHorizontal(topAxes, topThicknesses, plotArea, true, distances, placements);
  placeHorizontal(bottomAxes, bottomThicknesses, plotArea, false, distances, placements);
  return { title: titleBounds, plotArea, panes: paneBounds, axes: placements };
}

function validate(size: DipSize, horizontalAxes: readonly Axis[], panes: readonly LayoutPane[]): void {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width < 0 || size.height < 0) {
    throw new RangeError(`The size ${String(size.width)} × ${String(size.height)} must be finite and not negative.`);
  }
  if (panes.length === 0) {
    throw new RangeError('A chart needs at least one pane.');
  }
  for (const axis of horizontalAxes) {
    if (!axis.isHorizontal) {
      throw new RangeError(`Axis '${axis.id}' is not horizontal.`);
    }
  }
  for (const pane of panes) {
    const weight = pane.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RangeError(`The pane weight ${String(weight)} is not positive.`);
    }
    for (const axis of pane.axes) {
      if (axis.isHorizontal) {
        throw new RangeError(`Axis '${axis.id}' is not vertical.`);
      }
    }
  }
}

function stacked(thicknesses: readonly number[], distances: Distances): number {
  let total = 0;
  for (const thickness of thicknesses) {
    // A hidden axis takes no room, not even the gap.
    total += thickness > 0 ? thickness + distances.axisGap : 0;
  }
  return total;
}

function titleThickness(axis: Axis, measurer: TextMeasurer, distances: Distances): number {
  return axis.title ? measurer.lineHeight + distances.labelGap : 0;
}

function horizontalThickness(axis: Axis, measurer: TextMeasurer, distances: Distances): number {
  return axis.isHidden || axis.crossesAt !== undefined
    ? 0
    : distances.tickLength +
        distances.labelGap +
        axis.measureLabelHeight(measurer) +
        titleThickness(axis, measurer, distances);
}

function verticalThickness(axis: Axis, length: number, measurer: TextMeasurer, distances: Distances): number {
  if (axis.isHidden || axis.crossesAt !== undefined) {
    return 0;
  }
  let labelWidth = 0;
  for (const tick of axis.generateTicks(length, measurer).major) {
    labelWidth = Math.max(labelWidth, measurer.measureWidth(tick.label));
  }
  return (
    axis.bandThickness +
    distances.tickLength +
    distances.labelGap +
    labelWidth +
    titleThickness(axis, measurer, distances)
  );
}

/** Narrows the plot until the centered labels at the ends of the horizontal axes fit into the chart. */
function keepLabelsInside(
  axes: readonly Axis[],
  left: number,
  right: number,
  chartWidth: number,
  measurer: TextMeasurer,
): [number, number] {
  let overhangLeft = 0;
  let overhangRight = 0;
  for (const axis of axes) {
    if (axis.isHidden) {
      continue;
    }
    const ticks = axis.generateTicks(right - left, measurer).major;
    const first = ticks[0];
    const last = ticks.at(-1);
    if (!first || !last) {
      continue;
    }
    const transform = axis.createTransform(left, right - left);
    for (const tick of [first, last]) {
      const position = transform.toPixel(tick.value);
      const halfWidth = measurer.measureWidth(tick.label) / 2;
      overhangLeft = Math.max(overhangLeft, halfWidth - position);
      overhangRight = Math.max(overhangRight, position + halfWidth - chartWidth);
    }
  }
  const narrowedLeft = left + overhangLeft;
  return [narrowedLeft, Math.max(right - overhangRight, narrowedLeft)];
}

function distributeHeights(available: number, panes: readonly LayoutPane[], paneGap: number): number[] {
  const free = Math.max(available - (panes.length - 1) * paneGap, 0);
  let totalWeight = 0;
  for (const pane of panes) {
    totalWeight += pane.weight ?? 1;
  }
  const heights: number[] = [];
  let remaining = free;
  for (let i = 0; i < panes.length - 1; i++) {
    const height = (free * (panes[i]?.weight ?? 1)) / totalWeight;
    heights.push(height);
    remaining -= height;
  }
  // The rest instead of a share: rounding must not change the sum.
  heights.push(Math.max(remaining, 0));
  return heights;
}

/** The width per column of a side. Axes in one column of different panes share it, so that the panes align. */
function measureColumns(
  panes: readonly LayoutPane[],
  heights: readonly number[],
  side: 'left' | 'right',
  measurer: TextMeasurer,
  distances: Distances,
): number[] {
  const columns: number[] = [];
  panes.forEach((pane, i) => {
    let column = 0;
    for (const axis of pane.axes) {
      if (axis.position !== side) {
        continue;
      }
      const thickness = verticalThickness(axis, heights[i] ?? 0, measurer, distances);
      columns[column] = Math.max(columns[column] ?? thickness, thickness);
      column++;
    }
  });
  return columns;
}

function placeVertical(
  pane: LayoutPane,
  bounds: DipRect,
  leftColumns: readonly number[],
  rightColumns: readonly number[],
  distances: Distances,
  placements: AxisPlacement[],
): void {
  let leftEdge = bounds.x;
  let rightEdge = bounds.right;
  let leftColumn = 0;
  let rightColumn = 0;
  for (const axis of pane.axes) {
    if (axis.position === 'left') {
      const width = leftColumns[leftColumn++] ?? 0;
      leftEdge -= width + distances.axisGap;
      placements.push({ axis, bounds: new DipRect(leftEdge, bounds.y, width, bounds.height) });
    } else {
      const width = rightColumns[rightColumn++] ?? 0;
      placements.push({ axis, bounds: new DipRect(rightEdge + distances.axisGap, bounds.y, width, bounds.height) });
      rightEdge += width + distances.axisGap;
    }
  }
}

function placeHorizontal(
  axes: readonly Axis[],
  thicknesses: readonly number[],
  plotArea: DipRect,
  isTop: boolean,
  distances: Distances,
  placements: AxisPlacement[],
): void {
  let edge = isTop ? plotArea.y : plotArea.bottom;
  axes.forEach((axis, i) => {
    const thickness = thicknesses[i] ?? 0;
    if (isTop) {
      edge -= thickness + distances.axisGap;
      placements.push({ axis, bounds: new DipRect(plotArea.x, edge, plotArea.width, thickness) });
    } else {
      placements.push({ axis, bounds: new DipRect(plotArea.x, edge + distances.axisGap, plotArea.width, thickness) });
      edge += thickness + distances.axisGap;
    }
  });
}
