// Series of marks at measured points: stems from a baseline and error bars (MarkSeries, StemSeries and ErrorBarSeries
// of the .NET version). The lines are rectangles on whole pixels, the heads round markers.
import type { Axis } from '../axes/axis';
import type { PointSource } from '../data/source';
import { collectSourceLabels } from '../hit-testing/hit-test';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { ValueLabel } from '../pipeline/value-label';
import type { CommandList, MarkerStyle } from '../render/commands';
import type { RenderDevice } from '../render/device';
import { packRgba8, type Rgba8 } from '../render/types';
import { originOf } from './line-series';
import { Mesh } from './ribbon-series';
import { VertexBuffer } from './vertices';

const f = Math.fround;

// Rounds halves to the even neighbour, as the float rounding of the .NET version does.
function roundEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  return f(rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor);
}

const clear: Rgba8 = { r: 0, g: 0, b: 0, a: 0 };

/** Marks at the points of a source: lines as rectangles on whole pixels and round heads. */
export abstract class MarkSeries extends ChartSeries {
  private markColor: Rgba8 = { r: 80, g: 170, b: 240, a: 255 };
  private lineThickness = 1;
  private appearance = 0;
  private readonly mesh = new Mesh();
  private heads = new Float32Array(0);
  private headCount = 0;
  private builtVersion = -1;
  private builtFrame: SeriesFrame | undefined;
  private device: RenderDevice | undefined;
  private readonly gpu = new VertexBuffer();

  /**
   * @param source - The points.
   * @param xAxis - The X axis.
   * @param yAxis - The Y axis.
   */
  constructor(
    /** The points. */
    readonly source: PointSource,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** The color of the lines and heads. */
  get color(): Rgba8 {
    return this.markColor;
  }

  set color(value: Rgba8) {
    this.markColor = value;
    this.changed();
  }

  /**
   * The thickness of the lines in device-independent units; 1 by default.
   * @throws RangeError for a thickness of 0 or below.
   */
  get thickness(): number {
    return this.lineThickness;
  }

  set thickness(value: number) {
    if (!(value > 0)) {
      throw new RangeError(`The thickness must be above 0, not ${String(value)}.`);
    }
    this.lineThickness = value;
    this.changed();
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.markColor;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.source.version + this.appearance;
  }

  /** {@inheritDoc ChartSeries.collectValueLabels} */
  override collectValueLabels(x: DoubleRange, y: DoubleRange, labels: ValueLabel[]): void {
    collectSourceLabels(this.source, originOf(this.xAxis), x, y, labels);
  }

  /** Marks the appearance as changed, so that the next frame builds the marks again. */
  protected changed(): void {
    this.appearance++;
  }

  /** Builds the marks of the frame with {@link MarkSeries.addRectangle} and {@link MarkSeries.addHead}. */
  protected abstract build(frame: SeriesFrame): void;

  /** Adds a rectangle in pixels, on whole pixels and at least one pixel wide and high. */
  protected addRectangle(left: number, top: number, right: number, bottom: number): void {
    // On whole pixels: without edge smoothing, the renderers agree only there.
    const l = roundEven(left);
    const t = roundEven(top);
    const r = Math.max(roundEven(right), l + 1);
    const b = Math.max(roundEven(bottom), t + 1);
    const color = packRgba8(this.markColor);
    for (const [x, y] of [
      [l, t],
      [r, t],
      [r, b],
      [l, t],
      [r, b],
      [l, b],
    ] as const) {
      this.mesh.add(x, y, color);
    }
  }

  /** Adds a round head at a point in pixels. */
  protected addHead(x: number, y: number, diameter: number): void {
    if (this.heads.length < (this.headCount + 1) * 4) {
      const grown = new Float32Array(Math.max(64, this.heads.length * 2));
      grown.set(this.heads);
      this.heads = grown;
    }
    const at = this.headCount * 4;
    this.heads[at] = x;
    this.heads[at + 1] = y;
    this.heads[at + 2] = diameter;
    new Uint32Array(this.heads.buffer)[at + 3] = packRgba8(this.markColor);
    this.headCount++;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    if (this.device !== device) {
      this.gpu.dispose();
      this.device = device;
      this.builtVersion = -1;
    }
    const version = this.version;
    if (version === this.builtVersion && frame === this.builtFrame) {
      return;
    }
    this.mesh.clear();
    this.headCount = 0;
    this.build(frame);
    if (this.headCount > 0) {
      this.gpu.ensure(device, this.headCount * 16).write(0, this.heads.subarray(0, this.headCount * 4));
    }
    this.builtVersion = version;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.mesh.count > 0) {
      commands.fillMesh(this.mesh.data, this.mesh.count, frame.bounds);
    }
    const buffer = this.gpu.buffer;
    if (this.headCount > 0 && buffer) {
      const style: MarkerStyle = { shape: 'circle', borderWidthInPixels: 0, borderColor: clear, clip: frame.bounds };
      commands.drawMarkers(buffer, 0, this.headCount, style);
    }
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.dispose();
  }

  /** Frees the buffer on the GPU; the next frame makes it again. */
  dispose(): void {
    this.gpu.dispose();
    this.device = undefined;
    this.builtVersion = -1;
  }
}

/** Stems: a line from a baseline to each point with a round head, as for samples of a signal. */
export class StemSeries extends MarkSeries {
  private base = 0;
  private head = 6;

