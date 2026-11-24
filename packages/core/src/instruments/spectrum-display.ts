// The state of a spectrum analyzer: trace, max hold, markers, mask and history, as FrequencyMask and SpectrumDisplay
// of the .NET version. It runs on an oscilloscope display whose time is the frequency and whose volts are dBm.
import { SpectrogramData } from '../series/spectrogram-series';
import { ScopeDisplay, scopeVerticalDivisions, type ScopeChannel } from './scope-display';

const maximumExtraMarkers = 5;
const divisions = 10;
const historyColumns = 1024;
const historyRows = 400;

/** The worst point of a trace above a mask, and how many points are above it. */
export interface MaskViolation {
  /** The frequency of the worst point. */
  readonly frequency: number;
  /** The level of the worst point. */
  readonly level: number;
  /** The limit of the mask there. */
  readonly limit: number;
  /** The number of points above the mask. */
  readonly pointCount: number;
}

/** A frequency and a level. */
export interface SpectrumPoint {
  /** The frequency in hertz. */
  readonly frequency: number;
  /** The level in dBm. */
  readonly level: number;
}

const nowhere: SpectrumPoint = { frequency: Number.NaN, level: Number.NaN };

/** The highest levels a trace may reach, a line through corners from low to high frequencies. */
export class FrequencyMask {
  private readonly corners: Float64Array;
  private readonly limits: Float64Array;

  /**
   * @param frequencies - The frequencies of the corners, rising.
   * @param levels - The level at each corner.
   * @throws RangeError with fewer than two corners or a level missing.
   */
  constructor(frequencies: ArrayLike<number>, levels: ArrayLike<number>) {
    if (frequencies.length !== levels.length || frequencies.length < 2) {
      throw new RangeError('A mask needs at least two corners with a level each.');
    }
    this.corners = Float64Array.from(frequencies);
    this.limits = Float64Array.from(levels);
  }

  /** The frequencies of the corners. */
  get frequencies(): readonly number[] {
    return Array.from(this.corners);
  }

  /** The levels of the corners. */
  get levels(): readonly number[] {
    return Array.from(this.limits);
  }

  /** The same mask moved up by the level. */
  shift(level: number): FrequencyMask {
    return new FrequencyMask(
      this.corners,
      this.limits.map((value) => value + level),
    );
  }

  /** The limit at a frequency; infinite outside the mask. */
  limit(frequency: number): number {
    const corners = this.corners;
    if (frequency < (corners[0] as number) || frequency > (corners.at(-1) as number)) {
      return Number.POSITIVE_INFINITY;
    }
    let low = 0;
    let high = corners.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const value = corners[middle] as number;
      if (value === frequency) {
        return this.limits[middle] as number;
      }
      if (value < frequency) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const upper = low;
    const share =
      (frequency - (corners[upper - 1] as number)) / ((corners[upper] as number) - (corners[upper - 1] as number));
    const below = this.limits[upper - 1] as number;
    return below + share * ((this.limits[upper] as number) - below);
  }

  /** The worst point above the mask, or nothing when the trace keeps to it. */
  check(frequencies: ArrayLike<number>, levels: ArrayLike<number>): MaskViolation | undefined {
    let count = 0;
    let worst = Number.NEGATIVE_INFINITY;
    let result: MaskViolation | undefined;
    for (let i = 0; i < frequencies.length && i < levels.length; i++) {
      const frequency = frequencies[i] as number;
      const level = levels[i] as number;
      const limit = this.limit(frequency);
      const excess = level - limit;
      if (excess > 0) {
        count++;
        if (excess > worst) {
          worst = excess;
          result = { frequency, level, limit, pointCount: 0 };
        }
      }
    }
    return result && { ...result, pointCount: count };
  }
}

/** The highest finite level of a trace and its frequency; NaN for an empty trace. */
export function findSpectrumPeak(frequencies: ArrayLike<number>, levels: ArrayLike<number>): SpectrumPoint {
  let best = -1;
  for (let i = 0; i < levels.length && i < frequencies.length; i++) {
    const level = levels[i] as number;
    if (Number.isFinite(level) && (best < 0 || level > (levels[best] as number))) {
      best = i;
    }
  }
  return best < 0 ? nowhere : { frequency: frequencies[best] as number, level: levels[best] as number };
}

