// Converting a CSV file of numbers into a column file, as ColumnFileConverter.FromCsv of the .NET version: the file
// streams in, is cut into pieces of 8 MB at line ends, the pieces are parsed in workers, and their rows are written in
// order. The header names the columns; X comes from a column only when it steps evenly, else the rows are numbered.
import { ColumnFileWriter, type ByteSink } from './column-file-writer';
import { parseCsvPiece, splitCsvLine, type CsvLayout, type CsvPiece } from './csv-parse';

/** The delimiter, header and decimal separator of a CSV file. */
export interface CsvFormat {
  /** The delimiter; `,` by default. */
  readonly delimiter?: string;
  /** Whether the first line names the columns; yes by default. */
  readonly hasHeader?: boolean;
  /** Whether a comma separates the decimals; no by default. */
  readonly decimalComma?: boolean;
}

/** What to take from a CSV file. */
export interface CsvColumns {
  /** The format. */
  readonly format?: CsvFormat;
  /** The column of X, which must step evenly; none to number the rows. */
  readonly xColumn?: number;
  /** The columns to keep, by number from 0; all but the X column by default. */
  readonly columns?: readonly number[];
  /** The X of the first row when the rows are numbered; 0 by default. */
  readonly xStart?: number;
  /** The X step when the rows are numbered; 1 by default. */
  readonly xStep?: number;
}

/** Options of {@link csvToColumnFile}. */
export interface CsvConversionOptions extends CsvColumns {
  /** The bytes of a piece; 8 MB by default, as in .NET. */
  readonly pieceBytes?: number;
  /** Parse workers; by default one per core but one, at most 8. 0 parses on this thread. */
  readonly workers?: number;
  /** Starts a parse worker; by default one of this package (`@tachyon-charts/large-data/csv-worker`). */
  readonly createWorker?: () => Worker;
  /** The size of the input in bytes, for the progress of a stream; a Blob tells it itself. */
  readonly size?: number;
  /** Receives the share of the input read, from 0 to 1. */
  readonly onProgress?: (share: number) => void;
  /** Stops the conversion; the column file is then incomplete. */
  readonly signal?: AbortSignal;
}

/** What a conversion wrote. */
export interface CsvSummary {
  /** The number of rows. */
  readonly rows: number;
  /** The names of the columns kept, from the header or numbered. */
  readonly names: readonly string[];
  /** The X of the first row. */
  readonly xStart: number;
  /** The X step. */
  readonly xStep: number;
}

/** Bytes of a piece, as in .NET. */
const pieceBytes = 8 << 20;
// X must follow the step of the first two rows within this share of the step.
const stepTolerance = 1e-6;
const decoder = new TextDecoder();

