// Ternary points and parallel coordinates, as TernaryProjection, TernarySeries and ParallelCoordinatesSeries of the
// .NET version. Both live in a chart of hidden axes from 0 to 1 and draw their own grid as an overlay.
import type { Axis } from '../axes/axis';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import { lineGap, markerStride, type CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuBuffer } from '../render/resources';
import { BufferUsage, packRgba8, type Rgba8 } from '../render/types';

const f = Math.fround;
const ternaryShare = 0.82;
const heightPerSide = Math.sqrt(3) / 2;
const denseRows = 2000;
const minimumAlpha = 4;

/** Maps three parts to a triangle with A at the top, B at the bottom left and C at the bottom right. */
export class TernaryProjection {
  /**
   * @param centerX - The middle, horizontally.
   * @param top - The top corner, vertically.
   * @param side - The length of a side.
   */
  constructor(
    /** The middle, horizontally. */
    readonly centerX: number,
    /** The top corner, vertically. */
    readonly top: number,
    /** The length of a side. */
    readonly side: number,
  ) {}

  /** The height of the triangle. */
  get height(): number {
    return this.side * heightPerSide;
  }

  /** The projection of an area: the triangle centered, at 82 % of the room. */
  static fit(x: number, y: number, width: number, height: number): TernaryProjection {
    const side = Math.min(width, height / heightPerSide) * ternaryShare;
    return new TernaryProjection(x + width / 2, y + (height - side * heightPerSide) / 2, side);
  }

  /** The point of three parts, which need not add up to 1; NaN when their sum is not positive. */
  toPoint(a: number, b: number, c: number): { x: number; y: number } {
    const sum = a + b + c;
    if (!(sum > 0) || !Number.isFinite(sum)) {
      return { x: Number.NaN, y: Number.NaN };
    }
    return {
      x: f(this.centerX + (((c - b) / sum) * this.side) / 2),
      y: f(this.top + (1 - a / sum) * this.height),
    };
  }
}

/** Points of three parts each, drawn as circles in a triangle. */
export class TernarySeries extends ChartSeries {
  private readonly a: Float64Array;
  private readonly b: Float64Array;
  private readonly c: Float64Array;
  private instances = new Float32Array(0);
  private count = 0;
  private buffer: GpuBuffer | undefined;
  private fill: Rgba8 = { r: 80, g: 170, b: 240, a: 255 };
  private size = 7;
  private changes = 0;
  private builtVersion = -1;
  private builtFrame: SeriesFrame | undefined;

  /**
   * @param a - The first parts, at the top corner.
   * @param b - The second parts, at the bottom left.
   * @param c - The third parts, at the bottom right.
   * @param xAxis - The hidden X axis.
   * @param yAxis - The hidden Y axis.
   * @throws RangeError when the numbers of parts differ.
   */
  constructor(a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>, xAxis: Axis, yAxis: Axis) {
    super(xAxis, yAxis);
    if (a.length !== b.length || a.length !== c.length) {
      throw new RangeError('All parts need the same number of values.');
    }
    this.a = Float64Array.from(a);
    this.b = Float64Array.from(b);
    this.c = Float64Array.from(c);
  }

  /** The color of the points. */
  get color(): Rgba8 {
    return this.fill;
  }

  set color(value: Rgba8) {
    this.fill = value;
    this.changes++;
  }

  /** The diameter of a point in device-independent units; 7 by default. */
  get pointSize(): number {
    return this.size;
  }

  set pointSize(value: number) {
    this.size = value;
    this.changes++;
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.fill;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.changes;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(): DoubleRange | undefined {
    // The axes stay at 0 to 1 and do not follow the values.
    return undefined;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    if (this.builtVersion === this.changes && this.builtFrame === frame) {
      return;
    }
    const bounds = frame.bounds;
    const projection = TernaryProjection.fit(bounds.x, bounds.y, bounds.width, bounds.height);
    const floats = this.a.length * (markerStride / 4);
    if (this.instances.length < floats) {
      this.instances = new Float32Array(floats);
    }
    const words = new Uint32Array(this.instances.buffer);
    const color = packRgba8(this.fill);
    const diameter = f(this.size * frame.dpiScale);
    this.count = 0;
    for (let i = 0; i < this.a.length; i++) {
      const point = projection.toPoint(this.a[i] as number, this.b[i] as number, this.c[i] as number);
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
        const at = this.count * 4;
        this.instances[at] = point.x;
        this.instances[at + 1] = point.y;
        this.instances[at + 2] = diameter;
        words[at + 3] = color;
        this.count++;
      }
    }
    if (this.count > 0) {
      const data = this.instances.subarray(0, this.count * 4);
      if (!this.buffer || this.buffer.sizeInBytes < data.byteLength) {
        this.buffer?.dispose();
        this.buffer = device.createBuffer({ sizeInBytes: data.byteLength, usage: BufferUsage.vertex });
      }
      this.buffer.write(0, data);
    }
    this.builtVersion = this.changes;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.buffer && this.count > 0) {
      commands.drawMarkers(this.buffer, 0, this.count, {
        shape: 'circle',
        borderWidthInPixels: 0,
        borderColor: { r: 0, g: 0, b: 0, a: 0 },
        clip: frame.bounds,
      });
    }
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.buffer?.dispose();
    this.buffer = undefined;
    this.builtVersion = -1;
  }
}

