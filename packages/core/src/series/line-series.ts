// A line through the points of a data source (LineSeries and SnapshotLinePath of the .NET version).
import type { Axis } from '../axes/axis';
import {
  collectSourcePoints,
  findNearest,
  collectSourceLabels,
  readSourcePoint,
  type FoundPoint,
  type HitTestMode,
  type SelectionArea,
} from '../hit-testing/hit-test';
import type { ValueLabel } from '../pipeline/value-label';
import { DateTimeAxis } from '../axes/date-time-axis';
import { FifoDataSource } from '../data/fifo-data-source';
import { emptySnapshot, type DataSnapshot, type PointSource } from '../data/source';
import { DoubleRange } from '../numerics/range';
import type { CommandList, PolylineStyle } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { Rgba8 } from '../render/types';
import { lowerBound, upperBound } from '../resampling/min-max-decimator';
import { SeriesResampler, type ResampleResult, type ResamplingMode } from '../resampling/series-resampler';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import { expandDashes } from './dash-expander';
import { addMinMaxColumns } from './pixel-line';
import { smoothRuns, VertexBuffer, Vertices } from './vertices';

export { VertexBuffer } from './vertices';

const f = Math.fround;

/** The value zero of an axis in the units of the data: time axes count from their origin. */
export function originOf(axis: Axis): number {
  return axis instanceof DateTimeAxis ? Number(axis.origin) : 0;
}

/** The ranges of a source along its axes, relative to the origin of a time axis; kept until the source changes. */
export class DataRanges {
  private metadataSeen: unknown;
  private originSeen = Number.NaN;
  private x: DoubleRange | undefined;
  private y: DoubleRange | undefined;

  constructor(private readonly source: PointSource) {}

  of(axis: 'x' | 'y', xAxis: Axis): DoubleRange | undefined {
    const metadata = this.source.metadata;
    const origin = originOf(xAxis);
    if (metadata !== this.metadataSeen || origin !== this.originSeen) {
      this.metadataSeen = metadata;
      this.originSeen = origin;
      const range = metadata.xRange;
      const relative = origin === 0 || range.isEmpty ? range : new DoubleRange(range.min - origin, range.max - origin);
      this.x = metadata.count === 0 ? undefined : relative;
      this.y = metadata.count === 0 ? undefined : metadata.yRange;
    }
    return axis === 'x' ? this.x : this.y;
  }
}

const highlightGrowth = 1.5;

/**
 * A line through the points of a data source. NaN and ±∞ interrupt it. Dense data is reduced to the extremes per
 * pixel column, so every peak stays visible. Dispose the series when it is no longer drawn.
 */
export class LineSeries extends ChartSeries {
  private lineColor: Rgba8 = { r: 80, g: 170, b: 240, a: 255 };
  private lineThickness = 1.5;
  private dashes: readonly number[] | undefined;
  private step = false;
  private spline = false;
  private mode: ResamplingMode = 'auto';
  private readonly bucketMap = new Float64Array(6);
  private glow: number | undefined;
  private intensity = 0.6;
  private appearance = 0;
  private readonly resampler: SeriesResampler;
  private readonly ranges: DataRanges;
  private readonly view: DataSnapshot = emptySnapshot();
  private readonly line = new Vertices();
  private readonly other = new Vertices();
  private result: Vertices = this.line;
  private minima = new Float64Array(0);
  private maxima = new Float64Array(0);
  private indices = new Int32Array(0);
  private builtData = -1;
  private builtOptions = -1;
  private builtFrame: SeriesFrame | undefined;
  private styledHighlight = false;
  private uploadPending = false;
  private readonly gpu = new VertexBuffer();
  private style: PolylineStyle | undefined;

  constructor(
    /** The data. */
    readonly source: PointSource,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
    this.resampler = new SeriesResampler(source);
    this.ranges = new DataRanges(source);
  }

  /** The color of the line. */
  get color(): Rgba8 {
    return this.lineColor;
  }

  set color(value: Rgba8) {
    this.lineColor = value;
    this.changed();
  }

  /** The thickness in device-independent units. */
  get thickness(): number {
    return this.lineThickness;
  }

