// The trigger of an oscilloscope, as ScopeTrigger of the .NET version: it finds an edge in a record of samples and
// shows the record with the edge at time 0.
import type { ScopeDisplay } from './scope-display';

/** The edge that triggers. */
export type TriggerSlope = 'rising' | 'falling' | 'either';
/** When the trigger shows a record: always (auto), only at an edge (normal) or once (single). */
export type TriggerMode = 'auto' | 'normal' | 'single';
/** What the trigger did with the last record. */
export type TriggerState = 'triggered' | 'auto' | 'waiting' | 'stopped';

const hysteresisDivisions = 0.1;

/**
 * The place of the first edge through the level from `start` on, in samples with a fraction; -1 when there is none.
 * The signal has to come from beyond the hysteresis first, so noise at the level does not trigger.
 */
export function findTriggerEdge(
  samples: ArrayLike<number>,
  level: number,
  hysteresis: number,
  slope: TriggerSlope,
  start = 0,
): number {
  let isBelow = false;
  let isAbove = false;
  for (let i = Math.max(start, 1); i < samples.length; i++) {
    const previous = samples[i - 1] as number;
    const current = samples[i] as number;
    if (slope !== 'falling' && isBelow && previous < level && current >= level) {
      return i - 1 + (level - previous) / (current - previous);
    }
    if (slope !== 'rising' && isAbove && previous > level && current <= level) {
      return i - 1 + (previous - level) / (previous - current);
    }
    isBelow ||= current < level - hysteresis;
    isAbove ||= current > level + hysteresis;
  }
  return -1;
}

/** Triggers records of samples for a display, at its trigger level on the source channel. */
export class ScopeTrigger {
  /** The edge; rising by default. */
  slope: TriggerSlope = 'rising';
  /** The mode; auto by default. */
  mode: TriggerMode = 'auto';
  /** The index of the source channel; 0 by default. */
  source = 0;
  /** The time after an edge in which no other edge triggers, in seconds. */
  holdoffSeconds = 0;
  private isArmed = true;
  private time = new Float64Array(0);
  private lastState: TriggerState = 'waiting';

  /** @param display - The display that shows the records. */
  constructor(private readonly display: ScopeDisplay) {}

  /** What the trigger did with the last record. */
  get state(): TriggerState {
    return this.lastState;
  }

  /** Arms a single trigger again. */
  arm(): void {
    this.isArmed = true;
    this.lastState = 'waiting';
    this.display.touch();
  }

  /**
   * Looks for an edge in a record and shows it on the display.
   * @param sampleInterval - The seconds between two samples.
   * @param channels - The samples of each channel, all of one length.
   * @throws RangeError when the interval is not positive.
   */
  process(sampleInterval: number, channels: readonly ArrayLike<number>[]): TriggerState {
    if (!(sampleInterval > 0)) {
      throw new RangeError('The sample interval must be positive.');
    }
    if (this.mode === 'single' && !this.isArmed) {
      return this.report('stopped');
    }
    const range = this.display.timeRange();
    const before = Math.ceil(-Math.min(range.min, 0) / sampleInterval);
    const source = channels[this.source];
    const channel = this.display.channels[this.source];
    if (!source || !channel) {
      return this.report('waiting');
    }
    const hysteresis = channel.voltsPerDivision * hysteresisDivisions;
    const level = this.display.triggerLevel;
    let edge = findTriggerEdge(source, level, hysteresis, this.slope, before);
    if (edge >= 0 && this.holdoffSeconds > 0) {
      const next = findTriggerEdge(
        source,
        level,
        hysteresis,
        this.slope,
        Math.trunc(edge) + Math.trunc(this.holdoffSeconds / sampleInterval),
      );
      edge = next >= 0 ? next : edge;
    }
    if (edge < 0) {
      if (this.mode !== 'auto') {
        return this.report('waiting');
      }
      this.show(sampleInterval, channels, source.length / 2);
      return this.report('auto');
    }
    this.show(sampleInterval, channels, edge);
    this.isArmed = this.mode !== 'single';
    return this.report('triggered');
  }

  private report(state: TriggerState): TriggerState {
    this.lastState = state;
    this.display.triggerStatus = state;
    this.display.touch();
    return state;
  }

  private show(sampleInterval: number, channels: readonly ArrayLike<number>[], origin: number): void {
    const length = channels[0]?.length ?? 0;
    if (this.time.length !== length) {
      this.time = new Float64Array(length);
    }
    // The fraction keeps the waveform still: the edge lies between two samples, not on one.
    for (let i = 0; i < length; i++) {
      this.time[i] = (i - origin) * sampleInterval;
    }
    const shown = this.display.channels;
    for (let c = 0; c < channels.length && c < shown.length; c++) {
      shown[c]?.setWaveform(this.time, channels[c] as ArrayLike<number>);
    }
  }
}
