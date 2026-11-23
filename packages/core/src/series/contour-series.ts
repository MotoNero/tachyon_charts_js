// Isolines of a grid, optionally with filled bands between them, as ContourSeries of the .NET version. The samples
// sit in the middle of the cells of a heatmap with the same layout. The lines come from MarchingSquares on the CPU,
// the way of the .NET version on devices without compute shaders; the bands are the grid itself, drawn blended
// through a table of flat colors.
import type { Axis } from '../axes/axis';
import type { ColorAxis } from '../axes/color-axis';
import { marchingSquares } from '../numerics/marching-squares';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuBuffer, GpuTexture } from '../render/resources';
import { BufferUsage, type PixelRect, type Rgba8 } from '../render/types';
import { Colormap } from './colormap';
import { placeRaster, type HeatmapData } from './heatmap-series';

const defaultLevelCount = 8;
const entryCount = 256;
const gap = 1e30;
const f = Math.fround;

/** Isolines of a grid in the colors of a color axis, with filled bands between them when asked. */
export class ContourSeries extends ChartSeries {
  private start = { x: 0, y: 0 };
  private step = { x: 1, y: 1 };
  private chosenLevels: Float32Array | undefined;
  private filled = false;
  private lines = true;
  private labels = false;
  private line: Rgba8 = { r: 240, g: 240, b: 240, a: 255 };
  private thickness = 1.5;
  private layoutChanges = 0;
  private levelsInUse: Float32Array = new Float32Array(0);
  private values: GpuTexture | undefined;
  private uploaded = -1;
  private segments: GpuBuffer | undefined;
  private segmentTotal = 0;
  private builtVersion = -1;
  private bands: GpuTexture | undefined;
  private bandVersion = -1;
  private bounds: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
  private origin = { x: 0, y: 0 };
  private size = { x: 1, y: 1 };
  private readonly ownColorAxis: ColorAxis;

  /**
   * @param data - The samples.
   * @param xAxis - The horizontal axis, linear.
   * @param yAxis - The vertical axis, linear.
   * @param axis - The color axis of the bands.
   * @throws RangeError for an axis that is not linear.
   */
  constructor(
    /** The samples. */
    readonly data: HeatmapData,
    xAxis: Axis,
    yAxis: Axis,
    axis: ColorAxis,
  ) {
    super(xAxis, yAxis);
    if (xAxis.scaling !== undefined || yAxis.scaling !== undefined) {
      throw new RangeError('A contour needs linear axes.');
    }
    this.ownColorAxis = axis;
  }

  /** {@inheritDoc ChartSeries.colorAxis} */
  override get colorAxis(): ColorAxis {
    return this.ownColorAxis;
  }

  /** The number of pieces of lines of the last frame. */
  get segmentCount(): number {
    return this.segmentTotal;
  }

  /** The levels, sorted; undefined for eight equal steps through the values. */
  get levels(): readonly number[] | undefined {
    return this.chosenLevels ? [...this.chosenLevels] : undefined;
  }

  set levels(value: readonly number[] | undefined) {
    if (value?.some((level) => !Number.isFinite(level))) {
      throw new RangeError('The levels must be finite.');
    }
    this.chosenLevels = value ? Float32Array.from([...value].sort((a, b) => a - b)) : undefined;
    this.touch();
  }

  /** Whether the bands between the lines are filled; false by default. */
  get isFilled(): boolean {
    return this.filled;
  }

  set isFilled(value: boolean) {
    this.filled = value;
    this.touch();
  }

  /** Whether the lines are drawn; true by default. */
  get showsLines(): boolean {
    return this.lines;
  }

  set showsLines(value: boolean) {
    this.lines = value;
    this.touch();
  }

  /**
   * Whether the lines carry their values: along the line, upright, on a plate that hides the line beneath, and never
   * on top of each other; false by default.
   */
  get showsLabels(): boolean {
    return this.labels;
  }

  set showsLabels(value: boolean) {
    this.labels = value;
    this.touch();
  }

  /** The place of a grid point in values of the axes: the middle of its cell. */
  gridPoint(column: number, row: number): [number, number] {
    return [this.start.x + (column + 0.5) * this.step.x, this.start.y + (row + 0.5) * this.step.y];
  }

  /** The color of the lines. */
  get lineColor(): Rgba8 {
    return this.line;
  }

  set lineColor(value: Rgba8) {
    this.line = value;
    this.touch();
  }

  /**
   * The thickness of the lines in device-independent units; 1.5 by default.
   * @throws RangeError when it is not positive.
   */
  get lineThickness(): number {
    return this.thickness;
  }

  set lineThickness(value: number) {
    if (!(value > 0) || !Number.isFinite(value)) {
      throw new RangeError(`The thickness must be positive, not ${String(value)}.`);
    }
    this.thickness = value;
    this.touch();
  }

  /** The left edge of the first column; 0 by default. */
  get xStart(): number {
    return this.start.x;
  }

  set xStart(value: number) {
    this.start = { ...this.start, x: value };
    this.touch();
  }

  /** The width of a column; 1 by default. */
  get xStep(): number {
    return this.step.x;
  }

  set xStep(value: number) {
    this.step = { ...this.step, x: value };
    this.touch();
  }

  /** The lower edge of the first row; 0 by default. */
  get yStart(): number {
    return this.start.y;
  }

  set yStart(value: number) {
    this.start = { ...this.start, y: value };
    this.touch();
  }

  /** The height of a row; 1 by default. */
  get yStep(): number {
    return this.step.y;
  }

