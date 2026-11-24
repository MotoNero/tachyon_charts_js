// A time axis with ticks on calendar boundaries of its time zone (DateTimeAxis of the .NET version).
import { chartText, type Culture } from '../locale/culture';
import { TimeZone, wallTime } from '../locale/time-zone';
import { DoubleRange } from '../numerics/range';
import type { AxisScaling } from '../numerics/scaling';
import { Axis, emptyTicks, type AxisPosition, type AxisTick, type TextMeasurer, type TickSet } from './axis';
import { TimeGapScaling, type TimeGapMap } from './time-gaps';

/** What one unit of a time value means; all count from 1970-01-01 UTC. */
export type TimeResolution = 'milliseconds' | 'ticks' | 'nanoseconds';

const nanosecondsPerUnit: Record<TimeResolution, number> = { milliseconds: 1e6, ticks: 100, nanoseconds: 1 };
const targetSpacing = 72;
const labelGap = 8;
const maximumTicks = 4000;
const hour = 3_600_000;
const day = 24 * hour;
// The calendar of the .NET version ends with 9999 and starts with year 1, in units of 100 ns since 1970.
const firstTick = -621_355_968_000_000_000n;
const lastTick = 3_155_378_975_999_999_999n + firstTick;
const lastYear = 9999;
// Days from 0001-01-01 to 1970-01-01, so that steps of days count as in the .NET version.
const daysBefore1970 = 719_162;

type StepKind = 'fixed' | 'hours' | 'days' | 'weeks' | 'months' | 'years';

interface TickStep {
  readonly kind: StepKind;
  readonly factor: number;
  readonly nanoseconds: number;
}

const steps = createSteps();

