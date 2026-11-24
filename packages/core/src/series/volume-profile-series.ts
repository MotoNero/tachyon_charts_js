// The volume traded at each price level over the visible periods, as VolumeProfileSeries, VolumeProfileOverlay,
// VolumeProfileModifier and MarketProfiles of the .NET version: bars from the side of the plot, the point of control
// and the value area set apart.
import type { Axis } from '../axes/axis';
import type { ChartBuilder } from '../fluent/chart-builder';
import type { FoundPoint } from '../hit-testing/types';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import type { PointerInputEvent } from '../input/primitives';
import { chartText } from '../locale/culture';
import { formatFixed, formatGeneral } from '../locale/format';
import { DoubleRange } from '../numerics/range';
import { ChartOverlay, type OverlayCanvas } from '../overlays/chart-overlay';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { Rgba8 } from '../render/types';
import { addRectangle, candleTimeRange, groupThousands, type CandleData } from './candle-series';
import { originOf } from './line-series';
import { Mesh } from './ribbon-series';

const f = Math.fround;

/** The side of the plot the bars of a profile grow from. */
export type ProfileSide = 'right' | 'left';

/** The volumes per level of one frame and where their bars lie. */
export class VolumeProfile {
  /** The volume of each level, from the lowest price. */
  volumes = new Float64Array(64);
  /** The number of levels. */
  count = 0;
  /** The largest volume of a level. */
  largest = 0;
  /** The volume of all levels. */
  total = 0;
  /** The level of the most volume, -1 for none. */
  pointOfControl = -1;
  /** The lowest level of the value area. */
  valueAreaLow = 0;
  /** The highest level of the value area, below the lowest when there is none. */
  valueAreaHigh = -1;
  /** The prices from the bottom of the plot to its top. */
  prices = new DoubleRange(0, 1);
  /** The scale of the frame. */
  scale = 0;
  private left = 0;
  private top = 0;
  private right = 0;
  private levelHeight = 0;
  private side: ProfileSide = 'right';

  /** Whether a level lies in the value area. */
  isInValueArea(level: number): boolean {
    return level >= this.valueAreaLow && level <= this.valueAreaHigh;
  }

  /** The price in the middle of a level. */
  priceOf(level: number): number {
    return this.prices.min + ((level + 0.5) * this.prices.length) / this.count;
  }

  /** The prices of a level. */
  rangeOf(level: number): DoubleRange {
    const prices = this.prices;
    return new DoubleRange(
      prices.min + (level * prices.length) / this.count,
      prices.min + ((level + 1) * prices.length) / this.count,
    );
  }

  /** The bar of a level in pixels. */
  barOf(level: number): { left: number; top: number; right: number; bottom: number } {
    const share = f(this.largest > 0 ? (this.volumes[level] as number) / this.largest : 0);
    const length = f(share * f(this.right - this.left));
    const bottom = f(this.top + f((this.count - level) * this.levelHeight));
    const top = f(bottom - this.levelHeight);
    return this.side === 'right'
      ? { left: f(this.right - length), top, right: this.right, bottom }
      : { left: this.left, top, right: f(this.left + length), bottom };
  }

  /** The level whose bar lies at a pixel, -1 for none. */
  levelAt(x: number, y: number): number {
    if (this.count === 0 || this.levelHeight <= 0) {
      return -1;
    }
    const level = this.count - 1 - Math.floor((y - this.top) / this.levelHeight);
    if (level < 0 || level >= this.count) {
      return -1;
    }
    const bar = this.barOf(level);
    return x >= bar.left && x <= bar.right && (this.volumes[level] as number) > 0 ? level : -1;
  }

  /** Spreads the volume of the visible candles over the levels and finds the value area. */
  build(
    data: CandleData,
    frame: SeriesFrame,
    origin: number,
    levels: number,
    valueArea: number,
    width: number,
    side: ProfileSide,
  ): void {
    if (this.volumes.length < levels) {
      this.volumes = new Float64Array(levels);
    }
    this.count = levels;
    this.volumes.fill(0, 0, levels);
    const bounds = frame.bounds;
    this.scale = f(frame.dpiScale);
    this.side = side;
    this.top = bounds.y;
    this.levelHeight = f(bounds.height / levels);
    const length = f(bounds.width * width);
    const end = f(bounds.x + bounds.width);
    this.left = side === 'right' ? f(end - length) : bounds.x;
    this.right = side === 'right' ? end : f(bounds.x + length);
    const low = frame.y.toData(f(bounds.y + bounds.height));
    const high = frame.y.toData(bounds.y);
    this.prices = new DoubleRange(Math.min(low, high), Math.max(low, high));
    this.total = 0;
    this.largest = 0;
    this.pointOfControl = -1;
    this.valueAreaLow = 0;
    this.valueAreaHigh = -1;
    if (data.count === 0 || this.prices.length <= 0) {
      return;
    }
    const first = frame.x.toData(bounds.x) + origin;
    const last = frame.x.toData(f(bounds.x + bounds.width)) + origin;
    const later = Math.max(first, last);
    const start = data.findFirst(Math.min(first, last));
    const stop = data.findFirst(later);
    for (let i = start; i < stop || (i < data.count && (data.time[i] as number) <= later); i++) {
      this.spread(data.low[i] as number, data.high[i] as number, data.volumes[i] as number);
    }
    this.findValueArea(valueArea);
  }

