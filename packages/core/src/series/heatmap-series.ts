// A grid of values shown as colors, as HeatmapData and HeatmapSeries of the .NET version. With equal cells on linear
// axes the GPU picks the cells from a texture of all values, so that moving the view uploads nothing; other grids and
// axes are resampled to the pixels of the plot on the CPU whenever the view or the data changes.
import type { Axis } from '../axes/axis';
import type { ColorAxis } from '../axes/color-axis';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuTexture } from '../render/resources';
import type { PixelRect } from '../render/types';
import type { Colormap } from './colormap';

const f = Math.fround;

/** A grid of values, row 0 at the bottom; NaN where a value is missing. */
export class HeatmapData {
  private grid: Float32Array;
  private range: DoubleRange | undefined;
  private changes = 0;

  /**
   * @param width - The number of columns.
   * @param height - The number of rows.
   * @throws RangeError when a side is not a whole number above 0.
   */
  constructor(
    /** The number of columns. */
    readonly width: number,
    /** The number of rows. */
    readonly height: number,
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError(`A grid needs whole sides above 0, not ${String(width)} × ${String(height)}.`);
    }
    this.grid = new Float32Array(width * height).fill(Number.NaN);
  }

  /** Grows with every new set of values. */
  get version(): number {
    return this.changes;
  }

  /** The lowest and highest finite value; undefined without one. */
  get valueRange(): DoubleRange | undefined {
    return this.range;
  }

  /** The values, `width` per row, row 0 at the bottom. Do not change them; set new ones. */
  get values(): Float32Array {
    return this.grid;
  }

  /** The value of a cell. */
  at(column: number, row: number): number {
    return this.grid[row * this.width + column] as number;
  }

  /**
   * Replaces all values, copied.
   * @throws RangeError when the number does not match the grid.
   */
  setValues(values: ArrayLike<number>): void {
    if (values.length !== this.width * this.height) {
      throw new RangeError(`The grid takes ${String(this.width * this.height)} values, not ${String(values.length)}.`);
    }
    const grid = Float32Array.from(values);
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const value of grid) {
      if (Number.isFinite(value)) {
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
    }
    this.grid = grid;
    this.range = minimum <= maximum ? new DoubleRange(minimum, maximum) : undefined;
    this.changes++;
  }
}

function checkEdges(edges: readonly number[] | undefined, count: number): Float64Array | undefined {
  if (!edges) {
    return undefined;
  }
  if (edges.length !== count + 1) {
    throw new RangeError(`${String(count)} cells need ${String(count + 1)} edges.`);
  }
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i] as number;
    if (!Number.isFinite(edge) || (i > 0 && edge <= (edges[i - 1] as number))) {
      throw new RangeError('The edges must be finite and rise.');
    }
  }
  return Float64Array.from(edges);
}

function findCell(value: number, edges: Float64Array | undefined, start: number, step: number, count: number): number {
  if (!edges) {
    const cell = Math.floor((value - start) / step);
    return cell >= 0 && cell < count ? cell : -1;
  }
  if (!(value >= (edges[0] as number)) || value > (edges.at(-1) as number)) {
    return -1;
  }
  // The last edge not above the value.
  let low = 0;
  let high = edges.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((edges[middle] as number) <= value) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return Math.min(low, count - 1);
}

// The part of a data range inside the pane; an end without a place on a logarithmic axis is the edge of the pane.
function clip(first: number, second: number, paneStart: number, paneLength: number): [number, number] {
  const missing = Number.isNaN(first) || Number.isNaN(second);
  const low = missing ? paneStart : Math.max(Math.min(first, second), paneStart);
  const high = missing ? paneStart + paneLength : Math.min(Math.max(first, second), paneStart + paneLength);
  return [f(low), f(high)];
}

/** The part of a data rectangle inside the pane, in pixels; empty when nothing shows. */
export function clipRaster(frame: SeriesFrame, x: DoubleRange, y: DoubleRange): PixelRect {
  const pane = frame.bounds;
  const [left, right] = clip(frame.x.toPixel(x.min), frame.x.toPixel(x.max), pane.x, pane.width);
  const [top, bottom] = clip(frame.y.toPixel(y.min), frame.y.toPixel(y.max), pane.y, pane.height);
  return { x: left, y: top, width: Math.max(f(right - left), 0), height: Math.max(f(bottom - top), 0) };
}

/**
 * The part of a data rectangle inside the pane and the section of a texture that belongs there, as Place of the
 * .NET version: texture coordinates grow with the values, whichever way the axes run; `filledX` and `filledY` are
 * the parts of the texture that hold data.
 */
