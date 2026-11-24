// Candles, OHLC bars and volume of a price, as CandleData, CandleSeries, VolumeSeries, CandleColumns,
// CandleReadoutOverlay, CandleModifier and FinanceCharts of the .NET version. Times are absolute in the unit of the
// time axis (milliseconds as in Date by default); the series place them relative to its origin.
import type { Axis } from '../axes/axis';
import type { ChartBuilder } from '../fluent/chart-builder';
import type { FoundPoint } from '../hit-testing/types';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import type { PointerInputEvent } from '../input/primitives';
import { chartText } from '../locale/culture';
import { formatGeneral } from '../locale/format';
import { roundHalfEven } from '../numerics/nice';
import { DoubleRange } from '../numerics/range';
import type { LinearAxisTransform } from '../numerics/transform';
import { ChartOverlay, type OverlayCanvas } from '../overlays/chart-overlay';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import { packRgba8, type Rgba8 } from '../render/types';
import { originOf } from './line-series';
import { Mesh } from './ribbon-series';

const f = Math.fround;
const minimumCapacity = 64;
// Below this many pixels per period, periods are merged into columns of this width.
const columnPixels = 3;

/** One period of a price. */
export interface Candle {
  /** The start of the period in the unit of the time axis. */
  readonly time: number;
  /** The first price. */
  readonly open: number;
  /** The highest price. */
  readonly high: number;
  /** The lowest price. */
  readonly low: number;
  /** The last price. */
  readonly close: number;
  /** The volume traded. */
  readonly volume: number;
}

/** Candles in the order of time, growing at the end; the last one may change while its period runs. */
export class CandleData {
  /** @internal The times. */
  time: Float64Array;
  /** @internal The first prices. */
  open: Float64Array;
  /** @internal The highest prices. */
  high: Float64Array;
  /** @internal The lowest prices. */
  low: Float64Array;
  /** @internal The last prices. */
  close: Float64Array;
  /** @internal The volumes. */
  volumes: Float64Array;
  /** @internal The lowest low. */
  lowestLow = Number.POSITIVE_INFINITY;
  /** @internal The highest high. */
  highestHigh = Number.NEGATIVE_INFINITY;
  /** @internal The largest volume. */
  mostVolume = 0;
  private size = 0;
  private changes = 0;

  /** @param capacity - The candles room is made for at first. */
  constructor(capacity = 0) {
    if (!(capacity >= 0)) {
      throw new RangeError('The capacity must not be negative.');
    }
    const room = Math.max(capacity, minimumCapacity);
    this.time = new Float64Array(room);
    this.open = new Float64Array(room);
    this.high = new Float64Array(room);
    this.low = new Float64Array(room);
    this.close = new Float64Array(room);
    this.volumes = new Float64Array(room);
  }

  /** The number of candles. */
  get count(): number {
    return this.size;
  }

  /** Grows with every change. */
  get version(): number {
    return this.changes;
  }

  /** @internal The prices from the lowest low to the highest high; 0 to 1 without candles. */
  get priceRange(): DoubleRange {
    return this.size > 0 ? new DoubleRange(this.lowestLow, this.highestHigh) : new DoubleRange(0, 1);
  }

  /** A candle. */
  at(index: number): Candle {
    if (!(index >= 0 && index < this.size)) {
      throw new RangeError('There is no such candle.');
    }
    return {
      time: this.time[index] as number,
      open: this.open[index] as number,
      high: this.high[index] as number,
      low: this.low[index] as number,
      close: this.close[index] as number,
      volume: this.volumes[index] as number,
    };
  }

  /**
   * Adds a candle at the end.
   * @throws RangeError for numbers that are not finite, a low above the high or a time before the last.
   */
  append(time: number, open: number, high: number, low: number, close: number, volume = 0): void {
    check(time, open, high, low, close, volume);
    if (this.size > 0 && time < (this.time[this.size - 1] as number)) {
      throw new RangeError('Candles must come in the order of time.');
    }
    if (this.size === this.time.length) {
      this.grow();
    }
    this.set(this.size, time, open, high, low, close, volume);
    this.size++;
    this.changes++;
  }

  /**
   * Changes the last candle; its time stays.
   * @throws RangeError for numbers that are not finite or a low above the high, or without candles.
   */
  updateLast(open: number, high: number, low: number, close: number, volume = 0): void {
    if (this.size === 0) {
      throw new RangeError('There is no candle to update.');
    }
    const time = this.time[this.size - 1] as number;
    check(time, open, high, low, close, volume);
    this.set(this.size - 1, time, open, high, low, close, volume);
    this.changes++;
  }

