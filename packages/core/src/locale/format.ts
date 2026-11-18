// Numbers written as the .NET version writes them, so that labels read the same in both: the standard formats F<n>
// and G<n> and the custom scientific formats of the axes, in the culture of the chart.
import type { Culture } from './culture';

function localize(text: string, culture: Culture): string {
  return culture.decimalSeparator === '.' ? text : text.replace('.', culture.decimalSeparator);
}

const bits = new DataView(new ArrayBuffer(8));

/**
 * Whether a positive finite value lies exactly halfway between two numbers with `decimals` digits after the point
 * (a negative count means places before it). The value is m · 2^e exactly; it is halfway when m · 2^e · 10^decimals · 2
 * is an odd integer, which BigInt decides without rounding.
 */
function isTie(value: number, decimals: number): boolean {
  bits.setFloat64(0, value);
  const high = bits.getUint32(0);
  const biased = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(bits.getUint32(4));
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const exponent = biased === 0 ? -1074 : biased - 1075;
  const numerator = mantissa * 2n * 10n ** BigInt(Math.max(decimals, 0)) * 2n ** BigInt(Math.max(exponent, 0));
  const denominator = 10n ** BigInt(Math.max(-decimals, 0)) * 2n ** BigInt(Math.max(-exponent, 0));
  return numerator % denominator === 0n && (numerator / denominator) % 2n === 1n;
}

/**
 * Rounds as .NET does: JavaScript rounds an exact tie up, .NET to the even digit. When the value was a tie and the
 * digit rounded up is odd, the even one is the digit below.
 */
function evenOnTie(text: string, value: number, decimals: number): string {
  const last = text.at(-1);
  if (last === undefined || !/[13579]/.test(last) || !isTie(value, decimals)) {
    return text;
  }
  return text.slice(0, -1) + String(Number(last) - 1);
}

/** Decimal digits of a positive value at a number of significant digits: digits and the exponent of the first one. */
function significant(value: number, digits: number): { digits: string; exponent: number } {
  const [mantissa = '0', exponentText = '0'] = value.toExponential(digits - 1).split('e');
  const exponent = Number(exponentText);
  return { digits: evenOnTie(mantissa.replace('.', ''), value, digits - 1 - exponent), exponent };
}

/** Rounds a string of decimal digits to fewer, half away from zero as .NET does; a carry raises the exponent. */
function roundDigits(digits: string, keep: number, exponent: number): { digits: string; exponent: number } {
  if (digits.length <= keep) {
    return { digits: digits.padEnd(keep, '0'), exponent };
  }
  const kept = Array.from(digits.slice(0, keep), Number);
  if (Number(digits[keep]) >= 5) {
    let i = keep - 1;
    for (; i >= 0; i--) {
      if ((kept[i] as number) < 9) {
        kept[i] = (kept[i] as number) + 1;
        break;
      }
      kept[i] = 0;
    }
    if (i < 0) {
      return { digits: `1${kept.slice(0, keep - 1).join('')}`, exponent: exponent + 1 };
    }
  }
  return { digits: kept.join(''), exponent };
}

/** The standard format F<decimals>: fixed decimals, no group separators. */
export function formatFixed(value: number, decimals: number, culture: Culture): string {
  if (!Number.isFinite(value)) {
    return nonFinite(value);
  }
  const magnitude = Math.abs(value);
  // From 1e21 on toFixed switches to exponents; such values are whole numbers, which BigInt writes digit for digit.
  const text =
    magnitude >= 1e21
      ? `${BigInt(magnitude).toString()}${decimals > 0 ? `.${'0'.repeat(decimals)}` : ''}`
      : evenOnTie(magnitude.toFixed(decimals), magnitude, decimals);
  const negative = value < 0 || Object.is(value, -0);
  return (negative ? culture.negativeSign : '') + localize(text, culture);
}

/**
 * The standard format G<precision>: the shortest of fixed and scientific notation at that many significant digits,
 * fixed while the exponent is above -5 and below the precision, else scientific, with a two-digit exponent ("1E+04").
 */
export function formatGeneral(value: number, precision: number, culture: Culture): string {
  if (!Number.isFinite(value)) {
    return nonFinite(value);
  }
  const sign = value < 0 || Object.is(value, -0) ? culture.negativeSign : '';
  if (value === 0) {
    return `${sign}0`;
  }
  const { digits, exponent } = significant(Math.abs(value), precision);
  const trimmed = digits.replace(/0+$/, '');
  if (exponent > -5 && exponent < precision) {
    let text: string;
    if (exponent < 0) {
      text = `0.${'0'.repeat(-exponent - 1)}${trimmed}`;
    } else if (trimmed.length <= exponent + 1) {
      text = trimmed.padEnd(exponent + 1, '0');
    } else {
      text = `${trimmed.slice(0, exponent + 1)}.${trimmed.slice(exponent + 1)}`;
    }
    return sign + localize(text, culture);
  }
  const mantissa = trimmed.length > 1 ? `${trimmed[0] ?? ''}.${trimmed.slice(1)}` : trimmed;
  const power = `E${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  return sign + localize(mantissa, culture) + power;
}

/**
 * A custom scientific format such as "0.###E+0" (optional fraction digits) or "0.000E+0" (fixed ones). As in .NET, the
 * value is first rounded to 15 significant digits, then to the digits of the format, half away from zero.
 */
export function formatScientific(value: number, fractionDigits: number, optional: boolean, culture: Culture): string {
  if (!Number.isFinite(value)) {
    return nonFinite(value);
  }
  const sign = value < 0 ? culture.negativeSign : '';
  if (value === 0) {
    return `0${optional || fractionDigits === 0 ? '' : `${culture.decimalSeparator}${'0'.repeat(fractionDigits)}`}E+0`;
  }
  const fifteen = significant(Math.abs(value), 15);
  const { digits, exponent } = roundDigits(fifteen.digits, 1 + fractionDigits, fifteen.exponent);
  let fraction = digits.slice(1);
  if (optional) {
    fraction = fraction.replace(/0+$/, '');
  }
  const mantissa = fraction.length > 0 ? `${digits[0] ?? ''}${culture.decimalSeparator}${fraction}` : (digits[0] ?? '');
  return `${sign}${mantissa}E${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent))}`;
}

function nonFinite(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  return value > 0 ? '∞' : '-∞';
}
