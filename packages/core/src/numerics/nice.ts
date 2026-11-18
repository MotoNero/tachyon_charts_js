// Round numbers of the form 1, 2 or 5 times a power of ten, as used for axis ticks (NiceNumbers of the .NET version).
import { DoubleRange } from './range';

/** The nice step that divides a length into about the wanted number of intervals. */
export function niceStep(length: number, targetIntervals: number): number {
  if (!Number.isInteger(targetIntervals) || targetIntervals <= 0) {
    throw new RangeError(`The number of intervals must be positive, not ${String(targetIntervals)}.`);
  }
  if (!Number.isFinite(length) || length <= 0) {
    throw new RangeError(`The length must be positive and finite, not ${String(length)}.`);
  }
  return roundToNice(length / targetIntervals);
}

/** The range a step extends a range to, aligned to multiples of the step. Rounding or overflow never cut the range. */
export function alignToStep(range: DoubleRange, step: number): DoubleRange {
  if (range.isEmpty) {
    throw new RangeError('An empty range cannot be aligned.');
  }
  if (!Number.isFinite(step) || step <= 0) {
    throw new RangeError(`The step must be positive and finite, not ${String(step)}.`);
  }
  const min = Math.floor(range.min / step) * step;
  const max = Math.ceil(range.max / step) * step;
  return new DoubleRange(
    Number.isFinite(min) ? Math.min(min, range.min) : range.min,
    Number.isFinite(max) ? Math.max(max, range.max) : range.max,
  );
}

/**
 * A power as Math.Pow of .NET gives it. Whole powers of ten are read from text, which is rounded correctly: the
 * Math.pow of JavaScript misses some of them, 10 to the -5 among them, by a bit.
 */
export function power(base: number, exponent: number): number {
  if (base === 10 && Number.isInteger(exponent)) {
    return Number(`1e${String(exponent)}`);
  }
  return Math.pow(base, exponent);
}

/** Rounds as Math.Round of .NET does: halves to the even neighbor. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest !== 0.5) {
    return Math.round(value);
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

// Rounds a positive value to the nearest nice number on a logarithmic scale.
function roundToNice(value: number): number {
  const exponent = Math.floor(Math.log10(value));
  const tenth = power(10, exponent);
  // Subnormal values have no representable power of ten.
  if (tenth === 0 || !Number.isFinite(tenth)) {
    return value;
  }
  const fraction = value / tenth;
  let nice = 10;
  if (fraction < 1.5) nice = 1;
  else if (fraction < 3.5) nice = 2;
  else if (fraction < 7.5) nice = 5;
  const result = nice * tenth;
  return Number.isFinite(result) ? result : value;
}
