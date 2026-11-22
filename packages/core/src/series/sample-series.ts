// Samples at the places 0, 1, 2 and so on, as box plots or violins, as SampleSeries, BoxPlotSeries and ViolinSeries of
// the .NET version: the shapes are triangles of one mesh, lines are rectangles of whole pixels.
import type { Axis } from '../axes/axis';
import { roundHalfEven } from '../numerics/nice';
import { DoubleRange } from '../numerics/range';
import { computeBoxStatistics, densityBandwidth, estimateDensity, finiteSorted } from '../numerics/statistics';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList } from '../render/commands';
import { packRgba8, type PixelRect, type Rgba8 } from '../render/types';
import { addRoundedRectangle } from './bar-series';
import { Mesh, SolidFill, type SeriesFill } from './ribbon-series';

const f = Math.fround;

/** Shapes of samples at the places 0, 1, 2 and so on, for a category axis or numbers. */
export abstract class SampleSeries extends ChartSeries {
  // The mesh of the shapes, rebuilt when the view or the look changes.
  private readonly mesh = new Mesh();
  private readonly sampleValues: readonly (readonly number[])[];
  private share = 0.6;
  private shapeFill: SeriesFill = new SolidFill({ r: 76, g: 201, b: 240, a: 170 });
  private line: Rgba8 = { r: 235, g: 240, b: 245, a: 255 };
  private changes = 0;
  private builtVersion = -1;
  private builtFrame: SeriesFrame | undefined;

  /**
   * @param samples - One sample per place.
   * @param xAxis - The horizontal axis.
   * @param yAxis - The vertical axis.
   */
  constructor(samples: readonly ArrayLike<number>[], xAxis: Axis, yAxis: Axis) {
    super(xAxis, yAxis);
    this.sampleValues = samples.map((sample) => Array.from(sample));
  }

  /** The samples. */
  get samples(): readonly (readonly number[])[] {
    return this.sampleValues;
  }

  /** The share of a place the shapes fill, from 0.05 to 1; 0.6 by default. */
  get width(): number {
    return this.share;
  }

  set width(value: number) {
    this.share = Math.min(Math.max(value, 0.05), 1);
    this.changes++;
  }

  /** The fill of the shapes. */
  get fill(): SeriesFill {
    return this.shapeFill;
  }

  set fill(value: SeriesFill) {
    this.shapeFill = value;
    this.changes++;
  }

  /** The color of the lines. */
  get lineColor(): Rgba8 {
    return this.line;
  }

  set lineColor(value: Rgba8) {
    this.line = value;
    this.changes++;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.changes;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    if (this.sampleValues.length === 0) {
      return undefined;
    }
    if (axis === 'x') {
      return new DoubleRange(-0.5, this.sampleValues.length - 0.5);
    }
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const sample of this.sampleValues) {
      for (const value of sample) {
        if (Number.isFinite(value)) {
          low = Math.min(low, value);
          high = Math.max(high, value);
        }
      }
    }
    return low <= high ? new DoubleRange(low, high) : undefined;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(_device: unknown, frame: SeriesFrame): void {
    if (this.version === this.builtVersion && frame === this.builtFrame) {
      return;
    }
    this.mesh.clear();
    this.build(frame);
    this.builtVersion = this.version;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.mesh.count > 0) {
      commands.fillMesh(this.mesh.data, this.mesh.count, frame.bounds);
    }
  }

  /** Adds the triangles of the shapes to the mesh. */
  protected abstract build(frame: SeriesFrame): void;

  /** Adds a corner of a triangle in pixels with its packed color. */
  protected addCorner(x: number, y: number, color: number): void {
    this.mesh.add(x, y, color);
  }

  /** Adds a filled rectangle in pixels, colored by the fill at the value. */
  protected addBox(rect: PixelRect, fill: SeriesFill, value: number, frame: SeriesFrame): void {
    addRoundedRectangle(this.mesh, rect, 0, frame.bounds, fill, value);
  }

  /** Adds a line of whole pixels, at least one device pixel thick. */
  protected addLine(frame: SeriesFrame, left: number, right: number, top: number, bottom: number): void {
    const thickness = Math.max(roundHalfEven(frame.dpiScale), 1);
    const x = f(roundHalfEven(left));
    const y = f(roundHalfEven(top));
    const width = Math.max(f(roundHalfEven(right) - x), thickness);
    const height = Math.max(f(roundHalfEven(bottom) - y), thickness);
    addRoundedRectangle(this.mesh, { x, y, width, height }, 0, frame.bounds, new SolidFill(this.line), 0);
  }
}

