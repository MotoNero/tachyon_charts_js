// A linear axis with ticks on round numbers (NumericAxis and NumericLabelFormat of the .NET version).
import { chartText, type Culture } from '../locale/culture';
import { formatFixed, formatScientific } from '../locale/format';
import { niceStep, power, roundHalfEven } from '../numerics/nice';
import type { DoubleRange } from '../numerics/range';
import { Axis, emptyTicks, type AxisPosition, type AxisTick, type TextMeasurer, type TickSet } from './axis';

const scientificExponent = 15;
const smallestPrefixExponent = -24;
const siPrefixes = ['y', 'z', 'a', 'f', 'p', 'n', 'µ', 'm', '', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];

/** How a numeric axis writes its labels. All ticks share one precision and one SI prefix, so they read as one scale. */
export interface NumericLabelFormat {
  /** The culture of the numbers; the language of the charts when left out. */
  readonly culture?: Culture;
  /** Whether large and small numbers use SI prefixes such as k and µ. */
  readonly useSiPrefixes?: boolean;
  /** The unit behind the number, such as V. */
  readonly unit?: string;
}

/** Writes the labels of ticks at a step. */
export function formatTicks(format: NumericLabelFormat, values: readonly number[], step: number): string[] {
  let largest = 0;
  for (const value of values) {
    largest = Math.max(largest, Math.abs(value));
  }
  const culture = format.culture ?? chartText.culture;
  const unit = format.unit ?? '';
  const magnitude = largest > 0 ? Math.floor(Math.log10(largest)) : 0;
  const stepExponent = Math.floor(Math.log10(step) + 1e-9);
  const decorate = (number: string, prefix: string): string => {
    if (prefix.length === 0 && unit.length === 0) return number;
    return unit.length === 0 ? number + prefix : `${number} ${prefix}${unit}`;
  };
  if (format.useSiPrefixes) {
    const prefixExponent = Math.floor(magnitude / 3) * 3;
    const index = (prefixExponent - smallestPrefixExponent) / 3;
    const prefix = siPrefixes[index];
    if (prefix !== undefined) {
      const scale = power(10, prefixExponent);
      const decimals = Math.max(0, prefixExponent - stepExponent);
      return values.map((value) =>
        decorate(formatFixed(withoutNegativeZero(value / scale, decimals), decimals, culture), prefix),
      );
    }
  }
  if (magnitude >= scientificExponent || stepExponent <= -scientificExponent) {
    const digits = Math.max(0, magnitude - stepExponent);
    return values.map((value) => decorate(value === 0 ? '0' : formatScientific(value, digits, false, culture), ''));
  }
  const decimals = Math.max(0, -stepExponent);
  return values.map((value) => decorate(formatFixed(withoutNegativeZero(value, decimals), decimals, culture), ''));
}

// Rounding must not print "-0.0".
function withoutNegativeZero(value: number, decimals: number): number {
  return Math.abs(value) < 0.5 * power(10, -decimals) ? 0 : value;
}

const snapTolerance = 1e-9;
const minimumTickSpacing = 48;
const labelGap = 8;
const minimumMinorSpacing = 4;
const maximumCoarsening = 64;

/** A linear axis with ticks on round numbers. */
export class NumericAxis extends Axis {
  /** How labels are written. */
  labelFormat: NumericLabelFormat = {};

