// Parsing a piece of a CSV file of numbers straight from its UTF-8 bytes, as ColumnFileConverter of the .NET version:
// one row per line, fields at the delimiter, a line with quotes the careful way, values that are no numbers become
// gaps (NaN). Numbers of up to 15 digits and small exponents are read from the bytes and rounded exactly as the .NET
// version rounds them; all others go through Number(), which rounds correctly too.

/** How the fields of a row turn into values. */
export interface CsvLayout {
  /** The delimiter as a byte. */
  readonly delimiter: number;
  /** Per field: the place among the kept columns, -2 for X, -1 for nothing. */
  readonly slots: readonly number[];
  /** The number of kept columns. */
  readonly kept: number;
  /** Whether a column is X. */
  readonly hasX: boolean;
  /** Whether a comma separates the decimals (and a point groups thousands). */
  readonly decimalComma: boolean;
}

/** The rows of a piece. */
export interface CsvPiece {
  /** The values, row after row, the kept columns of a row next to each other. */
  readonly values: Float64Array;
  /** X of each row; NaN without an X column. */
  readonly xs: Float64Array;
  /** The line of each row within the piece, from 0. */
  readonly lineOfRow: Int32Array;
  /** The number of rows. */
  readonly rows: number;
  /** The number of lines, blank ones included. */
  readonly lines: number;
}

const newline = 10;
const carriage = 13;
const space = 32;
const tab = 9;
const quote = 34;
const plus = 43;
const minus = 45;
const point = 46;
const comma = 44;
const zero = 48;
const nine = 57;
const powers = Array.from({ length: 23 }, (_, i) => 10 ** i);
const strict = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const decoder = new TextDecoder();

