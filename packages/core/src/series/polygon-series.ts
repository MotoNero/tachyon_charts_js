// Polygons with holes filled and outlined, as PolygonSeries and PolygonCharts of the .NET version.
import type { Axis } from '../axes/axis';
import type { Polygon, PolygonRing } from '../data/polygon';
import { triangulate } from '../data/polygon';
import type { ChartBuilder } from '../fluent/chart-builder';
import type { FoundPoint } from '../hit-testing/types';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import { lineGap, type CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuBuffer } from '../render/resources';
import { BufferUsage, packRgba8, type Rgba8 } from '../render/types';
import { addFringe, Mesh } from './ribbon-series';

const f = Math.fround;

/** Polygons with holes: a fill in the colors of the palette or their own, and an outline. */
export class PolygonSeries extends ChartSeries {
  private readonly shapes: readonly Polygon[];
  private readonly mesh = new Mesh();
  private outline: number[] = [];
  private pointData = new Float32Array(0);
  private triangles: { x: number[]; y: number[]; triangles: number[] }[] | undefined;
  private palette: readonly Rgba8[] = [
    { r: 76, g: 201, b: 240, a: 255 },
    { r: 247, g: 37, b: 133, a: 255 },
    { r: 255, g: 190, b: 11, a: 255 },
    { r: 6, g: 214, b: 160, a: 255 },
  ];
  private buffer: GpuBuffer | undefined;
  private alpha = 170;
  private strokeColor: Rgba8 = { r: 255, g: 255, b: 255, a: 200 };
  private width = 1;
  private appearance = 0;
  private built = -1;
  private builtFrame: SeriesFrame | undefined;
  private readonly xRange: DoubleRange;
  private readonly yRange: DoubleRange;

  /**
   * @param polygons - The polygons, drawn in this order.
   * @param xAxis - The X axis.
   * @param yAxis - The Y axis.
   */
  constructor(polygons: readonly Polygon[], xAxis: Axis, yAxis: Axis) {
    super(xAxis, yAxis);
    this.shapes = [...polygons];
    let x = DoubleRange.empty;
    let y = DoubleRange.empty;
    for (const polygon of this.shapes) {
      for (let i = 0; i < polygon.outer.count; i++) {
        x = x.include(polygon.outer.x[i] as number);
        y = y.include(polygon.outer.y[i] as number);
      }
    }
    this.xRange = x;
    this.yRange = y;
  }

  /** The polygons. */
  get polygons(): readonly Polygon[] {
    return this.shapes;
  }

  /** The opacity of the fill, 0 to 255; 170 by default, 0 for outlines only. */
  get fillAlpha(): number {
    return this.alpha;
  }

  set fillAlpha(value: number) {
    this.alpha = Math.min(Math.max(Math.round(value), 0), 255);
    this.appearance++;
  }

  /** The color of the outline; a clear color for none. */
  get stroke(): Rgba8 {
    return this.strokeColor;
  }

  set stroke(value: Rgba8) {
    this.strokeColor = value;
    this.appearance++;
  }

  /** The thickness of the outline in device-independent units; 1 by default. */
  get thickness(): number {
    return this.width;
  }

  set thickness(value: number) {
    this.width = value;
    this.appearance++;
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.palette[0] as Rgba8;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.appearance;
  }

  /** {@inheritDoc ChartSeries.onPalette} */
  override onPalette(palette: readonly Rgba8[]): void {
    this.palette = [...palette];
    this.appearance++;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const range = axis === 'x' ? this.xRange : this.yRange;
    return range.isEmpty ? undefined : range;
  }