  /** Adds a trade to the last candle: its price moves high, low and close, its volume adds up. */
  addTick(price: number, volume = 0): void {
    const last = this.at(this.size - 1);
    this.updateLast(last.open, Math.max(last.high, price), Math.min(last.low, price), price, last.volume + volume);
  }

  /** Removes all candles. */
  clear(): void {
    this.size = 0;
    this.lowestLow = Number.POSITIVE_INFINITY;
    this.highestHigh = Number.NEGATIVE_INFINITY;
    this.mostVolume = 0;
    this.changes++;
  }

  /** @internal The first candle at or after a time. */
  findFirst(time: number): number {
    let low = 0;
    let high = this.size;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.time[middle] as number) < time) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  private set(i: number, time: number, open: number, high: number, low: number, close: number, volume: number): void {
    this.time[i] = time;
    this.open[i] = open;
    this.high[i] = high;
    this.low[i] = low;
    this.close[i] = close;
    this.volumes[i] = volume;
    this.lowestLow = Math.min(this.lowestLow, low);
    this.highestHigh = Math.max(this.highestHigh, high);
    this.mostVolume = Math.max(this.mostVolume, volume);
  }

  private grow(): void {
    const copy = (source: Float64Array): Float64Array => {
      const larger = new Float64Array(source.length * 2);
      larger.set(source);
      return larger;
    };
    this.time = copy(this.time);
    this.open = copy(this.open);
    this.high = copy(this.high);
    this.low = copy(this.low);
    this.close = copy(this.close);
    this.volumes = copy(this.volumes);
  }
}

function check(...values: number[]): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError('A candle needs finite numbers.');
  }
  if ((values[3] as number) > (values[2] as number)) {
    throw new RangeError('The low lies above the high.');
  }
}

/** How candles look. */
export type CandleStyle = 'candles' | 'ohlc';

/** The colors of rising or falling candles. */
export interface CandleLook {
  /** The body. */
  readonly body: Rgba8;
  /** The wick and the outline. */
  readonly line: Rgba8;
  /** Whether the body is only outlined. */
  readonly isHollow?: boolean;
}

/** @internal One column on the screen: a candle, or several merged when they are too narrow. */
export interface CandleColumn {
  center: number;
  width: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  last: number;
}

/** @internal The times of the candles relative to the origin of a time axis. */
export function candleTimeRange(data: CandleData, origin: number): DoubleRange {
  return data.count > 0
    ? new DoubleRange((data.time[0] as number) - origin, (data.time[data.count - 1] as number) - origin)
    : new DoubleRange(0, 1);
}

/** @internal The columns of the visible candles. */
export function collectCandleColumns(
  data: CandleData,
  frame: SeriesFrame,
  origin: number,
  columns: CandleColumn[],
): void {
  columns.length = 0;
  if (data.count === 0) {
    return;
  }
  const x = frame.x;
  const left = frame.bounds.x;
  const right = frame.bounds.x + frame.bounds.width;
  let low = x.toData(left) + origin;
  let high = x.toData(right) + origin;
  if (low > high) {
    [low, high] = [high, low];
  }
  // One period more on each side, so that candles cut by the edge still show.
  const start = Math.max(0, data.findFirst(low) - 1);
  const end = Math.min(data.count, data.findFirst(high) + 1);
  if (end <= start) {
    return;
  }
  const slot = slotOf(data, x, origin, start, end);
  if (slot >= columnPixels) {
    for (let i = start; i < end; i++) {
      columns.push({
        center: f(x.toPixel((data.time[i] as number) - origin)),
        width: f(slot),
        open: data.open[i] as number,
        high: data.high[i] as number,
        low: data.low[i] as number,
        close: data.close[i] as number,
        volume: data.volumes[i] as number,
        last: i,
      });
    }
    return;
  }
  let current = Number.NEGATIVE_INFINITY;
  for (let i = start; i < end; i++) {
    const pixel = x.toPixel((data.time[i] as number) - origin);
    const key = Math.floor((pixel - left) / columnPixels);
    const previous = columns.at(-1);
    if (key !== current || !previous) {
      columns.push({
        center: f(left + (key + 0.5) * columnPixels),
        width: f(columnPixels),
        open: data.open[i] as number,
        high: data.high[i] as number,
        low: data.low[i] as number,
        close: data.close[i] as number,
        volume: data.volumes[i] as number,
        last: i,
      });
      current = key;
      continue;
    }
    previous.high = Math.max(previous.high, data.high[i] as number);
    previous.low = Math.min(previous.low, data.low[i] as number);
    previous.close = data.close[i] as number;
    previous.volume += data.volumes[i] as number;
    previous.last = i;
  }
}