const outlierSize = 2;

/** Box plots: quartiles as a box, the median as a line, whiskers and outliers. */
export class BoxPlotSeries extends SampleSeries {
  /** {@inheritDoc SampleSeries.build} */
  protected build(frame: SeriesFrame): void {
    this.samples.forEach((sample, i) => {
      const statistics = computeBoxStatistics(sample);
      if (!statistics) {
        return;
      }
      const center = frame.x.toPixel(i);
      const half = (frame.x.toPixel(i + this.width) - center) / 2;
      const top = frame.y.toPixel(statistics.thirdQuartile);
      const bottom = frame.y.toPixel(statistics.firstQuartile);
      const median = frame.y.toPixel(statistics.median);
      const upper = frame.y.toPixel(statistics.upperWhisker);
      const lower = frame.y.toPixel(statistics.lowerWhisker);
      this.addLine(frame, center, center, upper, top);
      this.addLine(frame, center, center, bottom, lower);
      this.addLine(frame, center - half / 2, center + half / 2, upper, upper);
      this.addLine(frame, center - half / 2, center + half / 2, lower, lower);
      const left = f(roundHalfEven(center - half));
      const boxTop = f(roundHalfEven(Math.min(top, bottom)));
      this.addBox(
        {
          x: left,
          y: boxTop,
          width: f(f(roundHalfEven(center + half)) - left),
          height: f(f(roundHalfEven(Math.max(top, bottom))) - boxTop),
        },
        this.fill,
        statistics.median,
        frame,
      );
      this.addLine(frame, center - half, center + half, median, median);
      for (const outlier of statistics.outliers) {
        const y = frame.y.toPixel(outlier);
        this.addLine(frame, center - outlierSize, center + outlierSize, y - outlierSize, y + outlierSize);
      }
    });
  }
}

const steps = 64;
const tailBandwidths = 3;

/** Violin plots: the mirrored density of each sample, with a line at the median. */
export class ViolinSeries extends SampleSeries {
  /** {@inheritDoc SampleSeries.build} */
  protected build(frame: SeriesFrame): void {
    this.samples.forEach((sample, i) => {
      const values = sample.filter((value) => Number.isFinite(value));
      const bandwidth = densityBandwidth(values);
      if (!(bandwidth > 0)) {
        return;
      }
      const center = frame.x.toPixel(i);
      const half = (frame.x.toPixel(i + this.width) - center) / 2;
      const sorted = finiteSorted(values);
      const start = (sorted[0] as number) - tailBandwidths * bandwidth;
      const end = (sorted.at(-1) as number) + tailBandwidths * bandwidth;
      const densities = new Float64Array(steps + 1);
      for (let step = 0; step <= steps; step++) {
        densities[step] = estimateDensity(values, bandwidth, start + ((end - start) * step) / steps);
      }
      const peak = Math.max(...densities);
      const bounds = frame.bounds;
      for (let step = 0; step < steps; step++) {
        const low = start + ((end - start) * step) / steps;
        const high = start + ((end - start) * (step + 1)) / steps;
        const lowY = f(frame.y.toPixel(low));
        const highY = f(frame.y.toPixel(high));
        const lowHalf = (half * (densities[step] as number)) / peak;
        const highHalf = (half * (densities[step + 1] as number)) / peak;
        const lower = packRgba8(this.fill.colorAt(f(f(lowY - bounds.y) / bounds.height), low));
        const upper = packRgba8(this.fill.colorAt(f(f(highY - bounds.y) / bounds.height), high));
        const ax = f(center - lowHalf);
        const bx = f(center + lowHalf);
        const cx = f(center + highHalf);
        const dx = f(center - highHalf);
        this.addCorner(ax, lowY, lower);
        this.addCorner(bx, lowY, lower);
        this.addCorner(cx, highY, upper);
        this.addCorner(ax, lowY, lower);
        this.addCorner(cx, highY, upper);
        this.addCorner(dx, highY, upper);
      }
      const median = frame.y.toPixel(computeBoxStatistics(values)?.median ?? Number.NaN);
      this.addLine(frame, center - half * 0.4, center + half * 0.4, median, median);
    });
  }
}
