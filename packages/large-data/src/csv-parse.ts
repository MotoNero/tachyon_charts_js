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
const strict = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
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
  const end = trimmed.search(new RegExp(decimal === '.' ? '[.eE]' : '[,eE]'));
  const whole = end < 0 ? trimmed : trimmed.slice(0, end);
  const rest = end < 0 ? '' : trimmed.slice(end);
  if (rest.includes(group) || whole.startsWith(group)) {
    return Number.NaN;
  }
  trimmed = whole.split(group).join('') + (decimalComma ? rest.replace(',', '.') : rest);
  return strict.test(trimmed) ? Number(trimmed) : Number.NaN;
}

// The state of the number being read, kept in one object so that reading a number allocates nothing.
const scan = { at: 0, mantissa: 0, digits: 0, exponent: 0, any: false };

// The digits of the whole part (group separators may follow digits) or, with `fraction`, after the decimal separator.
function readDigits(bytes: Uint8Array, end: number, group: number, fraction: boolean): void {
  let { at, mantissa, digits, exponent, any } = scan;
  for (; at < end; at++) {
    const byte = bytes[at] as number;
    if (byte >= zero && byte <= nine) {
      mantissa = mantissa * 10 + (byte - zero);
      digits += mantissa === 0 ? 0 : 1;
      exponent -= fraction ? 1 : 0;
      any = true;
    } else if (fraction || byte !== group || !any) {
      break;
    }
  }
  scan.at = at;
  scan.mantissa = mantissa;
  scan.digits = digits;
  scan.exponent = exponent;
  scan.any = any;
}

// The exponent after e or E; false when it has no digits.
function readExponent(bytes: Uint8Array, end: number): boolean {
  let sign = 1;
  if (bytes[scan.at] === minus) {
    sign = -1;
    scan.at++;
  } else if (bytes[scan.at] === plus) {
    scan.at++;
  }
  let value = 0;
  const first = scan.at;
  for (; scan.at < end && value <= 100_000; scan.at++) {
    const byte = bytes[scan.at] as number;
    if (byte < zero || byte > nine) {
      break;
    }
    value = value * 10 + (byte - zero);
  }
  scan.exponent += sign * value;
  return scan.at > first;
}

function startScan(at: number): void {
  scan.at = at;
  scan.mantissa = 0;
  scan.digits = 0;
  scan.exponent = 0;
  scan.any = false;
}

// Reads the digits, the fraction and the exponent into the scan; false when an exponent has no digits.
function readNumber(bytes: Uint8Array, at: number, end: number, group: number, decimal: number): boolean {
  startScan(at);
  readDigits(bytes, end, group, false);
  if (scan.at < end && bytes[scan.at] === decimal) {
    scan.at++;
    readDigits(bytes, end, group, true);
  }
  if (scan.any && scan.at < end && (bytes[scan.at] === 101 || bytes[scan.at] === 69)) {
    scan.at++;
    return readExponent(bytes, end);
  }
  return true;
}

function isBlank(byte: number | undefined): boolean {
  return byte === space || byte === tab;
}

/** Reads the number in `bytes` from `start` to before `end`. */
export function parseNumberBytes(bytes: Uint8Array, start: number, end: number, decimalComma: boolean): number {
  let s = start;
  let e = end;
  while (s < e && isBlank(bytes[s])) {
    s++;
  }
  while (e > s && isBlank(bytes[e - 1])) {
    e--;
  }
  if (s === e) {
    return Number.NaN;
  }
  const decimal = decimalComma ? comma : point;
  const group = decimalComma ? point : comma;
  const negative = bytes[s] === minus;
  if (!readNumber(bytes, negative || bytes[s] === plus ? s + 1 : s, e, group, decimal)) {
    return Number.NaN;
  }
  if (!scan.any || scan.at !== e) {
    return parseNumberText(decoder.decode(bytes.subarray(start, end)), decimalComma);
  }
  // Valid but beyond the exact path (more digits or a large exponent): Number() rounds correctly, as .NET does.
  return exactValue(negative) ?? exactText(bytes, s, e, group, decimal);
}