/** @internal The nearest candle to a pixel column, if it lies within half a period or the given distance; -1 else. */
export function findNearestCandle(
  data: CandleData,
  x: LinearAxisTransform,
  origin: number,
  pixel: number,
  maximumDistance: number,
): number {
  if (data.count === 0) {
    return -1;
  }
  const time = x.toData(pixel) + origin;
  const after = Math.min(data.findFirst(time), data.count - 1);
  const before = Math.max(after - 1, 0);
  const nearest =
    Math.abs((data.time[after] as number) - time) < Math.abs((data.time[before] as number) - time) ? after : before;
  const reach = Math.max(maximumDistance, slotOf(data, x, origin, 0, data.count) / 2);
  return Math.abs(x.toPixel((data.time[nearest] as number) - origin) - pixel) <= reach ? nearest : -1;
}

// The room of one period on the screen: the distance from the first to the last candle divided by the periods
// between them. Measured in pixels, it stays right on an axis that hides nights or weekends.
function slotOf(data: CandleData, x: LinearAxisTransform, origin: number, start: number, end: number): number {
  return end - start > 1
    ? Math.abs(x.toPixel((data.time[end - 1] as number) - origin) - x.toPixel((data.time[start] as number) - origin)) /
        (end - start - 1)
    : Math.abs(x.pixelsPerUnit);
}

/** @internal Adds a rectangle of two triangles. */
export function addRectangle(mesh: Mesh, left: number, top: number, right: number, bottom: number, color: Rgba8): void {
  const packed = packRgba8(color);
  mesh.add(left, top, packed);
  mesh.add(right, top, packed);
  mesh.add(right, bottom, packed);
  mesh.add(left, top, packed);
  mesh.add(right, bottom, packed);
  mesh.add(left, bottom, packed);
}

/** Candles or OHLC bars of a price over time. */
export class CandleSeries extends ChartSeries {
  private readonly mesh = new Mesh();
  private readonly columns: CandleColumn[] = [];
  private candleStyle: CandleStyle = 'candles';
  private risingLook: CandleLook = { body: { r: 38, g: 166, b: 154, a: 255 }, line: { r: 38, g: 166, b: 154, a: 255 } };
  private fallingLook: CandleLook = { body: { r: 239, g: 83, b: 80, a: 255 }, line: { r: 239, g: 83, b: 80, a: 255 } };
  private widthShare = 0.7;
  private hovered = -1;
  private appearance = 0;
  private built = -1;
  private builtFrame: SeriesFrame | undefined;