  /** The value the stems start from; 0 by default. */
  get baseline(): number {
    return this.base;
  }

  set baseline(value: number) {
    this.base = value;
    this.changed();
  }

  /**
   * The diameter of the heads in device-independent units; 6 by default, 0 for none.
   * @throws RangeError for a negative size.
   */
  get headSize(): number {
    return this.head;
  }

  set headSize(value: number) {
    if (!(value >= 0)) {
      throw new RangeError(`The size of the heads must be 0 or above, not ${String(value)}.`);
    }
    this.head = value;
    this.changed();
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const metadata = this.source.metadata;
    if (metadata.count === 0) {
      return undefined;
    }
    if (axis === 'x') {
      return metadata.xRange;
    }
    return metadata.yRange.isEmpty ? metadata.yRange : metadata.yRange.union(new DoubleRange(this.base, this.base));
  }

  /** {@inheritDoc MarkSeries.build} */
  protected build(frame: SeriesFrame): void {
    const snapshot = this.source.snapshot();
    const half = f((this.thickness * frame.dpiScale) / 2);
    const radius = f((this.head * frame.dpiScale) / 2);
    const start = f(frame.y.toPixel(this.base));
    for (let i = 0; i < snapshot.count; i++) {
      const x = roundEven(f(frame.x.toPixel(snapshot.x[i] as number)));
      const y = f(frame.y.toPixel(snapshot.y[i] as number));
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(start)) {
        this.addRectangle(f(x - half), Math.min(start, y), f(x + half), Math.max(start, y));
        if (radius > 0) {
          this.addHead(x, y, f(radius * 2));
        }
      }
    }
  }
}

/** Error bars: a measured value with its error below and above, a line with caps and a point at the value. */
export class ErrorBarSeries extends MarkSeries {
  private lowerErrors: ArrayLike<number>;
  private upperErrors: ArrayLike<number>;
  private cap = 8;
  private point = 5;

  /**
   * @param source - The measured values.
   * @param lower - The error below each value.
   * @param upper - The error above each value.
   * @param xAxis - The X axis.
   * @param yAxis - The Y axis.
   */
  constructor(source: PointSource, lower: ArrayLike<number>, upper: ArrayLike<number>, xAxis: Axis, yAxis: Axis) {
    super(source, xAxis, yAxis);
    this.lowerErrors = lower;
    this.upperErrors = upper;
  }

  /**
   * The width of the caps in device-independent units; 8 by default, 0 for none.
   * @throws RangeError for a negative width.
   */
  get capWidth(): number {
    return this.cap;
  }

  set capWidth(value: number) {
    if (!(value >= 0)) {
      throw new RangeError(`The width of the caps must be 0 or above, not ${String(value)}.`);
    }
    this.cap = value;
    this.changed();
  }

  /**
   * The diameter of the point at the value in device-independent units; 5 by default, 0 for none.
   * @throws RangeError for a negative size.
   */
  get pointSize(): number {
    return this.point;
  }

  set pointSize(value: number) {
    if (!(value >= 0)) {
      throw new RangeError(`The size of the points must be 0 or above, not ${String(value)}.`);
    }
    this.point = value;
    this.changed();
  }

  /** Replaces the errors below and above the values. */
  setErrors(lower: ArrayLike<number>, upper: ArrayLike<number>): void {
    this.lowerErrors = lower;
    this.upperErrors = upper;
    this.changed();
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    if (axis === 'x') {
      return this.source.metadata.count === 0 ? undefined : this.source.metadata.xRange;
    }
    const snapshot = this.source.snapshot();
    const count = Math.min(snapshot.count, this.lowerErrors.length, this.upperErrors.length);
    let range = DoubleRange.empty;
    for (let i = 0; i < count; i++) {
      const value = snapshot.y[i] as number;
      const low = value - (this.lowerErrors[i] as number);
      const high = value + (this.upperErrors[i] as number);
      if (Number.isFinite(low) && Number.isFinite(high)) {
        range = range.union(new DoubleRange(Math.min(low, high), Math.max(low, high)));
      }
    }
    return range.isEmpty ? undefined : range;
  }

  /** {@inheritDoc MarkSeries.build} */
  protected build(frame: SeriesFrame): void {
    const snapshot = this.source.snapshot();
    const half = f((this.thickness * frame.dpiScale) / 2);
    const capHalf = f((this.cap * frame.dpiScale) / 2);
    const radius = f((this.point * frame.dpiScale) / 2);
    const count = Math.min(snapshot.count, this.lowerErrors.length, this.upperErrors.length);
    for (let i = 0; i < count; i++) {
      const value = snapshot.y[i] as number;
      const x = roundEven(f(frame.x.toPixel(snapshot.x[i] as number)));
      const y = f(frame.y.toPixel(value));
      const low = f(frame.y.toPixel(value - (this.lowerErrors[i] as number)));
      const high = f(frame.y.toPixel(value + (this.upperErrors[i] as number)));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(low) || !Number.isFinite(high)) {
        continue;
      }
      this.addRectangle(f(x - half), Math.min(low, high), f(x + half), Math.max(low, high));
      if (capHalf > 0) {
        this.addRectangle(f(x - capHalf), f(low - half), f(x + capHalf), f(low + half));
        this.addRectangle(f(x - capHalf), f(high - half), f(x + capHalf), f(high + half));
      }
      if (radius > 0) {
        this.addHead(x, y, f(radius * 2));
      }
    }
  }
}