  // The volume of a candle falls evenly on the levels from its low to its high, as far as they are visible.
  private spread(low: number, high: number, volume: number): void {
    if (volume <= 0) {
      return;
    }
    const step = this.prices.length / this.count;
    const from = Math.floor((low - this.prices.min) / step);
    const to = Math.floor((high - this.prices.min) / step);
    const share = volume / (to - from + 1);
    for (let level = Math.max(from, 0); level <= Math.min(to, this.count - 1); level++) {
      this.volumes[level] = (this.volumes[level] as number) + share;
      this.total += share;
    }
  }

  // Grows from the point of control to the side with more volume until the share is reached.
  private findValueArea(share: number): void {
    for (let level = 0; level < this.count; level++) {
      if ((this.volumes[level] as number) > this.largest) {
        this.largest = this.volumes[level] as number;
        this.pointOfControl = level;
      }
    }
    if (this.pointOfControl < 0) {
      return;
    }
    let low = this.pointOfControl;
    let high = this.pointOfControl;
    let sum = this.volumes[this.pointOfControl] as number;
    while (sum < this.total * share && (low > 0 || high < this.count - 1)) {
      const below = low > 0 ? (this.volumes[low - 1] as number) : -1;
      const above = high < this.count - 1 ? (this.volumes[high + 1] as number) : -1;
      if (above >= below) {
        high++;
        sum += above;
      } else {
        low--;
        sum += below;
      }
    }
    this.valueAreaLow = low;
    this.valueAreaHigh = high;
  }
}

/** The volume traded at each price level over the visible periods, as bars from the side of the plot. */
export class VolumeProfileSeries extends ChartSeries {
  /** The profile of the last frame. */
  readonly profile = new VolumeProfile();
  private readonly mesh = new Mesh();
  private levelCount = 48;
  private widthShare = 0.25;
  private valueArea = 0.7;
  private barSide: ProfileSide = 'right';
  private barColor: Rgba8 = { r: 120, g: 144, b: 200, a: 90 };
  private areaColor: Rgba8 = { r: 120, g: 144, b: 200, a: 160 };
  private controlColor: Rgba8 = { r: 255, g: 190, b: 11, a: 220 };
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

  /** The number of price levels over the height of the plot; 48 by default, 2 to 1000. */
  get levels(): number {
    return this.levelCount;
  }

  set levels(value: number) {
    if (!(Number.isInteger(value) && value >= 2 && value <= 1000)) {
      throw new RangeError('The levels must be a whole number from 2 to 1000.');
    }
    this.levelCount = value;
    this.appearance++;
  }

  /** The length of the longest bar as a share of the plot width; 0.25 by default. */
  get width(): number {
    return this.widthShare;
  }

  set width(value: number) {
    if (!(value > 0 && value <= 1)) {
      throw new RangeError('The width must lie above 0 and up to 1.');
    }
    this.widthShare = value;
    this.appearance++;
  }

  /** The share of the volume in the value area; 0.7 by default. */
  get valueAreaShare(): number {
    return this.valueArea;
  }

  set valueAreaShare(value: number) {
    if (!(value >= 0 && value <= 1)) {
      throw new RangeError('The share must lie between 0 and 1.');
    }
    this.valueArea = value;
    this.appearance++;
  }

  /** The side the bars grow from; the right by default. */
  get side(): ProfileSide {
    return this.barSide;
  }

  set side(value: ProfileSide) {
    this.barSide = value;
    this.appearance++;
  }

  /** The color of the levels outside the value area. */
  get color(): Rgba8 {
    return this.barColor;
  }

  set color(value: Rgba8) {
    this.barColor = value;
    this.appearance++;
  }

  /** The color of the value area. */
  get valueAreaColor(): Rgba8 {
    return this.areaColor;
  }