/** The state of a spectrum analyzer. */
export class SpectrumDisplay {
  /** Called with the worst point whenever a trace breaks the mask. */
  onMaskViolated: ((violation: MaskViolation) => void) | undefined;
  /** The rows of the levels over time, 1024 columns across the first span, 400 rows. */
  readonly history = new SpectrogramData(historyColumns, historyRows);
  /** @internal The oscilloscope display below. */
  readonly scope = new ScopeDisplay();
  /** @internal The trace. */
  readonly trace: ScopeChannel;
  /** @internal The max hold. */
  readonly hold: ScopeChannel;
  private readonly historyRow = new Float32Array(historyColumns);
  private extras: readonly number[] = [];
  private maxHold = new Float32Array(0);
  private holdFrequencies = new Float64Array(0);
  private viewStart = 0;
  private viewStop = 1;
  private reference = 0;
  private perDivisionValue = 10;
  private peakPoint: SpectrumPoint = nowhere;
  private violation: MaskViolation | undefined;
  private hasHistorySpan = false;
  private historySpan = { start: 0, stop: 1 };
  private maskValue: FrequencyMask | undefined;
  private holdShown = true;
  private axesShown = false;
  private marker: number | undefined;

  constructor() {
    this.trace = this.scope.addChannel();
    this.hold = this.scope.addChannel();
    // The reference level may be any number of divisions away from 0 dBm.
    this.trace.isUnbounded = true;
    this.hold.isUnbounded = true;
    this.apply();
  }

  /** The mask, if any. */
  get mask(): FrequencyMask | undefined {
    return this.maskValue;
  }

  set mask(value: FrequencyMask | undefined) {
    this.maskValue = value;
    this.scope.touch();
  }

  /** Whether the max hold shows; true by default. */
  get showsMaxHold(): boolean {
    return this.holdShown;
  }

  set showsMaxHold(value: boolean) {
    this.holdShown = value;
    this.scope.touch();
  }

  /** Whether the trace shows as a density of all traces so far. */
  get showsDensity(): boolean {
    return this.scope.persistence === 'colorGrade';
  }

  set showsDensity(value: boolean) {
    this.scope.persistence = value ? 'colorGrade' : 'off';
  }

  /** Whether the frequency and level axes show. */
  get showsAxes(): boolean {
    return this.axesShown;
  }

  set showsAxes(value: boolean) {
    this.axesShown = value;
    this.scope.touch();
  }

  /** The frequency of the marker; the peak when left out. */
  get markerFrequency(): number | undefined {
    return this.marker;
  }

  set markerFrequency(value: number | undefined) {
    this.marker = value;
    this.scope.touch();
  }

  /** The further markers, at most five. */
  get extraMarkers(): readonly number[] {
    return this.extras;
  }

  /** The point of the marker: at its frequency, or the peak. */
  get markerPoint(): SpectrumPoint {
    return this.marker === undefined ? this.peakPoint : this.readPoint(this.marker);
  }

  /** The highest point of the latest trace. */
  get peak(): SpectrumPoint {
    return this.peakPoint;
  }

  /** The worst point above the mask in the latest trace, if any. */
  get lastViolation(): MaskViolation | undefined {
    return this.violation;
  }

  /** Grows with every change. */
  get version(): number {
    return this.scope.version;
  }

  /** The lowest frequency shown. */
  get start(): number {
    return this.viewStart;
  }

  /** The highest frequency shown. */
  get stop(): number {
    return this.viewStop;
  }

  /** The lowest frequency of the history. */
  get historyStart(): number {
    return this.historySpan.start;
  }

  /** The highest frequency of the history. */
  get historyStop(): number {
    return this.historySpan.stop;
  }

  /** The level at the top of the screen in dBm. */
  get referenceLevel(): number {
    return this.reference;
  }

  /** The dB per division. */
  get perDivision(): number {
    return this.perDivisionValue;
  }

