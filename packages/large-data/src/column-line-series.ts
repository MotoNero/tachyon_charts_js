// A line over a column larger than memory, as ColumnLineSeries of the .NET version: from the pyramid
// alone while a pixel column holds 16 blocks or more (an extreme moves less than a pixel but is never lost), exact
// below that with the partial blocks at the edges of the pixel columns read from the file, and from the values
// themselves when a pixel column holds two or fewer, with the pages beside the view read ahead.
import {
  ChartSeries,
  DoubleRange,
  PixelLine,
  type Axis,
  type CommandList,
  type RenderDevice,
  type Rgba8,
  type SeriesFrame,
} from '@tachyon-charts/core';
import { pyramidBlockSize, type Extremes } from './column-pyramid';
import type { LargeColumn } from './large-column';

/** Pixel columns from this many blocks on are drawn from the pyramid alone. */
const wholeBlocksFrom = 16;

/** A line through a {@link LargeColumn}. */
export class ColumnLineSeries extends ChartSeries {
  private lineColor: Rgba8 = { r: 80, g: 170, b: 240, a: 255 };
  private lineThickness = 1.5;
  private appearance = 0;
  private readonly line = new PixelLine();
  private readonly extremes: Extremes = { min: 0, max: 0 };
  private readonly part: Extremes = { min: 0, max: 0 };
  private builtVersion = -1;
  private builtFrame: SeriesFrame | undefined;
  private builtRange: DoubleRange | undefined;
  private builtAppearance = -1;
  private exact = true;
  private mode: 'pyramid' | 'edges' | 'values' = 'pyramid';

