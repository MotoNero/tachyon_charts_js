// The state of an oscilloscope: channels with their waveforms, scales and measurements, as ScopeMeasurements,
// ScopeChannel and ScopeDisplay of the .NET version. The chart follows it through an overlay (scope-chart.ts).
import { DataSource } from '../data/data-source';
import type { ChartTextKey } from '../locale/culture';
import { DoubleRange } from '../numerics/range';
import type { Rgba8 } from '../render/types';

/** The divisions of the screen across. */
export const scopeHorizontalDivisions = 10;
/** The divisions of the screen from top to bottom. */
export const scopeVerticalDivisions = 8;

const channelColors: readonly Rgba8[] = [
  { r: 245, g: 214, b: 60, a: 255 },
  { r: 70, g: 215, b: 120, a: 255 },
  { r: 90, g: 170, b: 255, a: 255 },
  { r: 240, g: 110, b: 170, a: 255 },
];

/** How earlier waveforms stay on the screen. */
export type ScopePersistence = 'off' | 'variable' | 'infinite' | 'colorGrade';

/** The measurements of a waveform; NaN where there is nothing to measure. */
export interface ScopeMeasurements {
  /** The lowest value. */
  readonly minimum: number;
  /** The highest value. */
  readonly maximum: number;
  /** The mean. */
  readonly mean: number;
  /** The root mean square. */
  readonly rms: number;
  /** The frequency from the rising edges through the middle. */
  readonly frequency: number;
}

/** Measures a waveform: minimum, maximum, mean, RMS and frequency. */
export function measureWaveform(
  time: ArrayLike<number>,
  values: ArrayLike<number> & Iterable<number>,
): ScopeMeasurements {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      sum += value;
      squares += value * value;
      count++;
    }
  }
  if (count === 0) {
    return { minimum: Number.NaN, maximum: Number.NaN, mean: Number.NaN, rms: Number.NaN, frequency: Number.NaN };
  }
  return {
    minimum,
    maximum,
    mean: sum / count,
    rms: Math.sqrt(squares / count),
    frequency: measureFrequency(time, values, minimum, maximum),
  };
}

// Rising edges through the middle. The bands around it keep noise from counting as an edge.
function measureFrequency(
  time: ArrayLike<number>,
  values: ArrayLike<number>,
  minimum: number,
  maximum: number,
): number {
  const hysteresis = 0.1;
  const high = minimum + (maximum - minimum) * (0.5 + hysteresis);
  const low = minimum + (maximum - minimum) * (0.5 - hysteresis);
  let isArmed = false;
  let first = Number.NaN;
  let last = Number.NaN;
  let edges = 0;
  for (let i = 0; i < values.length && i < time.length; i++) {
    const value = values[i] as number;
    if (value < low) {
      isArmed = true;
    } else if (isArmed && value > high) {
      isArmed = false;
      first = edges === 0 ? (time[i] as number) : first;
      last = time[i] as number;
      edges++;
    }
  }
  return edges >= 2 && last > first ? (edges - 1) / (last - first) : Number.NaN;
}

/** One channel of an oscilloscope. */
export class ScopeChannel {
  /** The waveform, time in seconds and volts. */
  readonly data = new DataSource();
  /** @internal The area of the scale readout, for the wheel. */
  readout = { left: 0, right: 0, top: 0, bottom: 0 };
  /** @internal Whether the position may leave the screen. */
  isUnbounded = false;
  private perDivision = 1;
  private offset = 0;
  private measured: ScopeMeasurements = measureWaveform([], []);
  private acquisitions = 0;
  private channelColor: Rgba8;

  /** @internal */
  constructor(
    private readonly display: ScopeDisplay,
    /** The number, from 1. */
    readonly number: number,
    color: Rgba8,
  ) {
    this.channelColor = color;
  }

  /** The color; the chart sets it from the palette of its theme. @internal The setter is for the chart. */
  get color(): Rgba8 {
    return this.channelColor;
  }

  set color(value: Rgba8) {
    this.channelColor = value;
  }

  /** Volts per division; 1 by default. */
  get voltsPerDivision(): number {
    return this.perDivision;
  }

  set voltsPerDivision(value: number) {
    if (!(value > 0)) {
      throw new RangeError('The volts per division must be positive.');
    }
    this.perDivision = value;
    this.display.touchScale();
  }