  set thickness(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`The thickness must be positive and finite, not ${String(value)}.`);
    }
    this.lineThickness = value;
    this.changed();
  }

  /** The lengths of dashes and spaces in turn, in device-independent units; `undefined` for a solid line. */
  get dashPattern(): readonly number[] | undefined {
    return this.dashes;
  }

  set dashPattern(value: readonly number[] | undefined) {
    if (value?.length === 0 || value?.some((length) => !Number.isFinite(length) || length <= 0)) {
      throw new RangeError('A pattern needs positive, finite lengths.');
    }
    this.dashes = value ? [...value] : undefined;
    this.changed();
  }

  /** Whether the line keeps each value until the next point. Columns of a reduced line stay as they are. */
  get isStep(): boolean {
    return this.step;
  }

  set isStep(value: boolean) {
    this.step = value;
    this.changed();
  }

  /** Whether the line runs as a smooth curve through its points; only lines that show all points. */
  get isSpline(): boolean {
    return this.spline;
  }

  set isSpline(value: boolean) {
    this.spline = value;
    this.changed();
  }

  /** How the line reduces its points; `auto` by default. */
  get resampling(): ResamplingMode {
    return this.mode;
  }

  set resampling(value: ResamplingMode) {
    this.mode = value;
    this.changed();
  }

  /** The reach of a glow in device-independent units; no glow when left out. */
  get glowRadius(): number | undefined {
    return this.glow;
  }

  set glowRadius(value: number | undefined) {
    this.glow = value;
    this.changed();
  }

  /** The strength of the glow, 0..1. */
  get glowIntensity(): number {
    return this.intensity;
  }

  set glowIntensity(value: number) {
    this.intensity = value;
    this.changed();
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.lineColor;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.source.version + this.appearance;
  }

  /** {@inheritDoc ChartSeries.drawnPointCount} */
  override get drawnPointCount(): number {
    return this.result.count;
  }

  /** {@inheritDoc ChartSeries.findPoint} */
  override findPoint(
    frame: SeriesFrame,
    pixelX: number,
    pixelY: number,
    maximumDistance: number,
    mode: HitTestMode,
  ): FoundPoint | undefined {
    return findNearest(this.source, originOf(this.xAxis), frame, pixelX, pixelY, maximumDistance, mode);
  }

  /** {@inheritDoc ChartSeries.collectPoints} */
  override collectPoints(frame: SeriesFrame, area: SelectionArea, indices: number[]): void {
    collectSourcePoints(this.source, originOf(this.xAxis), frame, area, indices);
  }

  /** {@inheritDoc ChartSeries.readPoint} */
  override readPoint(index: number): { x: number; y: number } | undefined {
    return readSourcePoint(this.source, originOf(this.xAxis), index);
  }

  /** {@inheritDoc ChartSeries.latestValue} */
  override latestValue(): number | undefined {
    const value = this.source.latest();
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  }

  /** {@inheritDoc ChartSeries.collectValueLabels} */
  override collectValueLabels(x: DoubleRange, y: DoubleRange, labels: ValueLabel[]): void {
    collectSourceLabels(this.source, originOf(this.xAxis), x, y, labels);
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    return this.ranges.of(axis, this.xAxis);
  }

  /** {@inheritDoc ChartSeries.prepareData} */
  override prepareData(frame: SeriesFrame): void {
    const version = this.source.version;
    if (version === this.builtData && this.appearance === this.builtOptions && frame === this.builtFrame) {
      return;
    }
    this.builtData = version;
    this.builtOptions = this.appearance;
    this.builtFrame = frame;
    this.uploadPending = true;
    this.build(frame);
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    this.prepareData(frame);
    // A highlighted line grows by 1.5 units, as in the .NET version; the style follows without a new upload.
    if (!this.uploadPending && this.styledHighlight === this.isHighlighted) {
      return;
    }
    if (this.uploadPending) {
      this.uploadPending = false;
      const line = this.result;
      if (line.count > 0) {
        this.gpu.ensure(device, line.count * 8).write(0, line.data.subarray(0, line.count * 2));
      }
    }
    this.styledHighlight = this.isHighlighted;
    const thickness = this.isHighlighted ? this.lineThickness + highlightGrowth : this.lineThickness;
    // The own glow of the line, otherwise the one of the theme.
    const radius = this.glow === undefined ? frame.glowRadius : f(this.glow * frame.dpiScale);
    const intensity = this.glow === undefined ? frame.glowIntensity : this.intensity;
    this.style = {
      widthInPixels: f(thickness * frame.dpiScale),
      color: this.lineColor,
      clip: frame.bounds,
      ...(radius > 0 ? { glowRadius: f(radius), glowIntensity: f(intensity) } : {}),
    };
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.dispose();
  }

  /** Frees the buffer on the GPU; the next frame makes it again. */
  dispose(): void {
    this.gpu.dispose();
    this.builtData = -1;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList): void {
    const buffer = this.gpu.buffer;
    if (this.result.count >= 2 && buffer && this.style) {
      commands.drawPolyline(buffer, 0, this.result.count, this.style);
    }
  }

  private changed(): void {
    this.appearance++;
  }

  // The vertices in pixels, without the GPU.
  private build(frame: SeriesFrame): void {
    this.line.clear();
    this.result = this.line;
    const columns = Math.max(Math.ceil(frame.bounds.width), 1);
    if (this.minima.length !== columns) {
      this.minima = new Float64Array(columns);
      this.maxima = new Float64Array(columns);
      this.indices = new Int32Array(columns * 2);
    }
    const origin = originOf(this.xAxis);
    const range = this.xAxis.visibleRange;
    const visible = origin === 0 ? range : new DoubleRange(range.min + origin, range.max + origin);
    if (this.source instanceof FifoDataSource && this.addBuckets(frame, visible, origin, columns)) {
      this.line.endRun();
      return;
    }
    const result = this.resampler.resample(visible, this.mode, this.minima, this.maxima, this.indices);
    // Taken after resampling: its indices are valid here, the source only grows behind them.
    const snapshot = this.source.snapshotInto(this.view);
    if (result.mode === 'minMax') {
      this.addColumns(frame);
    } else if (result.mode === 'lttb') {
      this.addSelection(snapshot, result.selectedCount, origin, frame);
    } else {
      this.addRange(snapshot, result.start, result.end, origin, frame);
    }
    this.line.endRun();
    this.shape(result.mode, frame);
  }

  // A ring of points reduced as the ring path of the .NET version does: buckets of a width of a power of two in data
  // units, each with its lowest and highest value in the order they came, spread over the bucket, so that a dense
  // signal fills its band. The positions go to pixels in float, as the GPU maps them from an anchor.
  private addBuckets(frame: SeriesFrame, visible: DoubleRange, origin: number, columns: number): boolean {
    const snapshot = this.source.snapshotInto(this.view);
    const { x, y, count } = snapshot;
    if (count === 0) {
      return false;
    }
    const first = lowerBound(x, count, visible.min);
    const last = upperBound(x, count, visible.max);
    const visibleCount = last - first;
    const usesBuckets = this.mode !== 'none' && (this.mode !== 'auto' || visibleCount > columns * 2);
    if (!usesBuckets) {
      return false;
    }
    const length = visible.max - visible.min;
    const exact = length / columns;
    const width = exact > 0 && Number.isFinite(exact) ? Math.pow(2, Math.floor(Math.log2(exact))) : 1;
    const requested = columns * 4 + 64;
    const slots = requested + Math.trunc(requested / 2);
    const start = Math.max(first - 1, 0);
    const limit = Math.min(count, last + 1 + Math.trunc(slots / 4));
    const anchorX = x[start] as number;
    const center = (this.yAxis.visibleRange.min + this.yAxis.visibleRange.max) / 2;
    const anchorY = Number.isFinite(center) ? center : 0;
    const scaleX = f(frame.x.toPixel(1) - frame.x.toPixel(0));
    const scaleY = f(frame.y.toPixel(1) - frame.y.toPixel(0));
    const offsetX = f(frame.x.toPixel(anchorX - origin));
    const offsetY = f(frame.y.toPixel(anchorY));
    // The mapping of the GPU, kept in fields so that the loop allocates nothing.
    this.bucketMap[0] = width;
    this.bucketMap[1] = offsetX;
    this.bucketMap[2] = offsetY;
    this.bucketMap[3] = scaleX;
    this.bucketMap[4] = scaleY;
    this.bucketMap[5] = anchorY;
    let bucket = Number.NaN;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    let lowAt = 0;
    let highAt = 0;
    for (let i = start; i < limit; i++) {
      const at = Math.floor(((x[i] as number) - anchorX) / width);
      if (at !== bucket) {
        if (!Number.isNaN(bucket)) {
          this.addBucket(bucket, low, high, lowAt <= highAt);
        }
        bucket = at;
        low = Number.POSITIVE_INFINITY;
        high = Number.NEGATIVE_INFINITY;
      }
      const value = y[i] as number;
      if (Number.isFinite(value)) {
        if (value < low) {
          low = value;
          lowAt = i;
        }
        if (value > high) {
          high = value;
          highAt = i;
        }
      }
    }
    if (!Number.isNaN(bucket)) {
      this.addBucket(bucket, low, high, lowAt <= highAt);
    }
    return true;
  }

  // A bucket: its extremes in the order they came, spread over its width; one without values is a gap.
  private addBucket(bucket: number, low: number, high: number, lowFirst: boolean): void {
    const map = this.bucketMap;
    const width = map[0] as number;
    const offsetX = map[1] as number;
    const offsetY = map[2] as number;
    const scaleX = map[3] as number;
    const scaleY = map[4] as number;
    const anchorY = map[5] as number;
    if (low > high) {
      this.line.addGap();
      return;
    }
    const from = lowFirst ? low : high;
    const to = lowFirst ? high : low;
    this.line.add(f(offsetX + f(f(bucket * width) * scaleX)), f(offsetY + f(f(from - anchorY) * scaleY)));
    this.line.add(f(offsetX + f(f((bucket + 1) * width) * scaleX)), f(offsetY + f(f(to - anchorY) * scaleY)));
  }

  private addSelection(snapshot: DataSnapshot, count: number, origin: number, frame: SeriesFrame): void {
    for (let i = 0; i < count; i++) {
      const index = this.indices[i] as number;
      this.addPoint(snapshot, index, i > 0 ? (this.indices[i - 1] as number) : index, origin, frame);
    }
  }

  // One point more on each side, so that the line leaves the plot area instead of ending inside.
  private addRange(snapshot: DataSnapshot, start: number, end: number, origin: number, frame: SeriesFrame): void {
    const first = Math.max(start - 1, 0);
    const last = Math.min(Math.min(end, snapshot.count) + 1, snapshot.count);
    for (let i = first; i < last; i++) {
      this.addPoint(snapshot, i, i > first ? i - 1 : i, origin, frame);
    }
  }

  // Curves and dashes on the line in pixels; reduced columns stay as they are.
  private shape(mode: ResampleResult['mode'], frame: SeriesFrame): void {
    if (mode === 'none' && this.spline && !this.step) {
      smoothRuns(this.line, this.other);
      this.result = this.other;
    }
    if (this.dashes && mode !== 'minMax') {
      const source = this.result;
      const target = source === this.line ? this.other : this.line;
      expandDashes(source, this.dashes, frame.dpiScale, frame.bounds, target);
      this.result = target;
    }
  }

  private addPoint(
    snapshot: DataSnapshot,
    index: number,
    previousIndex: number,
    origin: number,
    frame: SeriesFrame,
  ): void {
    const line = this.line;
    const value = snapshot.y[index] as number;
    const pixelX = f(frame.x.toPixel((snapshot.x[index] as number) - origin));
    const pixelY = f(frame.y.toPixel(value));
    // A value without a place on a logarithmic axis is a gap as well, and so is one beyond float in pixels, which
    // would reach the GPU as infinity (the .NET version checks it only in double).
    if (!Number.isFinite(value) || !Number.isFinite(pixelY) || !Number.isFinite(pixelX)) {
      line.addGap();
      return;
    }
    const previous = snapshot.y[previousIndex] as number;
    if (this.step && this.runLength(line) && Number.isFinite(previous) && Number.isFinite(frame.y.toPixel(previous))) {
      line.add(pixelX, f(frame.y.toPixel(previous)));
    }
    line.add(pixelX, pixelY);
  }

  private runLength(line: Vertices): boolean {
    return line.count > 0 && !line.isGap(line.count - 1);
  }

  // Each pixel column holds its lowest and highest value. The extreme nearer to where the line comes from goes first,
  // and both spread over the width of the column: a steady edge stays one slanted line.
  private addColumns(frame: SeriesFrame): void {
    addMinMaxColumns(this.line, this.minima, this.maxima, frame);
  }
}
