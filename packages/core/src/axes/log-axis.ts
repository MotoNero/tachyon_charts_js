// An axis with a logarithmic scale, major ticks at powers of the base (LogAxis of the .NET version).
import { invariantCulture } from '../locale/culture';
import { formatGeneral, formatScientific } from '../locale/format';
import { power } from '../numerics/nice';
import { DoubleRange } from '../numerics/range';
import { LogScaling, SymLogScaling, type AxisScaling } from '../numerics/scaling';
import { Axis, emptyTicks, type AxisPosition, type AxisTick, type TextMeasurer, type TickSet } from './axis';

/** What a logarithmic axis does with values at or below zero: leave them out, put them on a floor, or show them. */
export type NonPositiveValues = 'hide' | 'clamp' | 'symlog';

const minimumTickSpacing = 40;
const minimumMinorSpacing = 4;
const defaultFloor = 1e-3;
const relativeFloor = 1e-6;
const maximumTicks = 512;
// The logarithm of an exact power misses the integer by a rounding error: log(1000) / log(10) < 3.
const powerTolerance = 1e-9;
const smallestPositive = Number.MIN_VALUE;

/** An axis with a logarithmic scale. */
export class LogAxis extends Axis {
  private logBase = 10;
  private floorValue = defaultFloor;
  private threshold = 1;
  private mode: NonPositiveValues = 'hide';
  private cachedScaling: AxisScaling | undefined;

