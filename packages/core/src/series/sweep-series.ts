// The sweep of a patient monitor: samples of several channels written into a window that the trace sweeps over from
// the left, as SweepData, SweepSeries and SweepCharts of the .NET version.
import type { Axis } from '../axes/axis';
import type { ChartBuilder } from '../fluent/chart-builder';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import { lineGap, type CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuBuffer } from '../render/resources';
import { BufferUsage, type Rgba8 } from '../render/types';

const f = Math.fround;
const mostColumns = 8192;

/**
 * How the trace fills the window: `sweep` writes over the previous page from the left with a gap ahead of the trace,
 * `stepping` clears the window when the trace reaches the right edge.
 */
export type SweepMode = 'sweep' | 'stepping';

/** A ring of samples of several channels over time, shown in a window of fixed length. */
export class SweepData {
  private readonly times: Float64Array;
  private readonly values: Float32Array;
  private count = 0;
  private next = 0;
  private windowLength = 1;
  private gap = 0.03;
  private sweepMode: SweepMode = 'sweep';
  private changes = 0;

  /**
   * @param channels - The number of channels, at least 1.
   * @param capacity - The samples kept, at least 2.
   * @param window - The seconds of the window.
   * @throws RangeError for fewer channels or samples, or a window that is not positive.
   */
  constructor(
    /** The number of channels. */
    readonly channels: number,
    /** The samples kept. */
    readonly capacity: number,
    window: number,
  ) {
    if (!Number.isInteger(channels) || channels < 1) {
      throw new RangeError('A sweep needs at least one channel.');
    }
    if (!Number.isInteger(capacity) || capacity < 2) {
      throw new RangeError('A sweep keeps at least two samples.');
    }
    this.times = new Float64Array(capacity);
    this.values = new Float32Array(capacity * channels);
    this.window = window;
  }

  /** Grows with every change. */
  get version(): number {
    return this.changes;
  }

  /** The seconds of the window. */
  get window(): number {
    return this.windowLength;
  }

  set window(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError('The window must be positive and finite.');
    }
    this.windowLength = value;
    this.changes++;
  }

  /** The share of the window left free ahead of the trace in sweep mode; 0.03 by default, at most 0.5. */
  get gapShare(): number {
    return this.gap;
  }

  set gapShare(value: number) {
    if (!(value >= 0 && value <= 0.5)) {
      throw new RangeError('The gap must lie between 0 and 0.5.');
    }
    this.gap = value;
    this.changes++;
  }

  /** How the trace fills the window; sweep by default. */
  get mode(): SweepMode {
    return this.sweepMode;
  }

  set mode(value: SweepMode) {
    this.sweepMode = value;
    this.changes++;
  }

  /** The time of the newest sample; NaN before the first. */
  get head(): number {
    return this.count === 0 ? Number.NaN : (this.times[(this.next - 1 + this.capacity) % this.capacity] as number);
  }

  /**
   * Adds samples: one time each and the values of all channels, sample after sample.
   * @throws RangeError when the values do not match the times, or a time is not finite or goes back.
   */
  append(times: number | ArrayLike<number>, values: ArrayLike<number>): void {
    const list = typeof times === 'number' ? [times] : times;
    if (values.length !== list.length * this.channels) {
      throw new RangeError(`${String(list.length)} samples need ${String(list.length * this.channels)} values.`);
    }
    for (let i = 0; i < list.length; i++) {
      this.write(list[i] as number, values, i * this.channels);
    }
    this.changes++;
  }

  /** Forgets all samples. */
  clear(): void {
    this.count = 0;
    this.next = 0;
    this.changes++;
  }

  /**
   * @internal The lowest and highest value of a channel in each column of the window; NaN where there is none.
   * @returns The column of the head, -1 without samples.
   */
  collect(channel: number, columns: number, low: Float32Array, high: Float32Array): number {
    low.fill(Number.NaN, 0, columns);
    high.fill(Number.NaN, 0, columns);
    if (this.count === 0) {
      return -1;
    }
    const window = this.windowLength;
    const head = this.head;
    const start = Math.floor(head / window) * window;
    const headColumn = Math.min(columns - 1, Math.trunc(((head - start) / window) * columns));
    const gapColumns = Math.ceil(this.gap * columns);
    // The current page up to the head; in sweep mode also the previous page behind the gap.
    const oldest = this.sweepMode === 'stepping' ? start : head - window;
    for (let n = 0; n < this.count; n++) {
      const index = (this.next - 1 - n + this.capacity) % this.capacity;
      const time = this.times[index] as number;
      if (time < oldest) {
        break;
      }
      const isCurrent = time >= start;
      const column = Math.min(
        Math.max(Math.trunc(((time - (isCurrent ? start : start - window)) / window) * columns), 0),
        columns - 1,
      );
      if (!isCurrent && column <= headColumn + gapColumns) {
        continue;
      }
      const value = this.values[index * this.channels + channel] as number;
      const lowest = low[column] as number;
      if (Number.isNaN(lowest) || value < lowest) {
        low[column] = value;
      }
      const highest = high[column] as number;
      if (Number.isNaN(highest) || value > highest) {
        high[column] = value;
      }
    }
    return headColumn;
  }

  private write(time: number, values: ArrayLike<number>, offset: number): void {
    if (!Number.isFinite(time) || (this.count > 0 && time < this.head)) {
      throw new RangeError('The times must be finite and in order.');
    }
    this.times[this.next] = time;
    for (let c = 0; c < this.channels; c++) {
      this.values[this.next * this.channels + c] = values[offset + c] as number;
    }
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }
}