function createSteps(): TickStep[] {
  const microsecond = 1e3;
  const millisecond = 1e6;
  const second = 1e9;
  const minute = 60 * second;
  const hours = 60 * minute;
  const days = 24 * hours;
  const month = 30.44 * days;
  const year = 365.25 * days;
  const list: TickStep[] = [];
  for (const unit of [1, microsecond, millisecond]) {
    for (const factor of [1, 2, 5, 10, 20, 50, 100, 200, 500]) {
      list.push({ kind: 'fixed', factor, nanoseconds: factor * unit });
    }
  }
  for (const unit of [second, minute]) {
    for (const factor of [1, 2, 5, 10, 15, 30]) {
      list.push({ kind: 'fixed', factor, nanoseconds: factor * unit });
    }
  }
  list.push({ kind: 'fixed', factor: 1, nanoseconds: hours });
  for (const factor of [2, 3, 6, 12]) {
    list.push({ kind: 'hours', factor, nanoseconds: factor * hours });
  }
  list.push(
    { kind: 'days', factor: 1, nanoseconds: days },
    { kind: 'days', factor: 2, nanoseconds: 2 * days },
    { kind: 'weeks', factor: 1, nanoseconds: 7 * days },
  );
  for (const factor of [1, 3, 6]) {
    list.push({ kind: 'months', factor, nanoseconds: factor * month });
  }
  for (const factor of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) {
    list.push({ kind: 'years', factor, nanoseconds: factor * year });
  }
  return list;
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

function pad(value: number, digits: number): string {
  return String(value).padStart(digits, '0');
}

/** The mapping of times to pixels. */
export class DateTimeAxisTransform {
  private readonly pixelsPerUnit: number;
  private readonly scaleStart: bigint;

  constructor(
    first: bigint,
    last: bigint,
    private readonly pixelStart: number,
    pixelEnd: number,
    private readonly gaps?: TimeGapMap,
  ) {
    this.scaleStart = gaps ? gaps.compress(first) : first;
    const scaleEnd = gaps ? gaps.compress(last) : last;
    this.pixelsPerUnit = scaleEnd > this.scaleStart ? (pixelEnd - pixelStart) / Number(scaleEnd - this.scaleStart) : 0;
  }

  /** A time as a pixel position; the gaps take no room. */
  toPixel(time: bigint): number {
    const position = this.gaps ? this.gaps.compress(time) : time;
    return this.pixelStart + Number(position - this.scaleStart) * this.pixelsPerUnit;
  }

  /** A pixel position as the nearest time. */
  toTime(pixel: number): bigint {
    const units = this.pixelsPerUnit === 0 ? 0 : Math.round((pixel - this.pixelStart) / this.pixelsPerUnit);
    const position = this.scaleStart + BigInt(units);
    return this.gaps ? this.gaps.expand(position) : position;
  }
}

/**
 * A time axis with ticks on calendar boundaries of its time zone. Times are integers since 1970-01-01 UTC in the unit
 * of the resolution, as `bigint` because a double cannot hold today's nanoseconds. The range of the base class counts
 * from {@link DateTimeAxis.origin} in the same unit.
 */
export class DateTimeAxis extends Axis {
  private originTime = 0n;
  private gapMap: TimeGapMap | undefined;
  private gapScaling: TimeGapScaling | undefined;
  private zone = TimeZone.utc;
  private ownCulture: Culture | undefined;
  private readonly perUnit: number;
  private readonly unitsPerMillisecond: bigint;

  /**
   * @param resolution - The unit of the times: milliseconds as in `Date`, ticks of 100 ns, or nanoseconds.
   */
  constructor(
    id: string,
    position: AxisPosition,
    /** The unit of the times: milliseconds as in `Date`, ticks of 100 ns, or nanoseconds. */
    readonly resolution: TimeResolution = 'milliseconds',
  ) {
    super(id, position);
    if (!(resolution in nanosecondsPerUnit)) {
      throw new RangeError(`"${resolution}" is no time resolution.`);
    }
    this.perUnit = nanosecondsPerUnit[resolution];
    this.unitsPerMillisecond = BigInt(1e6 / this.perUnit);
  }

  /** The time the range of the base class counts from. */
  get origin(): bigint {
    return this.originTime;
  }

  /** The intervals the axis leaves out, such as weekends; they take no room, and zooming, panning and the pointer go across them. */
  get gaps(): TimeGapMap | undefined {
    return this.gapMap;
  }

  set gaps(value: TimeGapMap | undefined) {
    this.gapMap = value;
    this.gapScaling = undefined;
    this.changed();
  }

  /** {@inheritDoc Axis.scaling} */
  override get scaling(): AxisScaling | undefined {
    const gaps = this.gapMap;
    if (!gaps) {
      return undefined;
    }
    // The scale counts from the origin like the values of the axis, so it follows a new origin.
    if (this.gapScaling?.origin !== this.originTime || this.gapScaling.gaps !== gaps) {
      this.gapScaling = new TimeGapScaling(gaps, this.originTime);
    }
    return this.gapScaling;
  }

  /** The zone of labels and calendar boundaries, a name of the IANA database such as `Europe/Berlin`. */
  get timeZone(): string {
    return this.zone.name;
  }

  set timeZone(value: string) {
    const zone = TimeZone.of(value);
    if (zone !== this.zone) {
      this.zone = zone;
      this.changed();
    }
  }

  /** The culture of names and dates; `undefined` follows the language of the charts. */
  get culture(): Culture | undefined {
    return this.ownCulture;
  }

  set culture(value: Culture | undefined) {
    if (value !== this.ownCulture) {
      this.ownCulture = value;
      this.changed();
    }
  }

  /**
   * Sets the visible time. Like setting the range, this ends the automatic range.
   * @throws RangeError when the end lies before the start or a number is no safe integer.
   */
  setVisibleTime(start: bigint | number, end: bigint | number): void {
    const first = DateTimeAxis.toTime(start);
    const last = DateTimeAxis.toTime(end);
    if (last < first) {
      throw new RangeError(`The end ${String(last)} lies before the start ${String(first)}.`);
    }
    this.moveOrigin(first);
    this.visibleRange = new DoubleRange(0, Number(last - first));
  }

  /**
   * Applies the time range of the data while the automatic range is on.
   * @throws RangeError when the last time lies before the first or a number is no safe integer.
   */
  fitToTime(first: bigint | number, last: bigint | number, padding = 0): void {
    const from = DateTimeAxis.toTime(first);
    const to = DateTimeAxis.toTime(last);
    if (to < from) {
      throw new RangeError(`The last time ${String(to)} lies before the first ${String(from)}.`);
    }
    if (this.isAutoRange) {
      this.moveOrigin(from);
      this.fitTo(new DoubleRange(0, Number(to - from)), padding);
    }
  }

  /** The value of the base class range at a time. */
  valueAt(time: bigint): number {
    return Number(time - this.originTime);
  }

  /** The time at a value of the base class range, to the unit. */
  timeAt(value: number): bigint {
    return this.originTime + BigInt(Math.round(value));
  }

  /** The time at a value of the axis, in its zone, as "yyyy-MM-dd HH:mm:ss". */
  override formatCursorValue(value: number): string {
    if (!Number.isFinite(value)) {
      return super.formatCursorValue(value);
    }
    const wall = this.zone.toWall(this.milliseconds(this.originTime + BigInt(Math.trunc(value))));
    const time = new Date(wall);
    return (
      `${pad(time.getUTCFullYear(), 4)}-${pad(time.getUTCMonth() + 1, 2)}-${pad(time.getUTCDate(), 2)} ` +
      `${pad(time.getUTCHours(), 2)}:${pad(time.getUTCMinutes(), 2)}:${pad(time.getUTCSeconds(), 2)}`
    );
  }

  /** The mapping of times to pixels. */
  createTimeTransform(start: number, length: number): DateTimeAxisTransform {
    if (!(length >= 0)) {
      throw new RangeError(`The length must not be negative, not ${String(length)}.`);
    }
    const [first, last] = this.visibleTime();
    const forward = this.isHorizontal !== this.isInverted;
    return new DateTimeAxisTransform(
      first,
      last,
      forward ? start : start + length,
      forward ? start + length : start,
      this.gapMap,
    );
  }

  /** {@inheritDoc Axis.generateTicks} */
  generateTicks(length: number, measurer: TextMeasurer): TickSet {
    if (!Number.isFinite(length) || length < 0) {
      throw new RangeError(`The length must not be negative, not ${String(length)}.`);
    }
    const [first, last] = this.visibleTime();
    if (length === 0) {
      return emptyTicks;
    }
    if (last <= first) {
      return this.singleTick(first);
    }
    const transform = this.createTimeTransform(0, length);
    const visible = this.gapMap ? this.gapMap.compress(last) - this.gapMap.compress(first) : last - first;
    const target = (Number(visible) * this.perUnit) / Math.max(length / targetSpacing, 1);
    for (const step of steps) {
      if (step.nanoseconds < target || (step.kind === 'fixed' && step.nanoseconds < this.perUnit)) {
        continue;
      }
      const times = this.createTimes(step, first, last);
      if (times === undefined) {
        continue;
      }
      if (times.length === 0) {
        return emptyTicks;
      }
      const labels = this.createLabels(step, times);
      if (this.fits(times, labels, transform, measurer)) {
        const major: AxisTick[] = times.map((time, i) => ({ value: this.valueAt(time), label: labels[i] ?? '' }));
        return { major, minor: [], step: step.nanoseconds / this.perUnit };
      }
    }
    return this.singleTick(first);
  }

  private static toTime(value: bigint | number): bigint {
    if (typeof value === 'bigint') {
      return value;
    }
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`A time must be a safe integer, not ${String(value)}.`);
    }
    return BigInt(value);
  }

  private moveOrigin(time: bigint): void {
    if (time !== this.originTime) {
      this.originTime = time;
      this.changed();
    }
  }

  private visibleTime(): [bigint, bigint] {
    const range = this.visibleRange;
    return [this.originTime + BigInt(Math.floor(range.min)), this.originTime + BigInt(Math.ceil(range.max))];
  }

  private get cultureOrDefault(): Culture {
    return this.ownCulture ?? chartText.culture;
  }

  private ticksOf(time: bigint): bigint {
    return this.resolution === 'nanoseconds' ? time / 100n : (time * BigInt(this.perUnit)) / 100n;
  }

  private milliseconds(time: bigint): number {
    return Number(floorDiv(time, this.unitsPerMillisecond));
  }

  private createTimes(step: TickStep, first: bigint, last: bigint): bigint[] | undefined {
    if (this.ticksOf(first) < firstTick || this.ticksOf(last) > lastTick) {
      return [];
    }
    return step.kind === 'fixed'
      ? this.createFixedTimes(step, first, last)
      : this.createCalendarTimes(step, first, last);
  }

  private createFixedTimes(step: TickStep, first: bigint, last: bigint): bigint[] | undefined {
    const stepUnits = BigInt(Math.trunc(step.nanoseconds / this.perUnit));
    if ((last - first) / stepUnits > BigInt(maximumTicks)) {
      return undefined;
    }
    // The offset aligns steps such as 30 minutes with the local clock in every time zone.
    const offset = BigInt(this.zone.offsetAt(this.milliseconds(first))) * this.unitsPerMillisecond;
    let time = floorDiv(first + offset, stepUnits) * stepUnits - offset;
    if (time < first) {
      time += stepUnits;
    }
    const times: bigint[] = [];
    for (; time <= last; time += stepUnits) {
      if (this.gapMap?.isHidden(time) !== true) {
        times.push(time);
      }
    }
    return times;
  }

  private createCalendarTimes(step: TickStep, first: bigint, last: bigint): bigint[] | undefined {
    let wall = DateTimeAxis.alignWall(step, this.zone.toWall(this.milliseconds(first)));
    const lastWall = this.zone.toWall(this.milliseconds(last)) + day;
    const times: bigint[] = [];
    while (wall <= lastWall) {
      // A wall time skipped by a clock change has no tick. Midnight still gets one at the first valid time.
      if (step.kind !== 'hours' || !this.zone.isInvalid(wall)) {
        const time = BigInt(this.zone.toUtc(wall)) * this.unitsPerMillisecond;
        if (time >= first && time <= last && this.gapMap?.isHidden(time) !== true) {
          times.push(time);
        }
      }
      if (times.length > maximumTicks) {
        return undefined;
      }
      if (lastYear - new Date(wall).getUTCFullYear() < 2 * step.factor) {
        break;
      }
      wall = DateTimeAxis.advance(step, wall);
    }
    return times;
  }

  private static alignWall(step: TickStep, wall: number): number {
    const time = new Date(wall);
    const year = time.getUTCFullYear();
    const month = time.getUTCMonth();
    const date = wallTime(year, month, time.getUTCDate());
    switch (step.kind) {
      case 'hours':
        return date + Math.trunc(time.getUTCHours() / step.factor) * step.factor * hour;
      case 'days': {
        const days = date / day + daysBefore1970;
        return date - (((days % step.factor) + step.factor) % step.factor) * day;
      }
      case 'weeks':
        return date - ((time.getUTCDay() + 6) % 7) * day;
      case 'months':
        return wallTime(year, Math.trunc(month / step.factor) * step.factor, 1);
      default:
        return wallTime(Math.max(Math.trunc(year / step.factor) * step.factor, 1), 0, 1);
    }
  }

  private static advance(step: TickStep, wall: number): number {
    const time = new Date(wall);
    switch (step.kind) {
      case 'hours':
        return wall + step.factor * hour;
      case 'days':
        return wall + step.factor * day;
      case 'weeks':
        return wall + 7 * day;
      case 'months':
        return wallTime(time.getUTCFullYear(), time.getUTCMonth() + step.factor, 1);
      default:
        return wallTime(time.getUTCFullYear() + step.factor, 0, 1);
    }
  }

  private createLabels(step: TickStep, times: readonly bigint[]): string[] {
    const culture = this.cultureOrDefault;
    return times.map((time, i) => this.formatLabel(step, time, i === 0, culture));
  }

  private formatLabel(step: TickStep, time: bigint, isFirst: boolean, culture: Culture): string {
    const local = new Date(this.zone.toWall(this.milliseconds(time)));
    const year = pad(local.getUTCFullYear(), 4);
    const month = local.getUTCMonth();
    const date = local.getUTCDate();
    switch (step.kind) {
      case 'years':
        return year;
      case 'months':
        return month === 0 || isFirst
          ? `${culture.abbreviatedMonths[month] ?? ''} ${year}`
          : (culture.abbreviatedMonths[month] ?? '');
      case 'days':
      case 'weeks':
        if (isFirst || (month === 0 && date === 1)) {
          return `${String(date)} ${culture.abbreviatedMonthsGenitive[month] ?? ''} ${year}`;
        }
        return date === 1 ? (culture.abbreviatedMonths[month] ?? '') : String(date);
      default:
        return this.formatClock(step, time, local, isFirst, culture);
    }
  }

  private formatClock(step: TickStep, time: bigint, local: Date, isFirst: boolean, culture: Culture): string {
    const clock = `${pad(local.getUTCHours(), 2)}:${pad(local.getUTCMinutes(), 2)}`;
    const seconds = pad(local.getUTCSeconds(), 2);
    const nanosecond = this.nanosecondOfSecond(time);
    if (step.nanoseconds >= 1e9) {
      const text = step.nanoseconds >= 60e9 ? clock : `${clock}:${seconds}`;
      const isMidnight = ((local.getTime() % day) + day) % day === 0 && nanosecond === 0;
      if (isMidnight || isFirst) {
        const date = `${String(local.getUTCDate())} ${culture.abbreviatedMonthsGenitive[local.getUTCMonth()] ?? ''}`;
        return isMidnight ? date : `${date} ${text}`;
      }
      return text;
    }
    let digits = 9;
    if (step.nanoseconds >= 1e6) {
      digits = 3;
    } else if (step.nanoseconds >= 1e3) {
      digits = 6;
    }
    const fraction = pad(nanosecond, 9).slice(0, digits);
    const whole = isFirst ? `${clock}:${seconds}` : seconds;
    return `${whole}${culture.decimalSeparator}${fraction}`;
  }

  private nanosecondOfSecond(time: bigint): number {
    const perSecond = BigInt(1e9 / this.perUnit);
    return Number((((time % perSecond) + perSecond) % perSecond) * BigInt(this.perUnit));
  }

  private fits(
    times: readonly bigint[],
    labels: readonly string[],
    transform: DateTimeAxisTransform,
    measurer: TextMeasurer,
  ): boolean {
    for (let i = 1; i < times.length; i++) {
      const distance = Math.abs(transform.toPixel(times[i] as bigint) - transform.toPixel(times[i - 1] as bigint));
      const needed = this.isHorizontal
        ? (measurer.measureWidth(labels[i - 1] ?? '') + measurer.measureWidth(labels[i] ?? '')) / 2 + labelGap
        : measurer.lineHeight + labelGap;
      if (distance < needed) {
        return false;
      }
    }
    return true;
  }

  private singleTick(time: bigint): TickSet {
    const culture = this.cultureOrDefault;
    const local = new Date(this.zone.toWall(this.milliseconds(time)));
    const label =
      `${String(local.getUTCDate())} ${culture.abbreviatedMonthsGenitive[local.getUTCMonth()] ?? ''} ` +
      `${pad(local.getUTCFullYear(), 4)} ${pad(local.getUTCHours(), 2)}:${pad(local.getUTCMinutes(), 2)}:` +
      pad(local.getUTCSeconds(), 2);
    return { major: [{ value: this.valueAt(time), label }], minor: [], step: 0 };
  }
}