// The number of the scan when it is exact: a whole number below 2^53 times or divided by an exact power of ten
// rounds once, correctly. Undefined beyond that.
function exactValue(negative: boolean): number | undefined {
  const exponent = scan.exponent;
  if (scan.digits > 15 || exponent < -22 || exponent > 22) {
    return undefined;
  }
  const value =
    exponent < 0 ? scan.mantissa / (powers[-exponent] as number) : scan.mantissa * (powers[exponent] as number);
  return negative ? -value : value;
}

// The number as ASCII text without group separators and with a decimal point, for Number().
function exactText(bytes: Uint8Array, start: number, end: number, group: number, decimal: number): number {
  let text = '';
  for (let i = start; i < end; i++) {
    const byte = bytes[i] as number;
    if (byte !== group) {
      text += byte === decimal ? '.' : String.fromCodePoint(byte);
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

// The rows of a piece while it is parsed.
interface PieceRows {
  readonly layout: CsvLayout;
  readonly values: Float64Array;
  readonly xs: Float64Array;
  readonly delimiterText: string;
}

function hasQuote(bytes: Uint8Array, start: number, stop: number): boolean {
  for (let i = start; i < stop; i++) {
    if (bytes[i] === quote) {
      return true;
    }
  }
  return false;
}

// A line with quotes, split as text.
function parseQuotedLine(bytes: Uint8Array, start: number, stop: number, rows: PieceRows, row: number): void {
  const { layout, values, xs } = rows;
  const fields = splitCsvLine(decoder.decode(bytes.subarray(start, stop)), rows.delimiterText);
  for (let field = 0; field < fields.length && field < layout.slots.length; field++) {
    store(layout, field, parseNumberText(fields[field] as string, layout.decimalComma), values, xs, row);
  }
}

// A line without quotes, read from the bytes.
function parseLine(bytes: Uint8Array, start: number, stop: number, rows: PieceRows, row: number): void {
  const { layout, values, xs } = rows;
  let fieldStart = start;
  for (let field = 0; field < layout.slots.length; field++) {
    let fieldEnd = fieldStart;
    while (fieldEnd < stop && bytes[fieldEnd] !== layout.delimiter) {
      fieldEnd++;
    }
    if (layout.slots[field] !== -1) {
      store(layout, field, parseNumberBytes(bytes, fieldStart, fieldEnd, layout.decimalComma), values, xs, row);
    }
    if (fieldEnd === stop) {
      return;
    }
    fieldStart = fieldEnd + 1;
  }
}

function isBlankLine(bytes: Uint8Array, start: number, stop: number): boolean {
  for (let i = start; i < stop; i++) {
    if (!isBlank(bytes[i])) {
      return false;
    }
  }
  return true;
}

function countLines(bytes: Uint8Array): number {
  let count = 1;
  for (let at = bytes.indexOf(newline); at >= 0; at = bytes.indexOf(newline, at + 1)) {
    count++;
  }
  return count;
}

/** Parses a piece that ends at a line end (or at the end of the file). */
export function parseCsvPiece(bytes: Uint8Array, layout: CsvLayout): CsvPiece {
  const estimate = countLines(bytes);
  const parsed: PieceRows = {
    layout,
    values: new Float64Array(estimate * layout.kept),
    xs: new Float64Array(estimate),
    delimiterText: String.fromCodePoint(layout.delimiter),
  };
  const lineOfRow = new Int32Array(estimate);
  // Quotes are rare in numbers: only a piece with one looks for them line by line.
  const anyQuote = bytes.includes(quote);
  let rows = 0;
  let lines = 0;
  let start = 0;
  while (start < bytes.length) {
    const found = bytes.indexOf(newline, start);
    const end = found < 0 ? bytes.length : found;
    lines++;
    const stop = end > start && bytes[end - 1] === carriage ? end - 1 : end;
    if (!isBlankLine(bytes, start, stop)) {
      parsed.values.fill(Number.NaN, rows * layout.kept, (rows + 1) * layout.kept);
      parsed.xs[rows] = Number.NaN;
      if (anyQuote && hasQuote(bytes, start, stop)) {
        parseQuotedLine(bytes, start, stop, parsed, rows);
      } else {
        parseLine(bytes, start, stop, parsed, rows);
      }
      lineOfRow[rows] = lines - 1;
      rows++;
    }
    start = end + 1;
  }
  return { values: parsed.values, xs: parsed.xs, lineOfRow, rows, lines };
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