/** One channel of a sweep as a line over the window. */
export class SweepSeries extends ChartSeries {
  private readonly points: number[] = [];
  private pointData = new Float32Array(0);
  private low = new Float32Array(256);
  private high = new Float32Array(256);
  private buffer: GpuBuffer | undefined;
  private stroke: Rgba8 = { r: 6, g: 214, b: 160, a: 255 };
  private width = 1.5;
  private appearance = 0;
  private built = -1;
  private builtFrame: SeriesFrame | undefined;

  /**
   * @param data - The samples.
   * @param channel - The channel, from 0.
   * @param xAxis - The axis of the window, 0 to its length.
   * @param yAxis - The axis of the values.
   * @throws RangeError for a channel the data does not have.
   */
  constructor(
    /** The samples. */
    readonly data: SweepData,
    /** The channel, from 0. */
    readonly channel: number,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
    if (!Number.isInteger(channel) || channel < 0 || channel >= data.channels) {
      throw new RangeError('The sweep has no such channel.');
    }
  }

  /** The color of the line; the theme sets it from its palette. */
  get color(): Rgba8 {
    return this.stroke;
  }

  set color(value: Rgba8) {
    this.stroke = value;
    this.appearance++;
  }

  /** The thickness of the line in device-independent units; 1.5 by default. */
  get thickness(): number {
    return this.width;
  }

  set thickness(value: number) {
    this.width = value;
    this.appearance++;
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.stroke;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.data.version + this.appearance;
  }

  /** {@inheritDoc ChartSeries.onPalette} */
  override onPalette(palette: readonly Rgba8[]): void {
    this.color = palette[this.channel % palette.length] as Rgba8;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(): DoubleRange | undefined {
    return undefined;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    if (this.version === this.built && frame === this.builtFrame) {
      return;
    }
    this.build(frame);
    const count = this.points.length / 2;
    if (count >= 2) {
      if (this.pointData.length < this.points.length) {
        this.pointData = new Float32Array(Math.max(this.points.length, 1024));
      }
      this.pointData.set(this.points);
      const data = this.pointData.subarray(0, this.points.length);
      if (!this.buffer || this.buffer.sizeInBytes < data.byteLength) {
        this.buffer?.dispose();
        this.buffer = device.createBuffer({
          sizeInBytes: Math.max(data.byteLength, 4096),
          usage: BufferUsage.vertex,
        });
      }
      this.buffer.write(0, data);
    }
    this.built = this.version;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    const count = this.points.length / 2;
    if (this.buffer && count >= 2) {
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
    this.built = -1;
  }

  // Each column of the window: its lowest and highest value, both on the column, so steep edges stay whole. The
  // extreme nearer to where the line comes from goes first; always low before high would draw a saw tooth on falling
  // edges. Both extremes spread over the width of the column, the first at its left and the second at its right
  // edge: a steady edge then becomes one slanted line instead of a staircase.
  private build(frame: SeriesFrame): void {
    this.points.length = 0;
    const columns = Math.min(Math.max(Math.trunc(frame.bounds.width), 2), mostColumns);
    if (this.low.length < columns) {
      this.low = new Float32Array(columns);
      this.high = new Float32Array(columns);
    }
    if (this.data.collect(this.channel, columns, this.low, this.high) < 0) {
      return;
    }
    const window = this.data.window;
    let isOpen = false;
    let last = 0;
    for (let column = 0; column < columns; column++) {
      const lowValue = this.low[column] as number;
      if (Number.isNaN(lowValue)) {
        if (isOpen) {
          this.points.push(lineGap, lineGap);
          isOpen = false;
        }
        continue;
      }
      const x = f(frame.x.toPixel(((column + 0.5) * window) / columns));
      const low = f(frame.y.toPixel(lowValue));
      const high = f(frame.y.toPixel(this.high[column] as number));
      const highFirst = isOpen && Math.abs(f(last - high)) < Math.abs(f(last - low));
      const first = highFirst ? high : low;
      const second = highFirst ? low : high;
      if (second === first) {
        this.points.push(x, first);
      } else {
        const half = f(
          f(frame.x.toPixel(((column + 1) * window) / columns) - frame.x.toPixel((column * window) / columns)) / 2,
        );
        this.points.push(f(x - half), first, f(x + half), second);
      }
      last = second;
      isOpen = true;
    }
  }
}

/**
 * Describes a monitor of sweeping traces: the window from 0 to its length below, one pane per channel with its range
 * and title.
 * @throws RangeError when not every channel has a range.
 */
export function sweep(
  builder: ChartBuilder,
  data: SweepData,
  ranges: readonly DoubleRange[],
  titles?: readonly string[],
): ChartBuilder {
  if (ranges.length !== data.channels) {
    throw new RangeError('Every channel needs a range.');
  }
  builder.xAxis((a) => a.numeric('sweep').range(0, data.window));
  ranges.forEach((range, index) => {
    const id = `channel${String(index)}`;
    builder.yAxis((a) => {
      a.numeric(id).range(range.min, range.max).pane(index);
      const title = titles?.[index];
      if (title !== undefined) {
        a.title(title);
      }
    });
    builder.addSeries((x, y) => new SweepSeries(data, index, x, y), undefined, id);
  });
  return builder;
}