export function placeRaster(
  frame: SeriesFrame,
  x: DoubleRange,
  y: DoubleRange,
  filledX: number,
  filledY: number,
): { bounds: PixelRect; origin: { x: number; y: number }; size: { x: number; y: number } } {
  const bounds = clipRaster(frame, x, y);
  const startX = frame.x.toPixel(x.min);
  const startY = frame.y.toPixel(y.min);
  const perPixelX = filledX / (frame.x.toPixel(x.max) - startX);
  const perPixelY = filledY / (frame.y.toPixel(y.max) - startY);
  return {
    bounds,
    origin: { x: f((bounds.x - startX) * perPixelX), y: f((bounds.y - startY) * perPixelY) },
    size: { x: f(bounds.width * perPixelX), y: f(bounds.height * perPixelY) },
  };
}

/** A grid of values as colors of a color axis. Cells have equal sizes, or edges of their own. */
export class HeatmapSeries extends ChartSeries {
  /** Whether the colors of neighboring cells blend. */
  isInterpolated = false;
  private start = { x: 0, y: 0 };
  private step = { x: 1, y: 1 };
  private edges: { x: Float64Array | undefined; y: Float64Array | undefined } = { x: undefined, y: undefined };
  private layoutChanges = 0;
  private valueTexture: GpuTexture | undefined;
  private uploaded = -1;
  private pixelTexture: GpuTexture | undefined;
  private pixels = new Float32Array(0);
  private pixelFrame: SeriesFrame | undefined;
  private pixelVersion = -1;
  private table: GpuTexture | undefined;
  private tableMap: Colormap | undefined;
  private texture: GpuTexture | undefined;
  private bounds: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
  private sectionOrigin = { x: 0, y: 0 };
  private sectionSize = { x: 1, y: 1 };

  /**
   * @param data - The grid.
   * @param xAxis - The horizontal axis.
   * @param yAxis - The vertical axis.
   * @param axis - The color axis of the values.
   */
  constructor(
    /** The grid. */
    readonly data: HeatmapData,
    xAxis: Axis,
    yAxis: Axis,
    axis: ColorAxis,
  ) {
    super(xAxis, yAxis);
    this.ownColorAxis = axis;
  }

  private readonly ownColorAxis: ColorAxis;

  /** {@inheritDoc ChartSeries.colorAxis} */
  override get colorAxis(): ColorAxis {
    return this.ownColorAxis;
  }

  /** The left edge of the first column; 0 by default. */
  get xStart(): number {
    return this.start.x;
  }

  set xStart(value: number) {
    this.start = { ...this.start, x: finite(value) };
    this.layoutChanges++;
  }

  /** The width of a column; 1 by default. */
  get xStep(): number {
    return this.step.x;
  }

  set xStep(value: number) {
    this.step = { ...this.step, x: positive(value) };
    this.layoutChanges++;
  }

  /** The lower edge of the first row; 0 by default. */
  get yStart(): number {
    return this.start.y;
  }

  set yStart(value: number) {
    this.start = { ...this.start, y: finite(value) };
    this.layoutChanges++;
  }

  /** The height of a row; 1 by default. */
  get yStep(): number {
    return this.step.y;
  }

  set yStep(value: number) {
    this.step = { ...this.step, y: positive(value) };
    this.layoutChanges++;
  }

  /** The edges of the columns, one more than columns and rising; undefined for equal columns. */
  get xEdges(): readonly number[] | undefined {
    return this.edges.x ? [...this.edges.x] : undefined;
  }

  set xEdges(value: readonly number[] | undefined) {
    this.edges = { ...this.edges, x: checkEdges(value, this.data.width) };
    this.layoutChanges++;
  }

  /** The edges of the rows, one more than rows and rising; undefined for equal rows. */
  get yEdges(): readonly number[] | undefined {
    return this.edges.y ? [...this.edges.y] : undefined;
  }

  set yEdges(value: readonly number[] | undefined) {
    this.edges = { ...this.edges, y: checkEdges(value, this.data.height) };
    this.layoutChanges++;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.data.version + this.layoutChanges + this.ownColorAxis.version;
  }