  /** Adds a marker; nothing beyond five. */
  addMarker(frequency: number): void {
    if (this.extras.length >= maximumExtraMarkers) {
      return;
    }
    this.extras = [...this.extras, frequency];
    this.scope.touch();
  }

  /** Removes the marker within the tolerance of the frequency; false when there is none. */
  removeMarker(frequency: number, tolerance: number): boolean {
    const index = this.extras.findIndex((marker) => Math.abs(marker - frequency) <= tolerance);
    if (index < 0) {
      return false;
    }
    this.extras = this.extras.filter((_, i) => i !== index);
    this.scope.touch();
    return true;
  }

  /** The point of the trace at or above the frequency. */
  readPoint(frequency: number): SpectrumPoint {
    const snapshot = this.trace.data.snapshot();
    const count = snapshot.count;
    if (count === 0) {
      return nowhere;
    }
    let low = 0;
    let high = count - 1;
    let index = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const value = snapshot.x[middle] as number;
      if (value === frequency) {
        index = middle;
        break;
      }
      if (value < frequency) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (index < 0) {
      index = Math.min(low, count - 1);
    }
    return { frequency: snapshot.x[index] as number, level: snapshot.y[index] as number };
  }

  /**
   * Shows the frequencies from start to stop and the levels from the reference down eight divisions.
   * @throws RangeError when stop is not above start or the dB per division are not positive.
   */
  setView(start: number, stop: number, referenceLevel: number, perDivision = 10): void {
    if (!(stop > start)) {
      throw new RangeError('The stop must be above the start.');
    }
    if (!(perDivision > 0)) {
      throw new RangeError('The dB per division must be positive.');
    }
    this.viewStart = start;
    this.viewStop = stop;
    this.reference = referenceLevel;
    this.perDivisionValue = perDivision;
    if (!this.hasHistorySpan) {
      this.historySpan = { start, stop };
      this.hasHistorySpan = true;
    }
    this.apply();
  }

  /** Shows a new trace: frequencies rising, levels in dBm (kept as 32-bit floats). */
  setTrace(frequencies: ArrayLike<number>, levels: ArrayLike<number>): void {
    const values = Float32Array.from(levels);
    this.peakPoint = findSpectrumPeak(frequencies, values);
    if (this.maxHold.length !== values.length) {
      this.maxHold = values.slice();
      this.holdFrequencies = Float64Array.from(frequencies);
    }
    for (let i = 0; i < values.length; i++) {
      this.maxHold[i] = Math.max(this.maxHold[i] as number, values[i] as number);
    }
    this.hold.setWaveform(this.holdFrequencies, this.maxHold);
    const violation = this.maskValue?.check(frequencies, values);
    this.violation = violation;
    this.addHistory(frequencies, values);
    this.trace.setWaveform(frequencies, values);
    if (violation) {
      this.onMaskViolated?.(violation);
    }
  }

  /** Starts the max hold anew with the next trace. */
  clearMaxHold(): void {
    this.maxHold = new Float32Array(0);
  }

  // Each column keeps its highest level: a short carrier must not slip between two columns.
  private addHistory(frequencies: ArrayLike<number>, levels: Float32Array): void {
    const width = (this.historySpan.stop - this.historySpan.start) / historyColumns;
    const row = this.historyRow;
    row.fill(Number.NEGATIVE_INFINITY);
    for (let i = 0; i < levels.length; i++) {
      const column = Math.trunc(((frequencies[i] as number) - this.historySpan.start) / width);
      if (column >= 0 && column < historyColumns) {
        row[column] = Math.max(row[column] as number, levels[i] as number);
      }
    }
    for (let i = 1; i < historyColumns; i++) {
      if (row[i] === Number.NEGATIVE_INFINITY) {
        row[i] = row[i - 1] as number;
      }
    }
    this.history.appendRow(row);
  }

  private apply(): void {
    this.scope.timePerDivision = (this.viewStop - this.viewStart) / divisions;
    this.scope.timeOffset = (this.viewStart + this.viewStop) / 2;
    for (const channel of this.scope.channels) {
      channel.voltsPerDivision = this.perDivisionValue;
      channel.position = -(this.reference / this.perDivisionValue - scopeVerticalDivisions / 2);
    }
  }
}
