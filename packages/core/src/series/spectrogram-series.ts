// A waterfall of rows, as SpectrogramData and SpectrogramSeries of the .NET version: columns run along X, time along Y.
// A new row reaches the GPU as one row of a ring texture, and the shader turns the ring, so nothing else moves.
import type { Axis } from '../axes/axis';
import type { ColorAxis } from '../axes/color-axis';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList, RasterReduction } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuTexture } from '../render/resources';
import type { PixelRect } from '../render/types';
import type { Colormap } from './colormap';
import { placeRaster } from './heatmap-series';

/** A ring of rows of equal length: every new row replaces the oldest. */
export class SpectrogramData {
  private readonly ring: Float32Array;
  private readonly minimums: Float32Array;
  private readonly maximums: Float32Array;
  private total = 0;

  /**
   * @param columns - The length of a row.
   * @param rows - The number of rows kept.
   * @throws RangeError when a side is not a whole number above 0.
   */
  constructor(
    /** The length of a row. */
    readonly columns: number,
    /** The number of rows kept. */
    readonly rows: number,
  ) {
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) {
      throw new RangeError(`A spectrogram needs whole sides above 0, not ${String(columns)} × ${String(rows)}.`);
    }
    this.ring = new Float32Array(columns * rows).fill(Number.NaN);
    this.minimums = new Float32Array(rows).fill(Number.POSITIVE_INFINITY);
    this.maximums = new Float32Array(rows).fill(Number.NEGATIVE_INFINITY);
  }

  /** The number of rows appended so far. */
  get totalRows(): number {
    return this.total;
  }

  /** The range of the finite values kept; undefined without one. */
  get valueRange(): DoubleRange | undefined {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.rows; i++) {
      minimum = Math.min(minimum, this.minimums[i] as number);
      maximum = Math.max(maximum, this.maximums[i] as number);
    }
    return minimum <= maximum ? new DoubleRange(minimum, maximum) : undefined;
  }

  /**
   * Appends a row, copied.
   * @throws RangeError when its length does not match a row.
   */
  appendRow(row: ArrayLike<number>): void {
    if (row.length !== this.columns) {
      throw new RangeError(`A row takes ${String(this.columns)} values, not ${String(row.length)}.`);
    }
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    const slot = this.total % this.rows;
    const at = slot * this.columns;
    for (let i = 0; i < row.length; i++) {
      const value = Math.fround(row[i] as number);
      this.ring[at + i] = value;
      if (Number.isFinite(value)) {
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
    }
    this.minimums[slot] = minimum;
    this.maximums[slot] = maximum;
    this.total++;
  }

  /** A value of a row by its number since the start; NaN for a row no longer or not yet kept. */
  read(row: number, column: number): number {
    if (row < Math.max(this.total - this.rows, 0) || row >= this.total || column < 0 || column >= this.columns) {
      return Number.NaN;
    }
    return this.ring[(row % this.rows) * this.columns + column] as number;
  }

  /** Brings a texture of the ring up to date from the rows uploaded before; returns the rows uploaded now. */
  upload(texture: GpuTexture, uploaded: number): number {
    const missing = this.total - uploaded;
    if (uploaded < 0 || missing >= this.rows) {
      texture.write(this.ring);
      return this.rows;
    }
    for (let row = uploaded; row < this.total; row++) {
      const slot = row % this.rows;
      texture.writeRow(slot, this.ring.subarray(slot * this.columns, (slot + 1) * this.columns));
    }
    return missing;
  }
}

/** A waterfall of rows in the colors of a color axis: the newest row at Y 0, older rows below it. */
export class SpectrogramSeries extends ChartSeries {
  private start = { x: 0, y: 0 };
  private step = { x: 1, y: 1 };
  private anchored = true;
  private reduce: RasterReduction = 'maximum';
  private layoutChanges = 0;
  private texture: GpuTexture | undefined;
  private uploaded = -1;
  private uploadedRows = 0;
  private table: GpuTexture | undefined;
  private tableMap: Colormap | undefined;
  private bounds: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
  private origin = { x: 0, y: 0 };
  private size = { x: 1, y: 1 };
  private readonly ownColorAxis: ColorAxis;

