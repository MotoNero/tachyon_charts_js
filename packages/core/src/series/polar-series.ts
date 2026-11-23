// Points given by angle and radius, as PolarProjection and PolarSeries of the .NET version: 0 degrees point up, angles
// run clockwise, and the Y axis of the series is the radial axis.
import type { Axis } from '../axes/axis';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuBuffer } from '../render/resources';
import { BufferUsage, packRgba8, type Rgba8 } from '../render/types';
import { Mesh, SolidFill, type SeriesFill } from './ribbon-series';

const f = Math.fround;
const outerShare = 0.88;
const markerRadius = 3;
const gap = 1e30;

/** Maps angles and radii to a pane: 0 degrees up, angles clockwise. */
export class PolarProjection {
  /**
   * @param centerX - The middle, horizontally.
   * @param centerY - The middle, vertically.
   * @param radius - The radius of the outer circle.
   * @param range - The values from the middle to the outer circle.
   */
  constructor(
    /** The middle, horizontally. */
    readonly centerX: number,
    /** The middle, vertically. */
    readonly centerY: number,
    /** The radius of the outer circle. */
    readonly radius: number,
    /** The values from the middle to the outer circle. */
    readonly range: DoubleRange,
  ) {}

  /** The projection of an area: centered, the outer circle at 88 % of the shorter side. */
  static fit(x: number, y: number, width: number, height: number, range: DoubleRange): PolarProjection {
    return new PolarProjection(x + width / 2, y + height / 2, (Math.min(width, height) / 2) * outerShare, range);
  }

  /** The same projection with another radius. */
  withRadius(radius: number): PolarProjection {
    return new PolarProjection(this.centerX, this.centerY, radius, this.range);
  }

  /** A point; radii outside of the range stay at the middle or on the outer circle. */
  toPoint(angle: number, value: number): { x: number; y: number } {
    const range = this.range;
    const share = Math.min(Math.max((value - range.min) / (range.max - range.min), 0), 1);
    const radians = (angle * Math.PI) / 180;
    return {
      x: f(this.centerX + Math.sin(radians) * share * this.radius),
      y: f(this.centerY - Math.cos(radians) * share * this.radius),
    };
  }
}

/** What a polar series draws. */
export interface PolarParts {
  /** The area around the middle. */
  readonly area?: boolean;
  /** The line through the points. */
  readonly line?: boolean;
  /** A marker at each point. */
  readonly markers?: boolean;
}

/** Points given by angle in degrees and radius, in a chart of hidden axes with a polar grid. */
export class PolarSeries extends ChartSeries {
  private readonly angles: Float64Array;
  private readonly radii: Float64Array;
  private readonly mesh = new Mesh();
  private points: number[] = [];
  private buffer: GpuBuffer | undefined;
  private changes = 0;
  private builtVersion = -1;
  private builtFrame: SeriesFrame | undefined;
  private builtRange: DoubleRange | undefined;
  private drawnParts: PolarParts = { line: true };
  private closed = false;
  private stroke: Rgba8 = { r: 76, g: 201, b: 240, a: 255 };
  private areaFill: SeriesFill = new SolidFill({ r: 76, g: 201, b: 240, a: 80 });
  private width = 1.5;

  /**
   * @param angles - The angles in degrees.
   * @param values - The radii, one per angle.
   * @param xAxis - The hidden axis of the angle.
   * @param yAxis - The radial axis.
   * @throws RangeError when the numbers of angles and values differ.
   */
  constructor(angles: ArrayLike<number>, values: ArrayLike<number>, xAxis: Axis, yAxis: Axis) {
    super(xAxis, yAxis);
    if (angles.length !== values.length) {
      throw new RangeError('Every angle needs a value.');
    }
    this.angles = Float64Array.from(angles);
    this.radii = Float64Array.from(values);
  }

  /** A closed polygon with one corner per category, as a radar chart shows it. */
  static radar(values: ArrayLike<number>, xAxis: Axis, yAxis: Axis): PolarSeries {
    const angles = Array.from({ length: values.length }, (_, i) => (i * 360) / values.length);
    const series = new PolarSeries(angles, values, xAxis, yAxis);
    series.isClosed = true;
    series.parts = { area: true, line: true, markers: true };
    return series;
  }

  /** What is drawn; the line by default. */
  get parts(): PolarParts {
    return this.drawnParts;
  }

  set parts(value: PolarParts) {
    this.drawnParts = { ...value };
    this.changes++;
  }

  /** Whether the last point connects to the first. */
  get isClosed(): boolean {
    return this.closed;
  }