  set yStep(value: number) {
    this.step = { ...this.step, y: value };
    this.touch();
  }

  /** The levels of the last frame. */
  get currentLevels(): Float32Array {
    return this.levelsInUse;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.data.version + this.layoutChanges + this.ownColorAxis.version;
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
    const version = this.data.version + this.layoutChanges;
    const levels = this.chosenLevels ?? this.createLevels();
    this.levelsInUse = levels;
    const { width, height } = this.data;
    if (!this.values) {
      this.values = device.createTexture({ size: { width, height }, format: 'r32float' });
      this.uploaded = -1;
    }
    if (this.uploaded !== this.data.version) {
      this.values.write(this.data.values);
      this.uploaded = this.data.version;
    }
    if (this.builtVersion !== version) {
      this.buildSegments(device, levels);
      this.builtVersion = version;
    }
    if (this.filled) {
      this.updateBands(device, levels);
      const placed = placeRaster(frame, this.xRange(), this.yRange(), 1, 1);
      this.bounds = placed.bounds;
      this.origin = placed.origin;
      this.size = placed.size;
    }
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    const bounds = this.bounds;
    if (this.filled && this.values && this.bands && bounds.width > 0 && bounds.height > 0) {
      // The bands are values of the scale, so the range is the one the table was made for.
      commands.drawRaster(this.values, this.bands, bounds, {
        ...this.ownColorAxis.rasterStyle(),
        sectionX: this.origin.x,
        sectionY: this.origin.y,
        sectionWidth: this.size.x,
        sectionHeight: this.size.y,
        isInterpolated: true,
      });
    }
    if (this.lines && this.segments && this.segmentTotal > 0) {
      commands.drawPolyline(this.segments, 0, this.segmentTotal * 3, {
        widthInPixels: f(this.thickness * frame.dpiScale),
        color: this.line,
        scaleX: f(frame.x.pixelsPerUnit * this.step.x),
        scaleY: f(frame.y.pixelsPerUnit * this.step.y),
        offsetX: f(frame.x.toPixel(this.start.x + this.step.x / 2)),
        offsetY: f(frame.y.toPixel(this.start.y + this.step.y / 2)),
        clip: frame.bounds,
      });
    }
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.values?.dispose();
    this.segments?.dispose();
    this.bands?.dispose();
    this.values = undefined;
    this.segments = undefined;
    this.bands = undefined;
    this.uploaded = -1;
    this.builtVersion = -1;
    this.bandVersion = -1;
  }

  private touch(): void {
    this.layoutChanges++;
  }

  private xRange(): DoubleRange {
    return new DoubleRange(this.start.x, this.start.x + this.step.x * this.data.width);
  }

  private yRange(): DoubleRange {
    return new DoubleRange(this.start.y, this.start.y + this.step.y * this.data.height);
  }

  private createLevels(): Float32Array {
    const range = this.data.valueRange;
    if (!range) {
      return new Float32Array(0);
    }
    const levels = new Float32Array(defaultLevelCount);
    for (let i = 0; i < levels.length; i++) {
      levels[i] = range.min + ((range.max - range.min) * (i + 1)) / (levels.length + 1);
    }
    return levels;
  }

  // Each piece of line as three points, the third a gap, so that one line draws all of them.
  private buildSegments(device: RenderDevice, levels: Float32Array): void {
    const found: number[] = [];
    marchingSquares(this.data.values, this.data.width, this.data.height, levels, found);
    const count = found.length / 4;
    this.segmentTotal = count;
    if (count === 0) {
      return;
    }
    const points = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      points.set(found.slice(i * 4, i * 4 + 4), i * 6);
      points[i * 6 + 4] = gap;
      points[i * 6 + 5] = gap;
    }
    if (!this.segments || this.segments.sizeInBytes < points.byteLength) {
      this.segments?.dispose();
      this.segments = device.createBuffer({ sizeInBytes: points.byteLength, usage: BufferUsage.vertex });
    }
    this.segments.write(0, points);
  }

  private updateBands(device: RenderDevice, levels: Float32Array): void {
    const version = this.ownColorAxis.version + this.layoutChanges + this.data.version;
    if (this.bands && this.bandVersion === version) {
      return;
    }
    const map = this.bandMap(levels);
    this.bands?.dispose();
    this.bands = device.createTexture({ size: { width: map.entries.length, height: 1 }, format: 'rgba8unorm' });
    this.bands.write(map.toBytes());
    this.bandVersion = version;
  }

  // A map of flat bands, each in the color of its middle on the scale of the axis.
  private bandMap(levels: Float32Array): Colormap {
    const axis = this.ownColorAxis;
    const scaling = axis.scaling;
    const range = axis.visibleRange;
    const low = scaling ? scaling.forward(range.min) : range.min;
    const high = scaling ? scaling.forward(range.max) : range.max;
    const positions = new Float64Array(levels.length + 2);
    positions[positions.length - 1] = 1;
    levels.forEach((value, i) => {
      const level = scaling ? scaling.forward(value) : value;
      positions[i + 1] = Math.min(Math.max((level - low) / (high - low), 0), 1);
    });
    const entries: Rgba8[] = [];
    let band = 0;
    for (let i = 0; i < entryCount; i++) {
      const position = i / (entryCount - 1);
      while (band + 2 < positions.length && position >= (positions[band + 1] as number)) {
        band++;
      }
      entries.push(axis.colormap.sample(((positions[band] as number) + (positions[band + 1] as number)) / 2));
    }
    return new Colormap('Bands', entries);
  }
}