  /**
   * @param data - The rows.
   * @param xAxis - The horizontal axis, linear.
   * @param yAxis - The vertical axis, linear.
   * @param axis - The color axis of the values.
   * @throws RangeError for an axis that is not linear.
   */
  constructor(
    /** The rows. */
    readonly data: SpectrogramData,
    xAxis: Axis,
    yAxis: Axis,
    axis: ColorAxis,
  ) {
    super(xAxis, yAxis);
    if (xAxis.scaling !== undefined || yAxis.scaling !== undefined) {
      throw new RangeError('A spectrogram needs linear axes.');
    }
    this.ownColorAxis = axis;
  }

  /** {@inheritDoc ChartSeries.colorAxis} */
  override get colorAxis(): ColorAxis {
    return this.ownColorAxis;
  }

  /** The rows uploaded so far, a diagnostic counter. */
  get uploadedRowCount(): number {
    return this.uploadedRows;
  }

  /** What a pixel shows when several cells fall on it; the maximum by default, which keeps narrow lines visible. */
  get reduction(): RasterReduction {
    return this.reduce;
  }

  set reduction(value: RasterReduction) {
    this.reduce = value;
    this.layoutChanges++;
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
    this.step = { ...this.step, x: finite(value) };
    this.layoutChanges++;
  }

  /** The lower edge of the first row, unless the rows are anchored to the newest. */
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
    this.step = { ...this.step, y: finite(value) };
    this.layoutChanges++;
  }

  /**
   * Whether Y counts back from the newest row, which ends at 0, so that the axis stays still while the rows pass
   * through it; true by default. Otherwise a row keeps its Y and the axis has to move along.
   */
  get isAnchoredToNewest(): boolean {
    return this.anchored;
  }

  set isAnchoredToNewest(value: boolean) {
    this.anchored = value;
    this.layoutChanges++;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.data.totalRows + this.layoutChanges + this.ownColorAxis.version;
  }

  /** {@inheritDoc ChartSeries.drawnPointCount} */
  override get drawnPointCount(): number {
    return this.data.columns * this.data.rows;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const total = this.data.totalRows;
    if (total === 0) {
      return undefined;
    }
    return axis === 'x' ? this.columnRange() : this.rowRange(total);
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
    const { columns, rows } = this.data;
    this.texture ??= device.createTexture({ size: { width: columns, height: rows }, format: 'r32float' });
    const total = this.data.totalRows;
    if (this.uploaded !== total) {
      this.uploadedRows += this.data.upload(this.texture, this.uploaded);
      this.uploaded = total;
    }
    const shown = Math.min(total, rows);
    if (shown === 0) {
      this.bounds = { x: 0, y: 0, width: 0, height: 0 };
      return;
    }
    const placed = placeRaster(frame, this.columnRange(), this.rowRange(total), 1, Math.fround(shown / rows));
    this.bounds = placed.bounds;
    this.origin = placed.origin;
    this.size = placed.size;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList): void {
    const bounds = this.bounds;
    if (!this.texture || !this.table || bounds.width <= 0 || bounds.height <= 0) {
      return;
    }
    const rows = this.data.rows;
    commands.drawRaster(this.texture, this.table, bounds, {
      ...this.ownColorAxis.rasterStyle(),
      sectionX: this.origin.x,
      sectionY: this.origin.y,
      sectionWidth: this.size.x,
      sectionHeight: this.size.y,
      reduction: this.reduce,
      // The oldest row is the next to be replaced.
      rowShift: this.uploaded >= rows ? this.uploaded % rows : 0,
    });
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.texture?.dispose();
    this.table?.dispose();
    this.texture = undefined;
    this.table = undefined;
    this.tableMap = undefined;
    this.uploaded = -1;
  }

  private columnRange(): DoubleRange {
    return new DoubleRange(this.start.x, this.start.x + this.step.x * this.data.columns);
  }

  // The range of the rows kept, the newest one last.
  private rowRange(total: number): DoubleRange {
    const end = this.anchored ? 0 : this.start.y + total * this.step.y;
    return new DoubleRange(end - Math.min(total, this.data.rows) * this.step.y, end);
  }
}

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`The value must be finite, not ${String(value)}.`);
  }
  return value;
}