  set isClosed(value: boolean) {
    this.closed = value;
    this.changes++;
  }

  /** The color of the line and the markers. */
  get color(): Rgba8 {
    return this.stroke;
  }

  set color(value: Rgba8) {
    this.stroke = value;
    this.changes++;
  }

  /** The fill of the area. */
  get fill(): SeriesFill {
    return this.areaFill;
  }

  set fill(value: SeriesFill) {
    this.areaFill = value;
    this.changes++;
  }

  /** The thickness of the line in device-independent units; 1.5 by default. */
  get thickness(): number {
    return this.width;
  }

  set thickness(value: number) {
    this.width = value;
    this.changes++;
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.stroke;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.changes;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    if (this.radii.length === 0) {
      return undefined;
    }
    if (axis === 'x') {
      return new DoubleRange(0, 360);
    }
    let low = 0;
    let high = 0;
    for (const value of this.radii) {
      if (Number.isFinite(value)) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
    return new DoubleRange(low, high);
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    const range = this.yAxis.visibleRange;
    if (this.builtVersion === this.changes && this.builtFrame === frame && this.builtRange === range) {
      return;
    }
    const bounds = frame.bounds;
    this.build(PolarProjection.fit(bounds.x, bounds.y, bounds.width, bounds.height, range));
    if (this.points.length >= 4) {
      const data = Float32Array.from(this.points);
      if (!this.buffer || this.buffer.sizeInBytes < data.byteLength) {
        this.buffer?.dispose();
        this.buffer = device.createBuffer({ sizeInBytes: data.byteLength, usage: BufferUsage.vertex });
      }
      this.buffer.write(0, data);
    }
    this.builtVersion = this.changes;
    this.builtFrame = frame;
    this.builtRange = range;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.mesh.count > 0) {
      commands.fillMesh(this.mesh.data, this.mesh.count, frame.bounds);
    }
    const count = this.points.length / 2;
    if (this.buffer && count >= 2 && this.drawnParts.line === true) {
      commands.drawPolyline(this.buffer, 0, count, {
        widthInPixels: f(this.width * frame.dpiScale),
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

  private build(projection: PolarProjection): void {
    this.mesh.clear();
    this.points = [];
    const center = { x: f(projection.centerX), y: f(projection.centerY) };
    let previous = { x: 0, y: 0 };
    let first = { x: 0, y: 0 };
    let previousValue = 0;
    let hasPrevious = false;
    for (let i = 0; i < this.angles.length; i++) {
      const angle = this.angles[i] as number;
      const value = this.radii[i] as number;
      if (!Number.isFinite(value) || !Number.isFinite(angle)) {
        this.points.push(gap, gap);
        hasPrevious = false;
        continue;
      }
      const point = projection.toPoint(angle, value);
      this.points.push(point.x, point.y);
      if (hasPrevious) {
        this.addWedge(center, previous, point, previousValue, value, projection);
      } else if (i === 0) {
        first = point;
      }
      if (this.drawnParts.markers === true) {
        this.addMarker(point);
      }
      previous = point;
      previousValue = value;
      hasPrevious = true;
    }
    if (this.closed && hasPrevious && this.angles.length > 2 && Number.isFinite(this.radii[0])) {
      this.points.push(first.x, first.y);
      this.addWedge(center, previous, first, previousValue, this.radii[0] as number, projection);
    }
  }

  private addWedge(
    center: { x: number; y: number },
    start: { x: number; y: number },
    end: { x: number; y: number },
    startValue: number,
    endValue: number,
    projection: PolarProjection,
  ): void {
    if (this.drawnParts.area !== true) {
      return;
    }
    const height = projection.radius * 2;
    const top = projection.centerY - projection.radius;
    const color = (y: number, value: number): number => packRgba8(this.areaFill.colorAt(f((y - top) / height), value));
    this.mesh.add(center.x, center.y, color(center.y, projection.range.min));
    this.mesh.add(start.x, start.y, color(start.y, startValue));
    this.mesh.add(end.x, end.y, color(end.y, endValue));
  }

  private addMarker(point: { x: number; y: number }): void {
    const color = packRgba8(this.stroke);
    const corners = [
      [point.x, f(point.y - markerRadius)],
      [f(point.x + markerRadius), point.y],
      [point.x, f(point.y + markerRadius)],
      [f(point.x - markerRadius), point.y],
    ] as const;
    for (const index of [0, 1, 2, 0, 2, 3]) {
      const corner = corners[index] as readonly [number, number];
      this.mesh.add(corner[0], corner[1], color);
    }
  }
}