  /**
   * @param data - The candles.
   * @param xAxis - The time axis.
   * @param yAxis - The price axis.
   */
  constructor(
    /** The candles. */
    readonly data: CandleData,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** Candles or OHLC bars; candles by default. */
  get style(): CandleStyle {
    return this.candleStyle;
  }

  set style(value: CandleStyle) {
    this.candleStyle = value;
    this.appearance++;
  }

  /** The look of rising candles; green by default. */
  get rising(): CandleLook {
    return this.risingLook;
  }

  set rising(value: CandleLook) {
    this.risingLook = value;
    this.appearance++;
  }

  /** The look of falling candles; red by default. */
  get falling(): CandleLook {
    return this.fallingLook;
  }

  set falling(value: CandleLook) {
    this.fallingLook = value;
    this.appearance++;
  }

  /** The width of a body as a share of its period; 0.7 by default. */
  get bodyWidth(): number {
    return this.widthShare;
  }

  set bodyWidth(value: number) {
    if (!(value > 0 && value <= 1)) {
      throw new RangeError('The body width must lie above 0 and up to 1.');
    }
    this.widthShare = value;
    this.appearance++;
  }

  /** The candle under the pointer, -1 for none; the readout shows it instead of the last. */
  get hoveredIndex(): number {
    return this.hovered;
  }

  set hoveredIndex(value: number) {
    if (value !== this.hovered) {
      this.hovered = value;
      this.appearance++;
    }
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.risingLook.line;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.data.version + this.appearance;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    if (this.data.count === 0) {
      return undefined;
    }
    return axis === 'x' ? candleTimeRange(this.data, originOf(this.xAxis)) : this.data.priceRange;
  }

  /** {@inheritDoc ChartSeries.findPoint} */
  override findPoint(
    frame: SeriesFrame,
    pixelX: number,
    _pixelY: number,
    maximumDistance: number,
  ): FoundPoint | undefined {
    const origin = originOf(this.xAxis);
    const found = findNearestCandle(this.data, frame.x, origin, pixelX, maximumDistance);
    return found < 0
      ? undefined
      : { index: found, x: (this.data.time[found] as number) - origin, y: this.data.close[found] as number };
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(_device: RenderDevice, frame: SeriesFrame): void {
    if (this.version === this.built && frame === this.builtFrame) {
      return;
    }
    collectCandleColumns(this.data, frame, originOf(this.xAxis), this.columns);
    this.mesh.clear();
    const scale = f(frame.dpiScale);
    for (const column of this.columns) {
      const look = column.close >= column.open ? this.risingLook : this.fallingLook;
      if (this.candleStyle === 'ohlc') {
        this.addBar(frame, column, look, scale);
      } else {
        this.addCandle(frame, column, look, scale);
      }
    }
    this.built = this.version;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.mesh.count > 0) {
      commands.fillMesh(this.mesh.data, this.mesh.count, frame.bounds);
    }
  }

  private addCandle(frame: SeriesFrame, column: CandleColumn, look: CandleLook, scale: number): void {
    const mesh = this.mesh;
    const half = Math.max(f(scale * 0.5), f(f(column.width * f(this.widthShare)) / 2));
    const line = Math.max(1, roundHalfEven(scale));
    const high = f(frame.y.toPixel(column.high));
    const low = f(frame.y.toPixel(column.low));
    const open = f(frame.y.toPixel(column.open));
    const close = f(frame.y.toPixel(column.close));
    const top = Math.min(open, close);
    const bottom = Math.max(Math.max(open, close), f(top + line));
    const center = column.center;
    const half1 = f(line / 2);
    addRectangle(mesh, f(center - half1), Math.min(high, low), f(center + half1), Math.max(high, low), look.line);
    if (look.isHollow !== true || f(half * 2) <= line * 3) {
      addRectangle(mesh, f(center - half), top, f(center + half), bottom, look.body);
      return;
    }
    addRectangle(mesh, f(center - half), top, f(center + half), f(top + line), look.line);
    addRectangle(mesh, f(center - half), f(bottom - line), f(center + half), bottom, look.line);
    addRectangle(mesh, f(center - half), top, f(f(center - half) + line), bottom, look.line);
    addRectangle(mesh, f(f(center + half) - line), top, f(center + half), bottom, look.line);
  }

  private addBar(frame: SeriesFrame, column: CandleColumn, look: CandleLook, scale: number): void {
    const mesh = this.mesh;
    const half = Math.max(scale, f(f(column.width * f(this.widthShare)) / 2));
    const line = Math.max(1, roundHalfEven(scale));
    const high = f(frame.y.toPixel(column.high));
    const low = f(frame.y.toPixel(column.low));
    const open = f(frame.y.toPixel(column.open));
    const close = f(frame.y.toPixel(column.close));
    const center = column.center;
    const half1 = f(line / 2);
    const top = Math.min(high, low);
    addRectangle(
      mesh,
      f(center - half1),
      top,
      f(center + half1),
      Math.max(Math.max(high, low), f(top + line)),
      look.line,
    );
    addRectangle(mesh, f(center - half), f(open - half1), center, f(open + half1), look.line);
    addRectangle(mesh, center, f(close - half1), f(center + half), f(close + half1), look.line);
  }
}

/** The volume of each candle as a bar from zero, in the color of its candle. */
export class VolumeSeries extends ChartSeries {
  private readonly mesh = new Mesh();
  private readonly columns: CandleColumn[] = [];
  private risingColorValue: Rgba8 = { r: 38, g: 166, b: 154, a: 140 };
  private fallingColorValue: Rgba8 = { r: 239, g: 83, b: 80, a: 140 };
  private appearance = 0;
  private built = -1;
  private builtFrame: SeriesFrame | undefined;