/** Rows of several measures, one line per row across one vertical axis per measure. */
export class ParallelCoordinatesSeries extends ChartSeries {
  private readonly columns: Float64Array[];
  private readonly ranges: DoubleRange[];
  private readonly filters: (DoubleRange | undefined)[];
  private readonly rows: number;
  private columnOrder: number[];
  private points = new Float32Array(0);
  private count = 0;
  private buffer: GpuBuffer | undefined;
  private stroke: Rgba8;
  private changes = 0;
  private builtVersion = -1;
  private builtFrame: SeriesFrame | undefined;

  /**
   * @param columns - The measures, each with one value per row.
   * @param xAxis - The hidden X axis.
   * @param yAxis - The hidden Y axis.
   * @throws RangeError with fewer than two measures or measures of different lengths.
   */
  constructor(columns: readonly ArrayLike<number>[], xAxis: Axis, yAxis: Axis) {
    super(xAxis, yAxis);
    if (columns.length < 2) {
      throw new RangeError('At least two measures are needed.');
    }
    this.rows = columns[0]?.length ?? 0;
    if (columns.some((column) => column.length !== this.rows)) {
      throw new RangeError('All measures need the same number of rows.');
    }
    // Many rows must not merge into one area: the density has to stay visible.
    const alpha = Math.min(Math.max(Math.trunc((40 * denseRows) / Math.max(this.rows, 1)), minimumAlpha), 40);
    this.stroke = { r: 80, g: 170, b: 240, a: alpha };
    this.columns = columns.map((column) => Float64Array.from(column));
    this.ranges = this.columns.map((column) =>
      column.reduce((range, value) => range.include(value), DoubleRange.empty),
    );
    this.columnOrder = this.columns.map((_, i) => i);
    this.filters = this.columns.map(() => undefined);
  }

  /** The measures in the order of their axes from the left. */
  get order(): readonly number[] {
    return this.columnOrder;
  }

  /** The color of the lines; translucent, so that the density shows. */
  get color(): Rgba8 {
    return this.stroke;
  }

  set color(value: Rgba8) {
    this.stroke = value;
    this.changes++;
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return { ...this.stroke, a: 255 };
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.changes;
  }

  /** The range of the values of a measure, from its axis bottom to top. */
  range(column: number): DoubleRange {
    return this.ranges[column] ?? DoubleRange.empty;
  }

  /** The values of a measure a row needs to be shown, if any. */
  filter(column: number): DoubleRange | undefined {
    return this.filters[column];
  }

  /** Shows only the rows whose measure lies in the range; undefined shows all again. */
  setFilter(column: number, range: DoubleRange | undefined): void {
    this.filters[column] = range;
    this.changes++;
  }

  /** Shows all rows again. */
  clearFilters(): void {
    this.filters.fill(undefined);
    this.changes++;
  }

  /** Moves an axis from one place to another. */
  moveAxis(from: number, to: number): void {
    const order = [...this.columnOrder];
    const [column] = order.splice(from, 1);
    if (column !== undefined) {
      order.splice(to, 0, column);
      this.columnOrder = order;
      this.changes++;
    }
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(): DoubleRange | undefined {
    // The axes stay at 0 to 1 and do not follow the values.
    return undefined;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    if (this.builtVersion === this.changes && this.builtFrame === frame) {
      return;
    }
    this.build(frame);
    if (this.count >= 2) {
      const data = this.points.subarray(0, this.count * 2);
      if (!this.buffer || this.buffer.sizeInBytes < data.byteLength) {
        this.buffer?.dispose();
        this.buffer = device.createBuffer({ sizeInBytes: data.byteLength, usage: BufferUsage.vertex });
      }
      this.buffer.write(0, data);
    }
    this.builtVersion = this.changes;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.buffer && this.count >= 2) {
      commands.drawPolyline(this.buffer, 0, this.count, {
        widthInPixels: f(frame.dpiScale),
        color: this.stroke,
        clip: frame.bounds,
      });
    }
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.buffer?.dispose();
    this.buffer = undefined;
    this.builtVersion = -1;
  }

  private build(frame: SeriesFrame): void {
    const axes = this.columnOrder.length;
    const needed = this.rows * (axes + 1) * 2;
    if (this.points.length < needed) {
      this.points = new Float32Array(needed);
    }
    const bounds = frame.bounds;
    const width = f(bounds.width / (axes - 1));
    const bottom = f(bounds.y + bounds.height);
    this.count = 0;
    for (let row = 0; row < this.rows; row++) {
      if (!this.isShown(row)) {
        continue;
      }
      for (let place = 0; place < axes; place++) {
        const column = this.columnOrder[place] as number;
        const range = this.ranges[column] as DoubleRange;
        const value = (this.columns[column] as Float64Array)[row] as number;
        const share = range.max > range.min ? (value - range.min) / (range.max - range.min) : 0.5;
        const at = this.count * 2;
        if (Number.isFinite(share)) {
          this.points[at] = f(bounds.x + f(place * width));
          this.points[at + 1] = f(bottom - f(f(share) * bounds.height));
        } else {
          this.points[at] = lineGap;
          this.points[at + 1] = 0;
        }
        this.count++;
      }
      this.points[this.count * 2] = lineGap;
      this.points[this.count * 2 + 1] = 0;
      this.count++;
    }
  }

  private isShown(row: number): boolean {
    for (let column = 0; column < this.filters.length; column++) {
      const filter = this.filters[column];
      const value = (this.columns[column] as Float64Array)[row] as number;
      if (filter && !(value >= filter.min && value <= filter.max)) {
        return false;
      }
    }
    return true;
  }
}