  /** {@inheritDoc ChartSeries.findPoint} */
  override findPoint(frame: SeriesFrame, pixelX: number, pixelY: number): FoundPoint | undefined {
    const x = frame.x.toData(pixelX);
    const y = frame.y.toData(pixelY);
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      if ((this.shapes[i] as Polygon).contains(x, y)) {
        return { index: i, x, y };
      }
    }
    return undefined;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    if (this.version === this.built && frame === this.builtFrame) {
      return;
    }
    this.triangles ??= this.shapes.map((polygon) => triangulate(polygon));
    this.mesh.clear();
    this.outline = [];
    this.shapes.forEach((polygon, p) => {
      this.addPolygon(frame, polygon, p);
    });
    if (this.outline.length >= 4) {
      if (this.pointData.length < this.outline.length) {
        this.pointData = new Float32Array(this.outline.length);
      }
      this.pointData.set(this.outline);
      const data = this.pointData.subarray(0, this.outline.length);
      if (!this.buffer || this.buffer.sizeInBytes < data.byteLength) {
        this.buffer?.dispose();
        this.buffer = device.createBuffer({ sizeInBytes: data.byteLength, usage: BufferUsage.vertex });
      }
      this.buffer.write(0, data);
    }
    this.built = this.version;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.mesh.count > 0) {
      commands.fillMesh(this.mesh.data, this.mesh.count, frame.bounds);
    }
    const count = this.outline.length / 2;
    if (this.buffer && count >= 2) {
      commands.drawPolyline(this.buffer, 0, count, {
        widthInPixels: f(this.width * frame.dpiScale),
        color: this.strokeColor,
        clip: frame.bounds,
      });
    }
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.buffer?.dispose();
    this.buffer = undefined;
    this.built = -1;
  }

  private addPolygon(frame: SeriesFrame, polygon: Polygon, p: number): void {
    const base =
      polygon.color && polygon.color.a > 0 ? polygon.color : (this.palette[p % this.palette.length] as Rgba8);
    const color = { ...base, a: this.alpha };
    if (this.alpha > 0) {
      const shape = (this.triangles as { x: number[]; y: number[]; triangles: number[] }[])[p] as {
        x: number[];
        y: number[];
        triangles: number[];
      };
      const packed = packRgba8(color);
      for (const corner of shape.triangles) {
        this.mesh.add(
          f(frame.x.toPixel(shape.x[corner] as number)),
          f(frame.y.toPixel(shape.y[corner] as number)),
          packed,
        );
      }
      // An outline draws a smooth line over the edge already.
      if (this.strokeColor.a === 0 || this.width <= 0) {
        this.addFringe(frame, polygon.outer, false, color);
        for (const hole of polygon.holes) {
          this.addFringe(frame, hole, true, color);
        }
      }
    }
    if (this.strokeColor.a > 0) {
      this.addRing(frame, polygon.outer);
      for (const hole of polygon.holes) {
        this.addRing(frame, hole);
      }
    }
  }

  // The filled side lies left of each edge when the ring turns positively, right otherwise; for a hole the other way.
  private addFringe(frame: SeriesFrame, ring: PolygonRing, isHole: boolean, color: Rgba8): void {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < ring.count; i++) {
      xs.push(f(frame.x.toPixel(ring.x[i] as number)));
      ys.push(f(frame.y.toPixel(ring.y[i] as number)));
    }
    let area = 0;
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      area += (xs[j] as number) * (ys[i] as number) - (xs[i] as number) * (ys[j] as number);
    }
    const isLeft = area > 0 !== isHole;
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      const a = { x: xs[j] as number, y: ys[j] as number, color };
      const b = { x: xs[i] as number, y: ys[i] as number, color };
      const alongX = f(b.x - a.x);
      const alongY = f(b.y - a.y);
      const leftX = f(-alongY);
      const leftY = alongX;
      const middleX = f(f(a.x + b.x) / 2);
      const middleY = f(f(a.y + b.y) / 2);
      addFringe(this.mesh, a, b, f(middleX + (isLeft ? leftX : -leftX)), f(middleY + (isLeft ? leftY : -leftY)));
    }
  }

  private addRing(frame: SeriesFrame, ring: PolygonRing): void {
    for (let i = 0; i <= ring.count; i++) {
      const k = i % ring.count;
      this.outline.push(f(frame.x.toPixel(ring.x[k] as number)), f(frame.y.toPixel(ring.y[k] as number)));
    }
    this.outline.push(lineGap, lineGap);
  }
}

/** Describes polygons on the axes of the chart. */
export function polygons(
  builder: ChartBuilder,
  shapes: readonly Polygon[],
  configure?: (series: PolygonSeries) => void,
): ChartBuilder {
  return builder.addSeries((x, y) => {
    const series = new PolygonSeries(shapes, x, y);
    configure?.(series);
    return series;
  });
}