  /** The position of 0 V in divisions above the middle, kept on the screen. */
  get position(): number {
    return this.offset;
  }

  set position(value: number) {
    const half = scopeVerticalDivisions / 2;
    this.offset = this.isUnbounded ? value : Math.min(Math.max(value, -half), half);
    this.display.touchScale();
  }

  /** The measurements of the latest waveform. */
  get measurements(): ScopeMeasurements {
    return this.measured;
  }

  /** The number of waveforms so far. */
  get acquisitionCount(): number {
    return this.acquisitions;
  }

  /** @internal The id of the hidden axis of the channel. */
  get axisId(): string {
    return `ch${String(this.number)}`;
  }

  /** Shows a new waveform: time in seconds, values in volts (kept as 32-bit floats like the instrument). */
  setWaveform(time: ArrayLike<number>, volts: ArrayLike<number>): void {
    const values = Float32Array.from(volts);
    this.measured = measureWaveform(time, values);
    this.data.clear();
    this.data.append(time, values);
    this.acquisitions++;
    this.display.touch();
  }

  /** @internal The volts from the bottom of the screen to the top. */
  range(): DoubleRange {
    const half = scopeVerticalDivisions / 2;
    return new DoubleRange((-half - this.offset) * this.perDivision, (half - this.offset) * this.perDivision);
  }
}

/** The state of an oscilloscope: channels, time base, trigger level and persistence. */
export class ScopeDisplay {
  /** What the trigger reports, shown beside the time base; nothing when left out. */
  triggerStatus: ChartTextKey | undefined;
  private readonly channelList: ScopeChannel[] = [];
  private timeBase = 1e-3;
  private timeShift = 0;
  private level = 0;
  private changes = 0;
  private scaleChanges = 0;
  private persistenceMode: ScopePersistence = 'off';
  private persistenceTime = 0.3;

  /** The channels. */
  get channels(): readonly ScopeChannel[] {
    return this.channelList;
  }

  /** Seconds per division; 1 ms by default. */
  get timePerDivision(): number {
    return this.timeBase;
  }

  set timePerDivision(value: number) {
    if (!(value > 0)) {
      throw new RangeError('The time per division must be positive.');
    }
    this.timeBase = value;
    this.touchScale();
  }

  /** The time in the middle of the screen, in seconds; the trigger is at 0. */
  get timeOffset(): number {
    return this.timeShift;
  }

  set timeOffset(value: number) {
    this.timeShift = value;
    this.touchScale();
  }

  /** The trigger level in volts of the first channel. */
  get triggerLevel(): number {
    return this.level;
  }

  set triggerLevel(value: number) {
    this.level = value;
    this.touch();
  }

  /** How earlier waveforms stay; off by default. */
  get persistence(): ScopePersistence {
    return this.persistenceMode;
  }

  set persistence(value: ScopePersistence) {
    this.persistenceMode = value;
    this.touchScale();
  }

  /** How long a waveform fades with variable persistence, in seconds; 0.3 by default. */
  get persistenceSeconds(): number {
    return this.persistenceTime;
  }

  set persistenceSeconds(value: number) {
    if (!(value > 0)) {
      throw new RangeError('The persistence must be positive.');
    }
    this.persistenceTime = value;
    this.touch();
  }

  /** Grows with every change. */
  get version(): number {
    return this.changes;
  }

  /** Grows with every change of a scale, which clears the persistence. */
  get scaleVersion(): number {
    return this.scaleChanges;
  }

  /** Adds a channel in the next color: yellow, green, blue, pink. */
  addChannel(): ScopeChannel {
    const channel = new ScopeChannel(
      this,
      this.channelList.length + 1,
      channelColors[this.channelList.length % channelColors.length] as Rgba8,
    );
    this.channelList.push(channel);
    return channel;
  }

  /** The seconds from the left of the screen to the right. */
  timeRange(): DoubleRange {
    const half = (scopeHorizontalDivisions / 2) * this.timeBase;
    return new DoubleRange(this.timeShift - half, this.timeShift + half);
  }

  /** Clears the persistence. */
  clearPersistence(): void {
    this.touchScale();
  }

  /** @internal Asks for a new frame. */
  touch(): void {
    this.changes++;
  }

  /** @internal Asks for a new frame after a change of a scale. */
  touchScale(): void {
    this.scaleChanges++;
    this.touch();
  }
}
