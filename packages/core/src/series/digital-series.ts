// A digital signal as levels and edges, as DigitalSeries of the .NET version: low and high at two values of the Y axis,
// so that many channels stand one above the other. However many points a view holds, each pixel column asks the source
// only for its level and whether the level changes inside it; a column with a change shows an edge, so no edge is
// lost. Narrow views draw every change.
import type { Axis } from '../axes/axis';
import type { DigitalSource } from '../data/digital';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { Rgba8 } from '../render/types';
import { originOf } from './line-series';
import { PixelLine } from './pixel-line';

/** A digital signal drawn as levels and edges. */
export class DigitalSeries extends ChartSeries {
  private lineColor: Rgba8 = { r: 110, g: 210, b: 130, a: 255 };
  private lineThickness = 1.5;
  private lowValue = 0;
  private highValue = 1;
  private appearance = 0;
  private readonly line = new PixelLine();
  private builtVersion = -1;
  private builtFrame: SeriesFrame | undefined;
  private builtRange: DoubleRange | undefined;

  /**
   * @param source - The signal.
   * @param xAxis - The X axis.
   * @param yAxis - The Y axis.
   */
  constructor(
    /** The signal. */
    readonly source: DigitalSource,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** The value of the Y axis for the low level; 0 by default. */
  get low(): number {
    return this.lowValue;
  }

  set low(value: number) {
    this.lowValue = value;
    this.appearance++;
  }

  /** The value of the Y axis for the high level; 1 by default. */
  get high(): number {
    return this.highValue;
  }

  set high(value: number) {
    this.highValue = value;
    this.appearance++;
  }

  /** The color of the line. */
  get color(): Rgba8 {
    return this.lineColor;
  }

  set color(value: Rgba8) {
    this.lineColor = value;
    this.appearance++;
  }

  /** The width of the line in device-independent units. */
  get thickness(): number {
    return this.lineThickness;
  }

  set thickness(value: number) {
    this.lineThickness = value;
    this.appearance++;
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
    return this.line.count;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const source = this.source;
    if (source.count === 0) {
      return undefined;
    }
    if (axis === 'y') {
      return new DoubleRange(Math.min(this.lowValue, this.highValue), Math.max(this.lowValue, this.highValue));
    }
    const origin = originOf(this.xAxis);
    return new DoubleRange(source.xStart - origin, source.xStart + (source.count - 1) * source.xStep - origin);
  }

  /** {@inheritDoc ChartSeries.prepareData} */
  override prepareData(frame: SeriesFrame): void {
    const range = this.xAxis.visibleRange;
    if (this.builtVersion === this.version && this.builtFrame === frame && this.builtRange === range) {
      return;
    }
    this.builtVersion = this.version;
    this.builtFrame = frame;
    this.builtRange = range;
    this.build(frame, range);
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    this.prepareData(frame);
    this.line.prepare(device, frame, this.lineColor, this.lineThickness);
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList): void {
    this.line.draw(commands);
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.line.dispose();
    this.builtVersion = -1;
  }

  private build(frame: SeriesFrame, range: DoubleRange): void {
    const source = this.source;
    this.line.clear();
    const count = source.count;
    if (count === 0 || !(source.xStep > 0)) {
      return;
    }
    const origin = originOf(this.xAxis);
    const first = clamp(Math.floor((range.min + origin - source.xStart) / source.xStep) - 1, 0, count - 1);
    const last = clamp(Math.ceil((range.max + origin - source.xStart) / source.xStep) + 2, first + 1, count);
    const columns = Math.max(Math.ceil(frame.bounds.width), 1);
    const low = frame.y.toPixel(this.lowValue);
    const high = frame.y.toPixel(this.highValue);
    const x = (index: number): number => frame.x.toPixel(source.xStart + index * source.xStep - origin);
    if (last - first <= columns * 2) {
      this.addChanges(first, last, x, low, high);
    } else {
      this.addColumns(first, last, columns, x, low, high);
    }
    this.line.end();
  }

  // Few points: every change as a step.
  private addChanges(first: number, last: number, x: (index: number) => number, low: number, high: number): void {
    const source = this.source;
    let level = source.levelAt(first);
    this.line.addPoint(x(first), level ? high : low);
    for (let change = source.nextChange(first + 1, last); change >= 0; change = source.nextChange(change + 1, last)) {
      const at = x(change);
      this.line.addPoint(at, level ? high : low);
      level = !level;
      this.line.addPoint(at, level ? high : low);
    }
    this.line.addPoint(x(last - 1), level ? high : low);
  }

  // Many points: each pixel column shows its level, and an edge when the level changes inside it.
  private addColumns(
    first: number,
    last: number,
    columns: number,
    x: (index: number) => number,
    low: number,
    high: number,
  ): void {
    const source = this.source;
    const span = last - first;
    const pick = (level: boolean): number => (level ? high : low);
    let pen = source.levelAt(first);
    this.line.addPoint(x(first), pick(pen));
    for (let column = 0; column < columns; column++) {
      const start = first + Math.floor((span * column) / columns);
      const end = first + Math.floor((span * (column + 1)) / columns);
      if (end <= start) {
        continue;
      }
      // A change right at the start of the column makes a step at its left edge.
      const level = source.levelAt(start);
      if (level !== pen) {
        const left = x(start);
        this.line.addPoint(left, pick(pen));
        this.line.addPoint(left, pick(level));
        pen = level;
      }
      if (source.nextChange(start + 1, end) < 0) {
        continue;
      }
      // Both levels inside: an edge over the column, ending at the level the column ends with; a pulse that returns
      // inside it is a pixel wide, so that the line never folds back on itself.
      const ending = source.levelAt(end - 1);
      const middle = x(start + Math.floor((end - start) / 2));
      if (ending === pen) {
        this.line.addPoint(middle - 0.5, pick(pen));
        this.line.addPoint(middle - 0.5, pick(!pen));
        this.line.addPoint(middle + 0.5, pick(!pen));
        this.line.addPoint(middle + 0.5, pick(pen));
      } else {
        this.line.addPoint(middle, pick(pen));
        this.line.addPoint(middle, pick(!pen));
      }
      pen = ending;
    }
    this.line.addPoint(x(last - 1), pick(pen));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