  set valueAreaColor(value: Rgba8) {
    this.areaColor = value;
    this.appearance++;
  }

  /** The color of the point of control. */
  get pointOfControlColor(): Rgba8 {
    return this.controlColor;
  }

  set pointOfControlColor(value: Rgba8) {
    this.controlColor = value;
    this.appearance++;
  }

  /** The level under the pointer, -1 for none. */
  get hoveredLevel(): number {
    return this.hovered;
  }

  set hoveredLevel(value: number) {
    if (value !== this.hovered) {
      this.hovered = value;
      this.appearance++;
    }
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.areaColor;
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
  override findPoint(_frame: SeriesFrame, pixelX: number, pixelY: number): FoundPoint | undefined {
    const level = this.profile.levelAt(pixelX, pixelY);
    return level < 0 ? undefined : { index: level, x: 0, y: this.profile.priceOf(level) };
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(_device: RenderDevice, frame: SeriesFrame): void {
    if (this.version === this.built && frame === this.builtFrame) {
      return;
    }
    const profile = this.profile;
    profile.build(
      this.data,
      frame,
      originOf(this.xAxis),
      this.levelCount,
      this.valueArea,
      this.widthShare,
      this.barSide,
    );
    this.mesh.clear();
    for (let level = 0; level < profile.count; level++) {
      if ((profile.volumes[level] as number) <= 0) {
        continue;
      }
      const bar = profile.barOf(level);
      let color = this.colorOf(level);
      if (level === this.hovered) {
        color = { ...color, a: Math.min(255, color.a + 60) };
      }
      addRectangle(this.mesh, bar.left, f(bar.top + 0.5), bar.right, f(bar.bottom - 0.5), color);
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

  // The point of control stands out most, the value area less, the rest least.
  private colorOf(level: number): Rgba8 {
    if (level === this.profile.pointOfControl) {
      return this.controlColor;
    }
    return this.profile.isInValueArea(level) ? this.areaColor : this.barColor;
  }
}

/** @internal The prices, the volume and the share of the level under the pointer. */
export class VolumeProfileOverlay extends ChartOverlay {
  constructor(private readonly series: VolumeProfileSeries) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.series.version + chartText.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const profile = this.series.profile;
    const level = this.series.hoveredLevel;
    if (level < 0 || level >= profile.count || profile.scale <= 0) {
      return;
    }
    const culture = chartText.culture;
    const range = profile.rangeOf(level);
    const volume = profile.volumes[level] as number;
    const share = profile.total > 0 ? volume / profile.total : 0;
    const percent = formatFixed(share * 100, 1, culture).replace(new RegExp(`\\${culture.decimalSeparator}0$`), '');
    const text =
      `${formatGeneral(range.min, 5, culture)} – ${formatGeneral(range.max, 5, culture)}: ` +
      `${groupThousands(volume, culture.decimalSeparator === ',' ? '.' : ',')} (${percent} %)`;
    const bar = profile.barOf(level);
    const width = canvas.measureWidth(text, canvas.labelSize) + 12;
    const x = this.series.side === 'right' ? bar.left / profile.scale - width - 4 : bar.right / profile.scale + 4;
    canvas.drawLabel(text, x, bar.top / profile.scale - 4, { ...canvas.colors.background, a: 235 }, canvas.colors.text);
  }
}

/** Follows the pointer over the bars of a volume profile. */
export class VolumeProfileModifier extends ChartModifier {
  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const series = this.interaction?.chart.series.find((item) => item instanceof VolumeProfileSeries);
    if (!series) {
      return 'ignored';
    }
    if (input.kind === 'exited' || input.kind === 'canceled') {
      series.hoveredLevel = -1;
    } else if (input.kind === 'moved') {
      const profile = series.profile;
      series.hoveredLevel = profile.levelAt(input.position.x * profile.scale, input.position.y * profile.scale);
    }
    return 'ignored';
  }
}

/** Describes the volume profile of the data on the price axis, with the value under the pointer. */
export function volumeProfile(
  builder: ChartBuilder,
  data: CandleData,
  configure?: (series: VolumeProfileSeries) => void,
  yAxis?: string,
): ChartBuilder {
  return builder
    .addSeries(
      (x, y) => {
        const series = new VolumeProfileSeries(data, x, y);
        configure?.(series);
        return series;
      },
      undefined,
      yAxis,
    )
    .addOverlay(
      (chart) =>
        new VolumeProfileOverlay(
          chart.series.find((series) => series instanceof VolumeProfileSeries) as VolumeProfileSeries,
        ),
    )
    .addModifier(() => new VolumeProfileModifier());
}