  /** {@inheritDoc ChartSeries.drawnPointCount} */
  override get drawnPointCount(): number {
    return this.data.width * this.data.height;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange {
    return axis === 'x' ? this.xRange() : this.yRange();
  }

  /** {@inheritDoc ChartSeries.colorRange} */
  override colorRange(): DoubleRange | undefined {
    return this.data.valueRange;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    const map = this.ownColorAxis.colormap;
    if (!this.table || this.tableMap !== map) {
      this.table?.dispose();
      this.table = device.createTexture({ size: { width: map.entries.length, height: 1 }, format: 'rgba8unorm' });
      this.table.write(map.toBytes());
      this.tableMap = map;
    }
    const limit = device.capabilities.maxTextureDimension;
    if (
      !this.edges.x &&
      !this.edges.y &&
      frame.x.isLinear &&
      frame.y.isLinear &&
      this.data.width <= limit &&
      this.data.height <= limit
    ) {
      this.prepareTexture(device, frame);
    } else {
      this.prepareResampled(device, frame);
    }
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList): void {
    const bounds = this.bounds;
    if (this.texture && this.table && bounds.width > 0 && bounds.height > 0) {
      commands.drawRaster(this.texture, this.table, bounds, {
        ...this.ownColorAxis.rasterStyle(),
        sectionX: this.sectionOrigin.x,
        sectionY: this.sectionOrigin.y,
        sectionWidth: this.sectionSize.x,
        sectionHeight: this.sectionSize.y,
        isInterpolated: this.isInterpolated,
      });
    }
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.valueTexture?.dispose();
    this.pixelTexture?.dispose();
    this.table?.dispose();
    this.valueTexture = undefined;
    this.pixelTexture = undefined;
    this.table = undefined;
    this.tableMap = undefined;
    this.texture = undefined;
    this.uploaded = -1;
    this.pixelVersion = -1;
  }

  private xRange(): DoubleRange {
    const edges = this.edges.x;
    return edges
      ? new DoubleRange(edges[0] as number, edges.at(-1) as number)
      : new DoubleRange(this.start.x, this.start.x + this.step.x * this.data.width);
  }

  private yRange(): DoubleRange {
    const edges = this.edges.y;
    return edges
      ? new DoubleRange(edges[0] as number, edges.at(-1) as number)
      : new DoubleRange(this.start.y, this.start.y + this.step.y * this.data.height);
  }

  private clipped(frame: SeriesFrame): PixelRect {
    return clipRaster(frame, this.xRange(), this.yRange());
  }

  // All values in one texture; the section of it that shows follows the view, as Place of the .NET version.
  private prepareTexture(device: RenderDevice, frame: SeriesFrame): void {
    const { width, height } = this.data;
    if (!this.valueTexture) {
      this.valueTexture = device.createTexture({ size: { width, height }, format: 'r32float' });
      this.uploaded = -1;
    }
    if (this.uploaded !== this.data.version) {
      this.valueTexture.write(this.data.values);
      this.uploaded = this.data.version;
    }
    this.texture = this.valueTexture;
    const placed = placeRaster(frame, this.xRange(), this.yRange(), 1, 1);
    this.bounds = placed.bounds;
    this.sectionOrigin = placed.origin;
    this.sectionSize = placed.size;
  }

  // One value per pixel of the visible part, found on the CPU for any edges and axes.
  private prepareResampled(device: RenderDevice, frame: SeriesFrame): void {
    const clipped = this.clipped(frame);
    const firstColumn = Math.floor(clipped.x);
    const firstRow = Math.floor(clipped.y);
    const columns = Math.ceil(clipped.x + clipped.width) - firstColumn;
    const rows = Math.ceil(clipped.y + clipped.height) - firstRow;
    this.bounds = { x: firstColumn, y: firstRow, width: columns, height: rows };
    this.sectionOrigin = { x: 0, y: 0 };
    this.sectionSize = { x: 1, y: 1 };
    if (clipped.width <= 0 || clipped.height <= 0 || columns <= 0 || rows <= 0) {
      this.texture = undefined;
      return;
    }
    const size = this.pixelTexture?.size;
    if (!this.pixelTexture || size?.width !== columns || size.height !== rows) {
      this.pixelTexture?.dispose();
      this.pixelTexture = device.createTexture({ size: { width: columns, height: rows }, format: 'r32float' });
      this.pixelVersion = -1;
    }
    this.texture = this.pixelTexture;
    const version = this.data.version + this.layoutChanges;
    if (this.pixelVersion === version && this.pixelFrame === frame) {
      return;
    }
    this.resample(frame, firstColumn, firstRow, columns, rows);
    this.pixelTexture.write(this.pixels);
    this.pixelVersion = version;
    this.pixelFrame = frame;
  }

  // The rows of the texture run from the top pixel down, as the section of the raster reads them.
  private resample(frame: SeriesFrame, firstColumn: number, firstRow: number, columns: number, rows: number): void {
    if (this.pixels.length !== columns * rows) {
      this.pixels = new Float32Array(columns * rows);
    }
    const { width, height, values } = this.data;
    const cells = new Int32Array(columns);
    for (let i = 0; i < columns; i++) {
      cells[i] = findCell(frame.x.toData(firstColumn + i + 0.5), this.edges.x, this.start.x, this.step.x, width);
    }
    for (let y = 0; y < rows; y++) {
      const row = findCell(frame.y.toData(firstRow + y + 0.5), this.edges.y, this.start.y, this.step.y, height);
      const at = y * columns;
      for (let x = 0; x < columns; x++) {
        const column = cells[x] as number;
        this.pixels[at + x] = row < 0 || column < 0 ? Number.NaN : (values[row * width + column] as number);
      }
    }
  }
}

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`The value must be finite, not ${String(value)}.`);
  }
  return value;
}

function positive(value: number): number {
  if (!(value > 0)) {
    throw new RangeError(`The step must be positive, not ${String(value)}.`);
  }
  return value;
}