  // Makes the protected constructor of the base public.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(id: string, position: AxisPosition) {
    super(id, position);
  }

  /** The base, greater than 1. */
  get base(): number {
    return this.logBase;
  }

  set base(value: number) {
    if (!Number.isFinite(value) || value <= 1) {
      throw new RangeError(`The base must be greater than one, not ${String(value)}.`);
    }
    this.logBase = value;
    this.reset();
  }

  /** What happens to values at or below zero: hidden, clamped to the floor, or shown on a symmetric scale. */
  get nonPositive(): NonPositiveValues {
    return this.mode;
  }

  set nonPositive(value: NonPositiveValues) {
    this.mode = value;
    this.reset();
  }

  /** The floor of the clamp mode, positive. */
  get floor(): number {
    return this.floorValue;
  }

  set floor(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`The floor must be positive, not ${String(value)}.`);
    }
    this.floorValue = value;
    this.reset();
  }

  /** The range around zero that the symlog mode shows linearly, positive. */
  get linearThreshold(): number {
    return this.threshold;
  }

  set linearThreshold(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`The threshold must be positive, not ${String(value)}.`);
    }
    this.threshold = value;
    this.reset();
  }

  /** The logarithm, or the symmetric logarithm for values of both signs. */
  override get scaling(): AxisScaling {
    if (!this.cachedScaling) {
      if (this.mode === 'symlog') this.cachedScaling = new SymLogScaling(this.logBase, this.threshold);
      else if (this.mode === 'clamp') this.cachedScaling = new LogScaling(this.logBase, this.floorValue);
      else this.cachedScaling = new LogScaling(this.logBase);
    }
    return this.cachedScaling;
  }

  /** {@inheritDoc Axis.generateTicks} */
  generateTicks(length: number, measurer: TextMeasurer): TickSet {
    if (!Number.isFinite(length) || length < 0) {
      throw new RangeError(`The length must not be negative or infinite, not ${String(length)}.`);
    }
    const range = this.visibleRange;
    const scaling = this.scaling;
    const low = scaling.forward(range.min);
    const high = scaling.forward(range.max);
    if (length === 0 || !(high > low)) {
      return emptyTicks;
    }
    const pixelsPerDecade = length / (high - low);
    const spacing = Math.max(minimumTickSpacing, measurer.lineHeight * 1.5);
    let step = Math.max(1, Math.ceil(spacing / pixelsPerDecade));
    let values = this.createValues(range, step, (measurer.lineHeight * 1.2) / pixelsPerDecade);
    let labels = values.map(format);
    // Text wider than the distance needs a coarser step on a horizontal axis.
    while (
      this.isHorizontal &&
      labels.length > 1 &&
      Math.max(...labels.map((label) => measurer.measureWidth(label))) + 8 > step * pixelsPerDecade
    ) {
      step++;
      values = this.createValues(range, step, 0);
      labels = values.map(format);
    }
    const major: AxisTick[] = values.map((value, i) => ({ value, label: labels[i] ?? '' }));
    return { major, minor: this.createMinorValues(range, step, pixelsPerDecade), step };
  }

  /** {@inheritDoc Axis.normalizeRange} */
  protected override normalizeRange(range: DoubleRange): DoubleRange {
    if (this.mode === 'symlog') {
      return range;
    }
    const limit = this.mode === 'clamp' ? this.floorValue : smallestPositive;
    const max = Math.max(range.max, limit);
    const min = range.min > 0 ? Math.max(range.min, limit) : Math.max(max * relativeFloor, limit);
    return new DoubleRange(Math.min(min, max), max);
  }

  private reset(): void {
    this.cachedScaling = undefined;
    this.changed();
  }

  private createValues(range: DoubleRange, step: number, zeroClearance: number): number[] {
    if (this.mode === 'symlog') {
      return this.createSymLogValues(range, step, zeroClearance);
    }
    const scaling = this.scaling;
    const first = Math.ceil(scaling.forward(range.min) / step - powerTolerance);
    const last = Math.floor(scaling.forward(range.max) / step + powerTolerance);
    const values: number[] = [];
    for (let i = first; i <= last && values.length < maximumTicks; i++) {
      const value = power(this.logBase, i * step);
      if (range.contains(value)) {
        values.push(value);
      }
    }
    return values;
  }

  // The ticks next to zero are left out when their labels would touch the one of zero.
  private createSymLogValues(range: DoubleRange, step: number, zeroClearance: number): number[] {
    const scaling = this.scaling;
    const factor = power(this.logBase, step);
    const values: number[] = [];
    if (range.contains(0)) {
      values.push(0);
    }
    const reach = Math.max(Math.abs(range.min), Math.abs(range.max));
    for (let value = this.threshold; value <= reach && values.length < maximumTicks; value *= factor) {
      if (scaling.forward(value) < zeroClearance) {
        continue;
      }
      if (range.contains(value)) {
        values.push(value);
      }
      if (range.contains(-value)) {
        values.unshift(-value);
      }
    }
    return values;
  }

  // Multiples of each power, for integer bases and only while single decades are drawn.
  private createMinorValues(range: DoubleRange, step: number, pixelsPerDecade: number): number[] {
    const steps = Math.trunc(this.logBase);
    if (step !== 1 || steps < 3 || steps !== this.logBase || this.mode === 'symlog') {
      return [];
    }
    const firstGap = (Math.log(2) / Math.log(this.logBase)) * pixelsPerDecade;
    const lastGap = (Math.log(this.logBase / (this.logBase - 1)) / Math.log(this.logBase)) * pixelsPerDecade;
    if (Math.min(firstGap, lastGap) < minimumMinorSpacing) {
      return [];
    }
    const scaling = this.scaling;
    const minor: number[] = [];
    const last = Math.ceil(scaling.forward(range.max) - powerTolerance);
    for (
      let i = Math.floor(scaling.forward(range.min) + powerTolerance);
      i <= last && minor.length < maximumTicks;
      i++
    ) {
      const decade = power(this.logBase, i);
      for (let factor = 2; factor < steps; factor++) {
        const value = decade * factor;
        if (range.contains(value)) {
          minor.push(value);
        }
      }
    }
    return minor;
  }
}

function format(value: number): string {
  const magnitude = Math.abs(value);
  return magnitude >= 1e5 || (magnitude > 0 && magnitude < 1e-3)
    ? formatScientific(value, 3, true, invariantCulture)
    : formatGeneral(value, 4, invariantCulture);
}
