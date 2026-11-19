// One marker for every finite point of a data source (ScatterSeries of the .NET version, without the density map,
// which comes with the color axis).
import type { Axis } from '../axes/axis';
import { emptySnapshot, type DataSnapshot, type PointSource } from '../data/source';
import type { DoubleRange } from '../numerics/range';
import type { CommandList, MarkerShape, MarkerStyle } from '../render/commands';
import type { RenderDevice } from '../render/device';
import { packRgba8, type Rgba8 } from '../render/types';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import { DataRanges, originOf, VertexBuffer } from './line-series';

const f = Math.fround;
const largest = 3.4028234663852886e38;
const shapes: readonly MarkerShape[] = ['circle', 'square', 'triangle', 'diamond', 'cross', 'plus'];

/**
 * One marker for every finite point of a data source. Colors and sizes per point are optional; when given, they have
 * as many entries as the source has points, and changing their content needs the property set again.
 */
export class ScatterSeries extends ChartSeries {
  private fillColor: Rgba8 = { r: 80, g: 170, b: 240, a: 255 };
  private outlineColor: Rgba8 = { r: 20, g: 50, b: 70, a: 255 };
  private diameter = 7;
  private outline = 1;
  private markerShape: MarkerShape = 'circle';
  private colors: readonly Rgba8[] | undefined;
  private sizes: ArrayLike<number> | undefined;
  private appearance = 0;
  private instancesChanged = 0;
  private readonly view: DataSnapshot = emptySnapshot();
  private readonly ranges: DataRanges;
  private instances = new Float32Array(0);
  private count = 0;
  private uploadedData = -1;
  private uploadedInstances = -1;
  private device: RenderDevice | undefined;
  private readonly gpu = new VertexBuffer();

  constructor(
    readonly source: PointSource,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
    this.ranges = new DataRanges(source);
  }

  /** The fill color of all markers without colors per point. */
  get color(): Rgba8 {
    return this.fillColor;
  }

  set color(value: Rgba8) {
    this.fillColor = value;
    this.instanceChanged();
  }

  /** The diameter in device-independent units of markers without sizes per point. */
  get size(): number {
    return this.diameter;
  }

  set size(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`The marker size must be positive and finite, not ${String(value)}.`);
    }
    this.diameter = value;
    this.instanceChanged();
  }

  /** The shape of the markers. */
  get shape(): MarkerShape {
    return this.markerShape;
  }

  set shape(value: MarkerShape) {
    if (!shapes.includes(value)) {
      throw new RangeError(`"${value}" is no marker shape.`);
    }
    this.markerShape = value;
    this.appearance++;
  }

  /** The width of the border in device-independent units; 0 for none. */
  get borderThickness(): number {
    return this.outline;
  }

  set borderThickness(value: number) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`The border thickness must be finite and not negative, not ${String(value)}.`);
    }
    this.outline = value;
    this.appearance++;
  }

  /** The color of the border. */
  get borderColor(): Rgba8 {
    return this.outlineColor;
  }

  set borderColor(value: Rgba8) {
    this.outlineColor = value;
    this.appearance++;
  }

  /** Fill colors per point; `undefined` uses {@link ScatterSeries.color}. */
  get pointColors(): readonly Rgba8[] | undefined {
    return this.colors;
  }

  set pointColors(value: readonly Rgba8[] | undefined) {
    this.colors = value;
    this.instanceChanged();
  }

  /** Diameters per point in device-independent units; `undefined` uses {@link ScatterSeries.size}. */
  get pointSizes(): ArrayLike<number> | undefined {
    return this.sizes;
  }

  set pointSizes(value: ArrayLike<number> | undefined) {
    this.sizes = value;
    this.instanceChanged();
  }

  override get accentColor(): Rgba8 {
    return this.fillColor;
  }

  get version(): number {
    return this.source.version + this.appearance + this.instancesChanged;
  }

  override get drawnPointCount(): number {
    return this.count;
  }

  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    return this.ranges.of(axis, this.xAxis);
  }

  override takeSnapshot(): void {
    this.source.snapshotInto(this.view);
  }

  override prepare(device: RenderDevice): void {
    const snapshot = this.view;
    if (
      this.device === device &&
      this.uploadedData === snapshot.version &&
      this.uploadedInstances === this.instancesChanged
    ) {
      return;
    }
    if (this.device !== device) {
      this.gpu.dispose();
      this.device = device;
    }
    this.fill(snapshot);
    if (this.count > 0) {
      this.gpu.ensure(device, this.count * 16).write(0, this.instances.subarray(0, this.count * 4));
    }
    this.uploadedData = snapshot.version;
    this.uploadedInstances = this.instancesChanged;
  }

  override releaseResources(): void {
    this.dispose();
  }

  /** Frees the buffer on the GPU; the next frame makes it again. */
  dispose(): void {
    this.gpu.dispose();
    this.device = undefined;
  }

  draw(commands: CommandList, frame: SeriesFrame): void {
    const buffer = this.gpu.buffer;
    if (!buffer || this.count === 0) {
      return;
    }
    const style: MarkerStyle = {
      shape: this.markerShape,
      borderWidthInPixels: f(this.outline * frame.dpiScale),
      borderColor: this.outlineColor,
      scaleX: f(frame.x.pixelsPerUnit),
      scaleY: f(frame.y.pixelsPerUnit),
      offsetX: f(frame.x.toPixelLinear(0)),
      offsetY: f(frame.y.toPixelLinear(0)),
      sizeScale: f(frame.dpiScale),
      clip: frame.bounds,
    };
    commands.drawMarkers(buffer, 0, this.count, style);
  }

  private instanceChanged(): void {
    this.instancesChanged++;
  }

  private fill(snapshot: DataSnapshot): void {
    const points = snapshot.count;
    if (this.colors && this.colors.length !== points) {
      throw new RangeError(`There are ${String(this.colors.length)} point colors for ${String(points)} points.`);
    }
    if (this.sizes && this.sizes.length !== points) {
      throw new RangeError(`There are ${String(this.sizes.length)} point sizes for ${String(points)} points.`);
    }
    if (this.instances.length < points * 4) {
      this.instances = new Float32Array(points * 4);
    }
    const words = new Uint32Array(this.instances.buffer);
    const origin = originOf(this.xAxis);
    const scaleX = this.xAxis.scaling;
    const scaleY = this.yAxis.scaling;
    const fallback = packRgba8(this.fillColor);
    this.count = 0;
    for (let i = 0; i < points; i++) {
      // The GPU maps linearly, so a nonlinear scale is part of the stored position.
      let x = (snapshot.x[i] as number) - origin;
      let y = snapshot.y[i] as number;
      x = scaleX ? scaleX.forward(x) : x;
      y = scaleY ? scaleY.forward(y) : y;
      const size = this.sizes ? f(this.sizes[i] as number) : f(this.diameter);
      if (!Number.isFinite(size) || size <= 0) {
        throw new RangeError(`Point size ${String(i)} must be positive and finite.`);
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > largest || Math.abs(y) > largest) {
        continue;
      }
      const at = this.count * 4;
      this.instances[at] = x;
      this.instances[at + 1] = y;
      this.instances[at + 2] = size;
      words[at + 3] = this.colors ? packRgba8(this.colors[i] as Rgba8) : fallback;
      this.count++;
    }
  }
}