/** Reads a number as the .NET version does (Float with thousands); NaN for anything else. */
export function parseNumberText(text: string, decimalComma: boolean): number {
  let trimmed = text.trim();
  if (trimmed === '') {
    return Number.NaN;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'nan') {
    return Number.NaN;
  }
  if (lower === 'infinity' || lower === '+infinity') {
    return Number.POSITIVE_INFINITY;
  }
  if (lower === '-infinity') {
    return Number.NEGATIVE_INFINITY;
  }
  // Group separators may stand in the whole part only, before the decimal separator and the exponent.
  const decimal = decimalComma ? ',' : '.';
  const group = decimalComma ? '.' : ',';
  const end = trimmed.search(new RegExp(`[${decimal === '.' ? '\\.' : ','}eE]`));
  const whole = end < 0 ? trimmed : trimmed.slice(0, end);
  const rest = end < 0 ? '' : trimmed.slice(end);
  if (rest.includes(group) || whole.startsWith(group)) {
    return Number.NaN;
  }
  trimmed = whole.split(group).join('') + (decimalComma ? rest.replace(',', '.') : rest);
  return strict.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** Reads the number in `bytes` from `start` to before `end`. */
export function parseNumberBytes(bytes: Uint8Array, start: number, end: number, decimalComma: boolean): number {
  let s = start;
  let e = end;
  while (s < e && (bytes[s] === space || bytes[s] === tab)) {
    s++;
  }
  while (e > s && (bytes[e - 1] === space || bytes[e - 1] === tab)) {
    e--;
  }
  if (s === e) {
    return Number.NaN;
  }
  const decimal = decimalComma ? comma : point;
  const group = decimalComma ? point : comma;
  let i = s;
  let negative = false;
  if (bytes[i] === minus) {
    negative = true;
    i++;
  } else if (bytes[i] === plus) {
    i++;
  }
  let mantissa = 0;
  let digits = 0;
  let exponent = 0;
  let any = false;
  for (; i < e; i++) {
    const byte = bytes[i] as number;
    if (byte >= zero && byte <= nine) {
      mantissa = mantissa * 10 + (byte - zero);
      if (mantissa !== 0) {
        digits++;
      }
      any = true;
    } else if (byte !== group || !any) {
      break;
    }
  }
  if (i < e && bytes[i] === decimal) {
    for (i++; i < e; i++) {
      const byte = bytes[i] as number;
      if (byte < zero || byte > nine) {
        break;
      }
      mantissa = mantissa * 10 + (byte - zero);
      if (mantissa !== 0) {
        digits++;
      }
      exponent--;
      any = true;
    }
  }
  if (any && i < e && (bytes[i] === 101 || bytes[i] === 69)) {
    i++;
    let sign = 1;
    if (bytes[i] === minus) {
      sign = -1;
      i++;
    } else if (bytes[i] === plus) {
      i++;
    }
    let value = 0;
    let exponentDigits = 0;
    for (; i < e && (bytes[i] as number) >= zero && (bytes[i] as number) <= nine; i++) {
      value = value * 10 + ((bytes[i] as number) - zero);
      exponentDigits++;
      if (value > 100_000) {
        break;
      }
    }
    if (exponentDigits === 0) {
      return Number.NaN;
    }
    exponent += sign * value;
  }
  // Exact: a whole number below 2^53 times or divided by an exact power of ten rounds once, correctly.
  if (any && i === e && digits <= 15 && exponent >= -22 && exponent <= 22) {
    const value = exponent < 0 ? mantissa / (powers[-exponent] as number) : mantissa * (powers[exponent] as number);
    return negative ? -value : value;
  }
  // Valid but beyond the exact path (more digits or a large exponent): Number() rounds correctly, as .NET does.
  if (any && i === e) {
    return exactText(bytes, s, e, group, decimal);
  }
  return parseNumberText(decoder.decode(bytes.subarray(start, end)), decimalComma);
}

// The number as ASCII text without group separators and with a decimal point, for Number().
function exactText(bytes: Uint8Array, start: number, end: number, group: number, decimal: number): number {
  let text = '';
  for (let i = start; i < end; i++) {
    const byte = bytes[i] as number;
    if (byte !== group) {
      text += byte === decimal ? '.' : String.fromCharCode(byte);
    }
  }
  return Number(text);
}

/** Splits a line at the delimiter; a value in quotes keeps delimiters, and two quotes in it stand for one. */
export function splitCsvLine(line: string, delimiter: string): string[] {
  if (!line.includes('"')) {
    return line.split(delimiter);
  }
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quoted && c === '"' && line[i + 1] === '"') {
      field += '"';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (c === delimiter && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

/** Parses a piece that ends at a line end (or at the end of the file). */
export function parseCsvPiece(bytes: Uint8Array, layout: CsvLayout): CsvPiece {
  let estimate = 1;
  for (let at = bytes.indexOf(newline); at >= 0; at = bytes.indexOf(newline, at + 1)) {
    estimate++;
  }
  const values = new Float64Array(estimate * layout.kept);
  const xs = new Float64Array(estimate);
  const lineOfRow = new Int32Array(estimate);
  const delimiterText = String.fromCharCode(layout.delimiter);
  // Quotes are rare in numbers: only a piece with one looks for them line by line.
  const anyQuote = bytes.includes(quote);
  let rows = 0;
  let lines = 0;
  let start = 0;
  while (start < bytes.length) {
    let end = bytes.indexOf(newline, start);
    const next = end < 0 ? bytes.length : end + 1;
    if (end < 0) {
      end = bytes.length;
    }
    lines++;
    let stop = end;
    if (stop > start && bytes[stop - 1] === carriage) {
      stop--;
    }
    let first = start;
    while (first < stop && (bytes[first] === space || bytes[first] === tab)) {
      first++;
    }
    if (first < stop) {
      values.fill(Number.NaN, rows * layout.kept, (rows + 1) * layout.kept);
      xs[rows] = Number.NaN;
      let quoted = false;
      for (let i = start; anyQuote && i < stop && !quoted; i++) {
        quoted = bytes[i] === quote;
      }
      if (quoted) {
        const fields = splitCsvLine(decoder.decode(bytes.subarray(start, stop)), delimiterText);
        for (let field = 0; field < fields.length && field < layout.slots.length; field++) {
          store(layout, field, parseNumberText(fields[field] as string, layout.decimalComma), values, xs, rows);
        }
      } else {
        let fieldStart = start;
        for (let field = 0; field < layout.slots.length; field++) {
          let fieldEnd = fieldStart;
          while (fieldEnd < stop && bytes[fieldEnd] !== layout.delimiter) {
            fieldEnd++;
          }
          if (layout.slots[field] !== -1) {
            store(layout, field, parseNumberBytes(bytes, fieldStart, fieldEnd, layout.decimalComma), values, xs, rows);
          }
          if (fieldEnd === stop) {
            break;
          }
          fieldStart = fieldEnd + 1;
        }
      }
      lineOfRow[rows] = lines - 1;
      rows++;
    }
    start = next;
  }
  return { values, xs, lineOfRow, rows, lines };
}

function store(
  layout: CsvLayout,
  field: number,
  value: number,
  values: Float64Array,
  xs: Float64Array,
  row: number,
): void {
  const slot = layout.slots[field] as number;
  if (slot >= 0) {
    values[row * layout.kept + slot] = value;
  } else if (slot === -2) {
    xs[row] = value;
  }
}