  /**
   * @param column - The column to draw.
   * @param xAxis - The horizontal axis.
   * @param yAxis - The vertical axis.
   */
  constructor(
    /** The column it draws. */
    readonly column: LargeColumn,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** The color of the line. */
  get color(): Rgba8 {
    return this.lineColor;
  }

  set color(value: Rgba8) {
    this.lineColor = value;
    this.appearance++;
  }

  /** The width of the line in device-independent units. */
  get thickness(): number {
    return this.lineThickness;
  }

  set thickness(value: number) {
    this.lineThickness = value;
    this.appearance++;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.lineColor;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.version} */
  get version(): number {
    return this.column.version + this.appearance;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.drawnPointCount} */
  override get drawnPointCount(): number {
    return this.line.count;
  }

  /**
   * How the last frame was drawn: `pyramid` from whole blocks, `edges` exact with the edge blocks, `values` from the
   * values; and whether everything it needed was there (`isExact`), or it waits for the file.
   */
  get drawing(): { readonly mode: 'pyramid' | 'edges' | 'values'; readonly isExact: boolean } {
    return { mode: this.mode, isExact: this.exact && this.column.isComplete };
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const column = this.column;
    if (column.rows === 0) {
      return undefined;
    }
    if (axis === 'x') {
      return new DoubleRange(column.xStart, column.xStart + (column.rows - 1) * column.xStep);
    }
    const total = column.pyramid.total(this.part);
    return total.min > total.max ? undefined : new DoubleRange(total.min, total.max);
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.prepareData} */
  override prepareData(frame: SeriesFrame): void {
    const range = this.xAxis.visibleRange;
    if (
      this.builtVersion === this.column.version &&
      this.builtFrame === frame &&
      this.builtRange === range &&
      this.builtAppearance === this.appearance
    ) {
      return;
    }
    this.builtVersion = this.column.version;
    this.builtFrame = frame;
    this.builtRange = range;
    this.builtAppearance = this.appearance;
    this.build(frame, range);
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    this.prepareData(frame);
    this.line.prepare(device, frame, this.lineColor, this.lineThickness);
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.draw} */
  draw(commands: CommandList): void {
    this.line.draw(commands);
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.line.dispose();
    this.builtVersion = -1;
  }

  private build(frame: SeriesFrame, range: DoubleRange): void {
    const column = this.column;
    const width = Math.max(Math.ceil(frame.bounds.width), 1);
    const step = column.xStep;
    const rowAt = (x: number): number => (x - column.xStart) / step;
    const rowsPerPixel = (range.max - range.min) / step / width;
    this.line.clear();
    this.exact = true;
    if (rowsPerPixel <= 2 && this.addValues(frame, range, rowAt)) {
      this.line.end();
      return;
    }
    const { minima, maxima } = this.line.columns(width);
    const span = (range.max - range.min) / width;
    const blocksPerPixel = rowsPerPixel / pyramidBlockSize;
    this.mode = blocksPerPixel >= wholeBlocksFrom ? 'pyramid' : 'edges';
    for (let c = 0; c < width; c++) {
      const start = Math.max(Math.ceil(rowAt(range.min + c * span)), 0);
      const end = Math.min(Math.ceil(rowAt(range.min + (c + 1) * span)), column.rows);
      const extremes = this.mode === 'pyramid' ? this.wholeBlocks(start, end) : this.exactRange(start, end);
      minima[c] = extremes.min;
      maxima[c] = extremes.max;
    }
    this.line.addColumns(frame);
    this.line.end();
  }

  // Rows from start to before end, rounded out to whole blocks.
  private wholeBlocks(start: number, end: number): Extremes {
    if (start >= end) {
      return this.empty();
    }
    return this.column.pyramid.queryBlocks(
      Math.floor(start / pyramidBlockSize),
      Math.ceil(end / pyramidBlockSize),
      this.extremes,
    );
  }

  // Exact: whole blocks from the pyramid, the parts of the blocks at both ends from the file.
  private exactRange(start: number, end: number): Extremes {
    if (start >= end) {
      return this.empty();
    }
    const firstWhole = Math.ceil(start / pyramidBlockSize);
    const endWhole = Math.floor(end / pyramidBlockSize);
    const result = this.extremes;
    if (firstWhole < endWhole) {
      this.column.pyramid.queryBlocks(firstWhole, endWhole, result);
    } else {
      result.min = Number.POSITIVE_INFINITY;
      result.max = Number.NEGATIVE_INFINITY;
    }
    if (firstWhole >= endWhole) {
      this.addPart(start, end, result);
    } else {
      this.addPart(start, firstWhole * pyramidBlockSize, result);
      this.addPart(endWhole * pyramidBlockSize, end, result);
    }
    return result;
  }

  // Adds the values of a part of one block; until the block is read, the whole block stands in for it.
  private addPart(start: number, end: number, into: Extremes): void {
    if (start >= end) {
      return;
    }
    const block = Math.floor(start / pyramidBlockSize);
    const values = this.column.block(block);
    if (!values) {
      this.column.wantBlock(block);
      this.exact = false;
      const whole = this.column.pyramid.queryBlocks(block, block + 1, this.part);
      into.min = Math.min(into.min, whole.min);
      into.max = Math.max(into.max, whole.max);
      return;
    }
    const offset = block * pyramidBlockSize;
    for (let row = start; row < end; row++) {
      const value = values[row - offset] as number;
      if (Number.isFinite(value)) {
        into.min = Math.min(into.min, value);
        into.max = Math.max(into.max, value);
      }
    }
  }

  // Two or fewer values per pixel column: the values themselves, one row beyond each edge; the pages of a view to
  // each side are read ahead. Returns false while the rows are not read yet.
  private addValues(frame: SeriesFrame, range: DoubleRange, rowAt: (x: number) => number): boolean {
    const column = this.column;
    const first = Math.max(Math.floor(rowAt(range.min)) - 1, 0);
    const end = Math.min(Math.ceil(rowAt(range.max)) + 2, column.rows);
    const length = end - first;
    column.wantRows(first - length, end + length);
    if (!column.hasRows(first, end)) {
      this.exact = false;
      return false;
    }
    this.mode = 'values';
    for (let row = first; row < end; row++) {
      const value = column.value(row) ?? Number.NaN;
      this.line.addPoint(frame.x.toPixel(column.xStart + row * column.xStep), frame.y.toPixel(value));
    }
    return true;
  }

  private empty(): Extremes {
    this.extremes.min = Number.POSITIVE_INFINITY;
    this.extremes.max = Number.NEGATIVE_INFINITY;
    return this.extremes;
  }
}