  /**
   * @param data - The candles.
   * @param xAxis - The time axis.
   * @param yAxis - The volume axis.
   */
  constructor(
    /** The candles. */
    readonly data: CandleData,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** The color of the volume of rising candles. */
  get risingColor(): Rgba8 {
    return this.risingColorValue;
  }

  set risingColor(value: Rgba8) {
    this.risingColorValue = value;
    this.appearance++;
  }

  /** The color of the volume of falling candles. */
  get fallingColor(): Rgba8 {
    return this.fallingColorValue;
  }

  set fallingColor(value: Rgba8) {
    this.fallingColorValue = value;
    this.appearance++;
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.risingColorValue;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.data.version + this.appearance;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    if (this.data.count === 0) {
      return undefined;
    }
    return axis === 'x'
      ? candleTimeRange(this.data, originOf(this.xAxis))
      : new DoubleRange(0, this.data.mostVolume > 0 ? this.data.mostVolume : 1);
  }

  /** {@inheritDoc ChartSeries.findPoint} */
  override findPoint(
    frame: SeriesFrame,
    pixelX: number,
    _pixelY: number,
    maximumDistance: number,
  ): FoundPoint | undefined {
    const origin = originOf(this.xAxis);
    const found = findNearestCandle(this.data, frame.x, origin, pixelX, maximumDistance);
    return found < 0
      ? undefined
      : { index: found, x: (this.data.time[found] as number) - origin, y: this.data.volumes[found] as number };
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(_device: RenderDevice, frame: SeriesFrame): void {
    if (this.version === this.built && frame === this.builtFrame) {
      return;
    }
    collectCandleColumns(this.data, frame, originOf(this.xAxis), this.columns);
    this.mesh.clear();
    const zero = f(frame.y.toPixel(0));
    const gap = f(frame.dpiScale);
    for (const column of this.columns) {
      const half = Math.max(f(gap * 0.5), f(f(column.width / 2) - f(gap / 2)));
      const top = f(frame.y.toPixel(column.volume));
      addRectangle(
        this.mesh,
        f(column.center - half),
        Math.min(top, zero),
        f(column.center + half),
        Math.max(top, zero),
        column.close >= column.open ? this.risingColorValue : this.fallingColorValue,
      );
    }
    this.built = this.version;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.mesh.count > 0) {
      commands.fillMesh(this.mesh.data, this.mesh.count, frame.bounds);
    }
  }
}

const readoutSize = 12;

/** @internal The prices of the candle under the pointer, or of the last one, above the plot. */
export class CandleReadoutOverlay extends ChartOverlay {
  constructor(private readonly series: CandleSeries) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.series.data.version + this.series.hoveredIndex + chartText.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const data = this.series.data;
    const pane = canvas.layout.panes[0];
    if (data.count === 0 || !pane) {
      return;
    }
    const hovered = this.series.hoveredIndex;
    const candle = data.at(hovered >= 0 && hovered < data.count ? hovered : data.count - 1);
    const culture = chartText.culture;
    const general = (value: number): string => formatGeneral(value, 6, culture);
    const text =
      this.series.xAxis.formatCursorValue(candle.time - originOf(this.series.xAxis)) +
      `   O ${general(candle.open)}   H ${general(candle.high)}   L ${general(candle.low)}   C ${general(candle.close)}` +
      (candle.volume > 0 ? `   V ${groupThousands(candle.volume, culture.decimalSeparator === ',' ? '.' : ',')}` : '');
    const color = candle.close >= candle.open ? this.series.rising.line : this.series.falling.line;
    canvas.drawText(
      text,
      roundHalfEven(pane.x + 8),
      roundHalfEven(pane.y + 6 + canvas.lineHeight(readoutSize) * 0.8),
      readoutSize,
      color,
    );
  }
}

/** @internal A whole number with groups of thousands, as N0 of .NET. */
export function groupThousands(value: number, separator: string): string {
  const digits = String(Math.abs(roundHalfEven(value)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return value < 0 ? `-${grouped}` : grouped;
}

/** Follows the pointer with the readout of the candles. */
export class CandleModifier extends ChartModifier {
  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const chart = this.interaction?.chart;
    const candles = chart?.series.find((series) => series instanceof CandleSeries);
    if (!chart || !candles) {
      return 'ignored';
    }
    if (input.kind === 'exited' || input.kind === 'canceled') {
      candles.hoveredIndex = -1;
    } else if (input.kind === 'moved') {
      const hit = chart.hitTest(input.position, Number.MAX_VALUE, 'nearestX');
      candles.hoveredIndex =
        hit && (hit.series instanceof CandleSeries || hit.series instanceof VolumeSeries) ? hit.index : -1;
    }
    return 'ignored';
  }
}

/** Describes candles of the data on the price axis, with their readout and the pointer that moves it. */
export function candles(
  builder: ChartBuilder,
  data: CandleData,
  configure?: (series: CandleSeries) => void,
  yAxis?: string,
): ChartBuilder {
  return builder
    .addSeries(
      (x, y) => {
        const series = new CandleSeries(data, x, y);
        configure?.(series);
        return series;
      },
      undefined,
      yAxis,
    )
    .addOverlay(
      (chart) =>
        new CandleReadoutOverlay(chart.series.find((series) => series instanceof CandleSeries) as CandleSeries),
    )
    .addModifier(() => new CandleModifier());
}

/** Describes the volume of the data on its axis. */
export function volume(builder: ChartBuilder, data: CandleData, yAxis?: string): ChartBuilder {
  return builder.addSeries((x, y) => new VolumeSeries(data, x, y), undefined, yAxis);
}