// Reads the input in chunks, whatever their size.
async function* chunksOf(input: Blob | ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = (input instanceof Blob ? input.stream() : input).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// Collects bytes into pieces that end at a line end.
class Pieces {
  private buffer: Uint8Array;
  private length = 0;

  constructor(private readonly size: number) {
    this.buffer = new Uint8Array(size + (1 << 16));
  }

  /** Collects bytes. */
  add(chunk: Uint8Array): void {
    if (this.length + chunk.length > this.buffer.length) {
      let capacity = this.buffer.length * 2;
      while (capacity < this.length + chunk.length) {
        capacity *= 2;
      }
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
  }

  /** The full pieces collected, each ending at the last line end within its size (or the first after it). */
  take(): Uint8Array[] {
    const full: Uint8Array[] = [];
    while (this.length >= this.size) {
      let end = this.buffer.lastIndexOf(10, this.size - 1);
      if (end < 0) {
        // A line longer than a piece: the piece takes all of it.
        end = this.buffer.indexOf(10, this.size);
        if (end < 0 || end >= this.length) {
          break;
        }
      }
      full.push(this.buffer.slice(0, end + 1));
      this.buffer.copyWithin(0, end + 1, this.length);
      this.length -= end + 1;
    }
    return full;
  }

  rest(): Uint8Array | undefined {
    return this.length > 0 ? this.buffer.slice(0, this.length) : undefined;
  }

  /** The bytes collected so far, for the header. */
  peek(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }

  /** Drops bytes from the front. */
  drop(count: number): void {
    this.buffer.copyWithin(0, count, this.length);
    this.length -= count;
  }
}

// Parses pieces in workers, or on this thread, and hands the rows back in the order the pieces came.
class Parsers {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly waiting: { bytes: Uint8Array; done: (piece: CsvPiece) => void; fail: (error: Error) => void }[] = [];

  constructor(
    count: number,
    private readonly layout: CsvLayout,
    create: () => Worker,
  ) {
    for (let i = 0; i < count; i++) {
      const worker = create();
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  parse(bytes: Uint8Array): Promise<CsvPiece> {
    if (this.workers.length === 0) {
      return Promise.resolve(parseCsvPiece(bytes, this.layout));
    }
    return new Promise((done, fail) => {
      this.waiting.push({ bytes, done, fail });
      this.next();
    });
  }

  close(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
  }

  private next(): void {
    const worker = this.idle.pop();
    const job = worker && this.waiting.shift();
    if (!worker || !job) {
      if (worker) {
        this.idle.push(worker);
      }
      return;
    }
    const answer = (event: MessageEvent<CsvPiece | { error: string }>): void => {
      worker.removeEventListener('message', answer);
      this.idle.push(worker);
      if ('error' in event.data) {
        job.fail(new Error(event.data.error));
      } else {
        job.done(event.data);
      }
      this.next();
    };
    worker.addEventListener('message', answer);
    worker.postMessage({ bytes: job.bytes, layout: this.layout }, [job.bytes.buffer]);
  }
}

/** Where a header and the first row end, and what they say. */
interface Start {
  readonly header: string[] | undefined;
  readonly columns: number;
  readonly consumedLines: number;
  readonly consumedBytes: number;
}

// The header, if any, and the fields of the first row, from the bytes collected so far; undefined while no complete
// first row is there and the input goes on.
function readStart(bytes: Uint8Array, format: Required<CsvFormat>, atEnd: boolean): Start | undefined {
  let offset = 0;
  let lines = 0;
  let header: string[] | undefined;
  for (;;) {
    let end = bytes.indexOf(10, offset);
    if (end < 0) {
      if (!atEnd) {
        return undefined;
      }
      end = bytes.length;
    }
    const line = decoder.decode(bytes.subarray(offset, end)).replace(/\r$/, '');
    const isLast = end === bytes.length;
    if (line.trim() === '') {
      if (isLast) {
        return { header, columns: header?.length ?? 1, consumedLines: lines, consumedBytes: bytes.length };
      }
      offset = end + 1;
      lines++;
      continue;
    }
    if (!header && format.hasHeader) {
      header = splitCsvLine(line, format.delimiter);
      offset = Math.min(end + 1, bytes.length);
      lines++;
      if (isLast) {
        return { header, columns: header.length, consumedLines: lines, consumedBytes: bytes.length };
      }
      continue;
    }
    // The first row stays; it is parsed with the others.
    return {
      header,
      columns: Math.max(header?.length ?? 0, splitCsvLine(line, format.delimiter).length),
      consumedLines: lines,
      consumedBytes: offset,
    };
  }
}

/**
 * Converts a CSV file of numbers, in UTF-8 or ASCII, one row per line, into a column file of float64 values: from a
 * File or Blob, or a stream such as the body of a fetch. The rows go into the sink as they are parsed; at the end the
 * column file is complete with its header.
 * @throws Error when a column does not exist, X does not step evenly, or the conversion was stopped.
 */
export async function csvToColumnFile(
  input: Blob | ReadableStream<Uint8Array>,
  sink: ByteSink,
  options: CsvConversionOptions = {},
): Promise<CsvSummary> {
  const format: Required<CsvFormat> = {
    delimiter: options.format?.delimiter ?? ',',
    hasHeader: options.format?.hasHeader ?? true,
    decimalComma: options.format?.decimalComma ?? false,
  };
  const size = input instanceof Blob ? input.size : options.size;
  const pieces = new Pieces(options.pieceBytes ?? pieceBytes);
  const chunks = chunksOf(input);
  let read = 0;
  let checkedMark = false;
  let start: Start | undefined;
  // The header and the first row tell the columns.
  for (;;) {
    const next = await chunks.next();
    if (!next.done) {
      read += next.value.length;
      pieces.add(next.value);
      if (!checkedMark && pieces.peek().length >= 3) {
        checkedMark = true;
        const head = pieces.peek();
        if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
          pieces.drop(3);
        }
      }
    }
    start = readStart(pieces.peek(), format, next.done === true);
    if (start || next.done) {
      break;
    }
  }
  if (!start) {
    throw new Error('The CSV file is empty.');
  }
  pieces.drop(start.consumedBytes);
  const xColumn = options.xColumn;
  const kept = [
    ...(options.columns ?? Array.from({ length: start.columns }, (_, c) => c).filter((c) => c !== xColumn)),
  ];
  if (kept.length === 0) {
    throw new Error('The CSV file has no column to keep beside X.');
  }
  const missing = [...kept, ...(xColumn === undefined ? [] : [xColumn])].find((c) => c < 0 || c >= start.columns);
  if (missing !== undefined) {
    throw new Error(`The CSV file has ${String(start.columns)} columns; there is no column ${String(missing)}.`);
  }
  const slots = new Array<number>(start.columns).fill(-1);
  kept.forEach((column, place) => {
    slots[column] = place;
  });
  if (xColumn !== undefined) {
    slots[xColumn] = -2;
  }
  const layout: CsvLayout = {
    delimiter: format.delimiter.charCodeAt(0),
    slots,
    kept: kept.length,
    hasX: xColumn !== undefined,
    decimalComma: format.decimalComma,
  };
  const workerCount =
    options.workers ??
    Math.max(1, Math.min(8, ((globalThis as { navigator?: Navigator }).navigator?.hardwareConcurrency ?? 2) - 1));
  const create =
    options.createWorker ??
    ((): Worker => new Worker(new URL('./csv-worker-entry.js', import.meta.url), { type: 'module' }));
  const parsers = new Parsers(workerCount, layout, create);
  const writer = new ColumnFileWriter(sink, {
    type: 'float64',
    columns: kept.length,
    xStart: options.xStart ?? 0,
    xStep: options.xStep ?? 1,
  });
  let rows = 0;
  let lineBase = start.consumedLines;
  let first = 0;
  let second = 0;
  let last = 0;
  // X of each row must follow the step of the first two.
  const check = (piece: CsvPiece): void => {
    for (let i = 0; i < piece.rows; i++) {
      const x = piece.xs[i] as number;
      const count = rows + i;
      if (count === 0) {
        first = x;
      } else if (count === 1) {
        second = x;
      } else if (Math.abs(x - last - (second - first)) > Math.abs(second - first) * stepTolerance) {
        throw new Error(
          `Line ${String(lineBase + (piece.lineOfRow[i] ?? 0) + 1)}: X ${String(x)} does not follow the step ` +
            `${String(second - first)}; column files need X in even steps.`,
        );
      }
      last = x;
    }
  };
  // Pieces parse in parallel; they are written in the order they came.
  const inFlight: Promise<CsvPiece>[] = [];
  const writeOldest = async (): Promise<void> => {
    const piece = await (inFlight.shift() as Promise<CsvPiece>);
    if (layout.hasX) {
      check(piece);
    }
    await writer.append(piece.values.subarray(0, piece.rows * layout.kept));
    rows += piece.rows;
    lineBase += piece.lines;
  };
  try {
    const send = async (bytes: Uint8Array): Promise<void> => {
      options.signal?.throwIfAborted();
      inFlight.push(parsers.parse(bytes));
      if (inFlight.length > Math.max(2, workerCount * 2)) {
        await writeOldest();
      }
    };
    // Whole pieces from the bytes read with the header.
    for (const full of pieces.take()) {
      await send(full);
    }
    for (let next = await chunks.next(); !next.done; next = await chunks.next()) {
      read += next.value.length;
      pieces.add(next.value);
      for (const full of pieces.take()) {
        await send(full);
      }
      if (size) {
        options.onProgress?.(Math.min(1, read / size));
      }
    }
    const rest = pieces.rest();
    if (rest) {
      await send(rest);
    }
    while (inFlight.length > 0) {
      await writeOldest();
    }
  } finally {
    parsers.close();
  }
  const [xStart, xStep] =
    layout.hasX && rows >= 2 ? [first, (last - first) / (rows - 1)] : [options.xStart ?? 0, options.xStep ?? 1];
  writer.setX(xStart, xStep);
  await writer.close();
  options.onProgress?.(1);
  const names = kept.map((column) => {
    const name = start.header?.[column]?.trim() ?? '';
    return name === '' ? `Column ${String(column + 1)}` : name;
  });
  return { rows, names, xStart, xStep };
}