  // Makes the protected constructor of the base public.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(id: string, position: AxisPosition) {
    super(id, position);
  }

  /**
   * A value under the cursor: with the unit and SI prefix of the label format where it has one, to a thousandth of
   * the visible range; otherwise with six significant digits.
   */
  override formatCursorValue(value: number): string {
    const format = this.labelFormat;
    const span = Math.abs(this.visibleRange.max - this.visibleRange.min);
    if (
      (!format.useSiPrefixes && (format.unit ?? '').length === 0) ||
      !Number.isFinite(value) ||
      !(span > 0) ||
      !Number.isFinite(span)
    ) {
      return super.formatCursorValue(value);
    }
    return formatTicks(format, [value], span / 1000)[0] ?? '';
  }

  /** {@inheritDoc Axis.generateTicks} */
  generateTicks(length: number, measurer: TextMeasurer): TickSet {
    if (!Number.isFinite(length) || length < 0) {
      throw new RangeError(`The length must not be negative, not ${String(length)}.`);
    }
    const range = this.visibleRange;
    if (length === 0 || !Number.isFinite(range.length)) {
      return emptyTicks;
    }
    if (range.length === 0) {
      return this.singleTick(range.min);
    }
    const span = range.length;
    const intervals = Math.max(Math.trunc(length / Math.max(minimumTickSpacing, measurer.lineHeight + labelGap)), 1);
    let step = niceStep(span, intervals);
    for (let attempt = 0; attempt < maximumCoarsening; attempt++) {
      const values = createTicks(range, step);
      if (values.length === 0) {
        return this.singleTick(range.center);
      }
      const labels = formatTicks(this.labelFormat, values, step);
      if (this.fits(labels, step, length / span, measurer)) {
        const major: AxisTick[] = values.map((value, i) => ({ value, label: labels[i] ?? '' }));
        return { major, minor: createMinorTicks(range, step, length), step };
      }
      step = nextStep(step);
    }
    return this.singleTick(range.center);
  }

  private fits(labels: string[], step: number, unitsPerData: number, measurer: TextMeasurer): boolean {
    const spacing = step * unitsPerData;
    if (labels.length < 2) {
      return true;
    }
    if (!this.isHorizontal) {
      return spacing >= measurer.lineHeight + labelGap;
    }
    // Centered labels: half of each neighbor reaches into the space between two ticks.
    for (let i = 1; i < labels.length; i++) {
      const needed =
        (measurer.measureWidth(labels[i - 1] ?? '') + measurer.measureWidth(labels[i] ?? '')) / 2 + labelGap;
      if (spacing < needed) {
        return false;
      }
    }
    return true;
  }

  private singleTick(value: number): TickSet {
    const magnitude = value !== 0 ? Math.abs(value) : 1;
    return {
      major: [{ value, label: formatTicks(this.labelFormat, [value], magnitude / 1000)[0] ?? '' }],
      minor: [],
      step: 0,
    };
  }
}

function nextStep(step: number): number {
  const tenth = power(10, Math.floor(Math.log10(step) + snapTolerance));
  const mantissa = roundHalfEven(step / tenth);
  if (mantissa === 1) return 2 * tenth;
  if (mantissa === 2) return 5 * tenth;
  return 10 * tenth;
}

function createTicks(range: DoubleRange, step: number): number[] {
  const first = Math.ceil(range.min / step - snapTolerance);
  const last = Math.floor(range.max / step + snapTolerance);
  const count = last - first + 1;
  if (!(count >= 1) || count > 100_000 || first * step === (first + 1) * step) {
    return [];
  }
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    values.push(snap((first + i) * step, step));
  }
  return values;
}

function createMinorTicks(range: DoubleRange, step: number, length: number): number[] {
  const divisions = roundHalfEven(step / power(10, Math.floor(Math.log10(step) + snapTolerance))) === 2 ? 4 : 5;
  const minorStep = step / divisions;
  if (minorStep * (length / range.length) < minimumMinorSpacing) {
    return [];
  }
  const first = Math.ceil(range.min / minorStep - snapTolerance);
  const last = Math.floor(range.max / minorStep + snapTolerance);
  const minor: number[] = [];
  for (let index = first; index <= last; index++) {
    // Every n-th minor tick falls on a major tick.
    if (Math.abs(ieeeRemainder(index, divisions)) > 0.5) {
      minor.push(snap(index * minorStep, minorStep));
    }
  }
  return minor;
}

/** Math.IEEERemainder of .NET: x - y · round(x / y), the quotient rounded to even. */
function ieeeRemainder(x: number, y: number): number {
  return x - y * roundHalfEven(x / y);
}

// Multiples such as 3 * 0.1 miss the round value by a rounding error, and zero must be exact.
function snap(value: number, step: number): number {
  return Math.abs(value) < step * snapTolerance ? 0 : value;
}
