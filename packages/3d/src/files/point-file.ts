// Clouds of points from XYZ, PLY and LAS files, read with code of its own, as PointFile, XyzReader, PlyReader and
// LasReader of the .NET version. All readers know the number of points before they fill the arrays, so a file of 100
// million points is never held twice; files are read in slices, so they may be larger than one buffer. LAZ is not
// supported.
import type { PointCloudArrays } from '../scene/point-cloud';

const sliceBytes = 1 << 23;
const longestPlyHeader = 1 << 20;
const largestCount = 2 ** 31 - 1;

/** A file that cannot be read as points, with the reason in the message. */
export class PointFileError extends Error {
  /** The name of the error. */
  override readonly name = 'PointFileError';
}

/** Tells how far the reading has come, from 0 to 1. */
export type ReadProgress = (share: number) => void;

function allocate(count: number, hasColors: boolean): PointCloudArrays {
  if (count <= 0) {
    throw new PointFileError('The file holds no points.');
  }
  if (count > largestCount) {
    throw new PointFileError(`The file holds ${String(count)} points, more than one list can take.`);
  }
  try {
    return {
      x: new Float64Array(count),
      y: new Float64Array(count),
      z: new Float64Array(count),
      ...(hasColors ? { colors: new Uint8Array(count * 4) } : {}),
    };
  } catch (error) {
    throw new PointFileError(`There is not enough memory for ${String(count)} points.`, { cause: error });
  }
}

const numberPattern = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(Infinity|NaN)$/;

/** @internal The numbers of a line, separated by blanks, tabs, commas or semicolons, up to the first word that is none. */
export function takeNumbers(line: string, most = Infinity): number[] {
  const values: number[] = [];
  for (const word of line.split(/[ \t,;]+/)) {
    if (word.length === 0) {
      continue;
    }
    if (values.length >= most || !numberPattern.test(word)) {
      break;
    }
    values.push(Number(word));
  }
  return values;
}

function hasData(line: string): boolean {
  return line.length > 0 && !line.startsWith('#') && !line.startsWith('/');
}

// Calls back for each line from a byte on, trimmed, with its number from 1; returns early when told to.
async function forEachLine(
  file: Blob,
  start: number,
  read: (line: string, number: number) => boolean | undefined,
  report?: ReadProgress,
): Promise<void> {
  const decoder = new TextDecoder();
  let rest = '';
  let number = 1;
  for (let at = start; at < file.size; at += sliceBytes) {
    const end = Math.min(at + sliceBytes, file.size);
    const text = rest + decoder.decode(new Uint8Array(await file.slice(at, end).arrayBuffer()), { stream: true });
    const lines = text.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      if (read(line.trim(), number++) === false) {
        return;
      }
    }
    report?.((end - start) / Math.max(file.size - start, 1));
  }
  rest += decoder.decode();
  if (rest.length > 0) {
    read(rest.trim(), number);
  }
}

function toByte(value: number): number {
  return Math.trunc(Math.min(Math.max(value, 0), 255));
}

/** Reads text with x, y and z per line, optionally followed by red, green and blue from 0 to 255. */
async function readXyz(file: Blob, report?: ReadProgress): Promise<PointCloudArrays> {
  // Two passes: the first one only counts, so that the arrays fit exactly.
  let count = 0;
  let hasColors = false;
  await forEachLine(
    file,
    0,
    (line) => {
      if (hasData(line)) {
        hasColors ||= count === 0 && takeNumbers(line).length >= 6;
        count++;
      }
      return undefined;
    },
    report &&
      ((share) => {
        report(share / 2);
      }),
  );
  const data = allocate(count, hasColors);
  let at = 0;
  await forEachLine(
    file,
    0,
    (line, number) => {
      if (!hasData(line)) {
        return undefined;
      }
      const values = takeNumbers(line, 6);
      if (values.length < 3) {
        throw new PointFileError(`Line ${String(number)} needs three numbers: x, y and z.`);
      }
      data.x[at] = values[0] as number;
      data.y[at] = values[1] as number;
      data.z[at] = values[2] as number;
      if (data.colors) {
        if (values.length < 6) {
          throw new PointFileError(`Line ${String(number)} needs red, green and blue like the first line.`);
        }
        data.colors.set(
          [toByte(values[3] as number), toByte(values[4] as number), toByte(values[5] as number), 255],
          at * 4,
        );
      }
      at++;
      return undefined;
    },
    report &&
      ((share) => {
        report(0.5 + share / 2);
      }),
  );
  return data;
}

// The smallest record per format of LAS, and where the colors start. Formats without colors hold -1.
const lasSizes = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
const lasColors = [-1, -1, 20, 28, -1, 28, -1, 30, 30, -1, 30];
const lasHeader = 227;
const lasLongHeader = 375;

/** Reads a LAS file of the versions 1.0 to 1.4. The header gives the number and size of the records. */
async function readLas(file: Blob, report?: ReadProgress): Promise<PointCloudArrays> {
  const length = file.size;
  const header = new DataView(await file.slice(0, Math.min(lasLongHeader, length)).arrayBuffer());
  const sign = header.byteLength >= 4 ? String.fromCharCode(...new Uint8Array(header.buffer, 0, 4)) : '';
  if (header.byteLength < lasHeader || sign !== 'LASF') {
    throw new PointFileError("This is no LAS file: it does not start with 'LASF'.");
  }
  const format = header.getUint8(104);
  if ((format & 0xc0) !== 0) {
    throw new PointFileError('The points are compressed like in LAZ, which is not supported.');
  }
  if (format > 10) {
    throw new PointFileError(`The point format ${String(format)} is unknown.`);
  }
  const minor = header.getUint8(25);
  const headerSize = header.getUint16(94, true);
  const offset = header.getUint32(96, true);
  const record = header.getUint16(105, true);
  let count = header.getUint32(107, true);
  if (minor >= 4 && headerSize >= lasLongHeader && header.byteLength >= lasLongHeader) {
    const longCount = header.getBigUint64(247, true);
    if (longCount > BigInt(length)) {
      throw new PointFileError(`The file is cut off or damaged: the header claims ${String(longCount)} points.`);
    }
    count = Number(longCount);
  }
  const smallest = lasSizes[format] as number;
  if (record < smallest) {
    throw new PointFileError(
      `A record of format ${String(format)} needs ${String(smallest)} bytes, the header says ${String(record)}.`,
    );
  }
  if (offset < lasHeader || offset + count * record > length) {
    throw new PointFileError(
      `The file is cut off: ${String(count)} points from byte ${String(offset)} need ${String(offset + count * record)} bytes, but it has ${String(length)}.`,
    );
  }
  const vector = (at: number): [number, number, number] => [
    header.getFloat64(at, true),
    header.getFloat64(at + 8, true),
    header.getFloat64(at + 16, true),
  ];
  const scale = vector(131);
  const origin = vector(155);
  if (
    scale.some((value) => !Number.isFinite(value) || value === 0) ||
    !Number.isFinite(origin[0] + origin[1] + origin[2])
  ) {
    throw new PointFileError('The scale or offset in the header of the LAS file is invalid.');
  }
  const colorAt = lasColors[format] as number;
  const data = allocate(count, colorAt >= 0);
  const perRead = Math.max(1, Math.floor(sliceBytes / record));
  let shift = -1;
  for (let done = 0; done < count;) {
    const take = Math.min(perRead, count - done);
    const start = offset + done * record;
    const view = new DataView(await file.slice(start, start + take * record).arrayBuffer());
    // The format asks for 16 bits per color, yet many files store 8. The first points tell which it is.
    if (shift < 0 && colorAt >= 0) {
      shift = 0;
      for (let i = 0; i < Math.min(take, 4096); i++) {
        const at = i * record + colorAt;
        if (
          view.getUint16(at, true) > 255 ||
          view.getUint16(at + 2, true) > 255 ||
          view.getUint16(at + 4, true) > 255
        ) {
          shift = 8;
          break;
        }
      }
    }
    for (let i = 0; i < take; i++) {
      const at = i * record;
      data.x[done + i] = view.getInt32(at, true) * scale[0] + origin[0];
      data.y[done + i] = view.getInt32(at + 4, true) * scale[1] + origin[1];
      data.z[done + i] = view.getInt32(at + 8, true) * scale[2] + origin[2];
      if (data.colors) {
        const c = at + colorAt;
        const place = (done + i) * 4;
        data.colors[place] = (view.getUint16(c, true) >> shift) & 255;
        data.colors[place + 1] = (view.getUint16(c + 2, true) >> shift) & 255;
        data.colors[place + 2] = (view.getUint16(c + 4, true) >> shift) & 255;
        data.colors[place + 3] = 255;
      }
    }
    done += take;
    report?.(done / count);
  }
  return data;
}

type PlyType = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

const plyTypes: Readonly<Record<string, PlyType>> = {
  char: 'int8',
  int8: 'int8',
  uchar: 'uint8',
  uint8: 'uint8',
  short: 'int16',
  int16: 'int16',
  ushort: 'uint16',
  uint16: 'uint16',
  int: 'int32',
  int32: 'int32',
  uint: 'uint32',
  uint32: 'uint32',
  float: 'float32',
  float32: 'float32',
  double: 'float64',
  float64: 'float64',
};

const plySizes: Readonly<Record<PlyType, number>> = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  float32: 4,
  float64: 8,
};

interface PlyProperty {
  readonly name: string;
  readonly type: PlyType;
  readonly offset: number;
}

function readPlyValue(view: DataView, at: number, type: PlyType, little: boolean): number {
  switch (type) {
    case 'int8':
      return view.getInt8(at);
    case 'uint8':
      return view.getUint8(at);
    case 'int16':
      return view.getInt16(at, little);
    case 'uint16':
      return view.getUint16(at, little);
    case 'int32':
      return view.getInt32(at, little);
    case 'uint32':
      return view.getUint32(at, little);
    case 'float32':
      return view.getFloat32(at, little);
    default:
      return view.getFloat64(at, little);
  }
}

/** Reads the vertices of a PLY file, as text or binary in either byte order; faces and other parts stay unread. */
async function readPly(file: Blob, report?: ReadProgress): Promise<PointCloudArrays> {
  const head = new Uint8Array(await file.slice(0, Math.min(longestPlyHeader, file.size)).arrayBuffer());
  let position = 0;
  const readLine = (): string => {
    const end = head.indexOf(10, position);
    if (end < 0) {
      throw new PointFileError(
        position >= longestPlyHeader
          ? 'The header of the PLY file does not end.'
          : 'The header of the PLY file ends early.',
      );
    }
    const line = new TextDecoder().decode(head.subarray(position, end)).replace(/\r$/, '');
    position = end + 1;
    return line;
  };
  if (readLine() !== 'ply') {
    throw new PointFileError("This is no PLY file: the first line must be 'ply'.");
  }
  let format: 'ascii' | 'little' | 'big' | undefined;
  const properties: PlyProperty[] = [];
  let element: string | undefined;
  let elementCount = 0;
  let vertices = -1;
  let offset = 0;
  let fixedSize = true;
  let skipped = 0;
  let skippedBytes = 0;
  let vertexDone = false;
  let vertexRecord = 0;
  const closeElement = (): void => {
    if (element === 'vertex') {
      vertexRecord = offset;
      vertexDone = true;
    } else if (element !== undefined && !vertexDone) {
      if (!fixedSize) {
        throw new PointFileError(
          `The element '${element}' with lists comes before the vertices, which is not supported.`,
        );
      }
      skipped += elementCount;
      skippedBytes += elementCount * offset;
    }
    offset = 0;
    fixedSize = true;
  };
  for (;;) {
    const line = readLine();
    const words = line.split(' ').filter((word) => word.length > 0);
    if (line === 'end_header') {
      break;
    }
    const first = words[0];
    if (first === undefined || first === 'comment' || first === 'obj_info') {
      continue;
    }
    if (first === 'format' && words.length >= 2) {
      const name = words[1];
      if (name === 'ascii') {
        format = 'ascii';
      } else if (name === 'binary_little_endian') {
        format = 'little';
      } else if (name === 'binary_big_endian') {
        format = 'big';
      } else {
        throw new PointFileError(`The PLY format '${name ?? ''}' is unknown.`);
      }
    } else if (first === 'element' && words.length >= 3) {
      closeElement();
      const text = words[2] as string;
      if (!/^\d+$/.test(text)) {
        throw new PointFileError(`The element '${words[1] as string}' has no valid number: '${text}'.`);
      }
      elementCount = Number(text);
      if (elementCount > largestCount) {
        throw new PointFileError(
          `The file is cut off or damaged: the element '${words[1] as string}' claims ${text} entries.`,
        );
      }
      element = words[1];
      if (element === 'vertex') {
        vertices = elementCount;
      }
    } else if (first === 'property' && words.length >= 3) {
      if (words[1] === 'list') {
        if (element === 'vertex') {
          throw new PointFileError('Vertices with lists are not supported.');
        }
        fixedSize = false;
        continue;
      }
      const type = plyTypes[words[1] as string];
      if (!type) {
        throw new PointFileError(`The PLY type '${words[1] as string}' is unknown.`);
      }
      if (element === 'vertex') {
        properties.push({ name: words[2] as string, type, offset });
      }
      offset += plySizes[type];
    } else {
      throw new PointFileError(`The PLY header holds an unknown line: '${line}'.`);
    }
  }
  closeElement();
  if (!format) {
    throw new PointFileError('The header of the PLY file names no format.');
  }
  if (vertices < 0) {
    throw new PointFileError("The PLY file has no element 'vertex'.");
  }
  const find = (name: string): number | undefined => {
    const index = properties.findIndex((property) => property.name === name);
    return index >= 0 ? index : undefined;
  };
  const x = find('x');
  const y = find('y');
  const z = find('z');
  if (x === undefined || y === undefined || z === undefined) {
    throw new PointFileError('The vertices of the PLY file need the properties x, y and z.');
  }
  let red = find('red') ?? find('diffuse_red');
  let green = find('green') ?? find('diffuse_green');
  let blue = find('blue') ?? find('diffuse_blue');
  if (red === undefined || green === undefined || blue === undefined) {
    red = green = blue = undefined;
  }
  const redType = red === undefined ? undefined : (properties[red] as PlyProperty).type;
  const areShares = redType === 'float32' || redType === 'float64';
  const remaining = file.size - position;
  if (format !== 'ascii' && skippedBytes + vertices * vertexRecord > remaining) {
    throw new PointFileError(
      `The file is cut off: ${String(vertices)} points need ${String(vertices * vertexRecord)} bytes, but ${String(remaining)} are left.`,
    );
  }
  if (format === 'ascii' && vertices > remaining) {
    throw new PointFileError(`The file is cut off: it cannot hold ${String(vertices)} points as text.`);
  }
  const data = allocate(vertices, red !== undefined);
  const colorOf = (value: number): number => toByte(areShares ? value * 255 : value);
  const store = (values: readonly number[], at: number): void => {
    data.x[at] = values[x] as number;
    data.y[at] = values[y] as number;
    data.z[at] = values[z] as number;
    if (data.colors && red !== undefined && green !== undefined && blue !== undefined) {
      data.colors.set(
        [colorOf(values[red] as number), colorOf(values[green] as number), colorOf(values[blue] as number), 255],
        at * 4,
      );
    }
  };
  if (format === 'ascii') {
    let at = 0;
    await forEachLine(
      file,
      position,
      (line) => {
        if (at < skipped) {
          at++;
        } else if (at < skipped + vertices && line.length > 0) {
          const values = takeNumbers(line, properties.length);
          if (values.length < properties.length) {
            throw new PointFileError(
              `Point ${String(at - skipped + 1)} of the PLY file needs ${String(properties.length)} numbers.`,
            );
          }
          store(values, at - skipped);
          at++;
        } else if (at >= skipped + vertices) {
          return false;
        }
        return undefined;
      },
      report,
    );
    if (at < skipped + vertices) {
      throw new PointFileError(`The file is cut off: it holds ${String(at - skipped)} of ${String(vertices)} points.`);
    }
    return data;
  }
  const little = format === 'little';
  const perRead = Math.max(1, Math.floor(sliceBytes / Math.max(vertexRecord, 1)));
  const values = new Array<number>(properties.length).fill(0);
  const start = position + skippedBytes;
  for (let done = 0; done < vertices;) {
    const take = Math.min(perRead, vertices - done);
    const from = start + done * vertexRecord;
    const view = new DataView(await file.slice(from, from + take * vertexRecord).arrayBuffer());
    for (let record = 0; record < take; record++) {
      const base = record * vertexRecord;
      properties.forEach((property, i) => {
        values[i] = readPlyValue(view, base + property.offset, property.type, little);
      });
      store(values, done + record);
    }
    done += take;
    report?.(done / vertices);
  }
  return data;
}

/** Reads clouds of points from XYZ, PLY and LAS files. */
export interface PointFileReaders {
  /**
   * Reads a file by the extension of its name: `.xyz`, `.txt`, `.pts` and `.csv` as text, `.ply`, `.las`.
   * @throws {@link PointFileError} for a damaged file or one of an unknown kind.
   */
  read(file: Blob, name?: string, report?: ReadProgress): Promise<PointCloudArrays>;
  /** Reads text with x, y and z per line, optionally followed by red, green and blue from 0 to 255. */
  readXyz(file: Blob, report?: ReadProgress): Promise<PointCloudArrays>;
  /** Reads a PLY file, as text or binary in either byte order. */
  readPly(file: Blob, report?: ReadProgress): Promise<PointCloudArrays>;
  /** Reads a LAS file of the versions 1.0 to 1.4. */
  readLas(file: Blob, report?: ReadProgress): Promise<PointCloudArrays>;
}

/** Reads clouds of points from XYZ, PLY and LAS files. */
export const PointFile: PointFileReaders = {
  /**
   * Reads a file by the extension of its name: `.xyz`, `.txt`, `.pts` and `.csv` as text, `.ply`, `.las`.
   * @throws {@link PointFileError} for a damaged file or one of an unknown kind.
   */
  read(file: Blob, name = file instanceof File ? file.name : '', report?: ReadProgress): Promise<PointCloudArrays> {
    const dot = name.lastIndexOf('.');
    const extension = dot < 0 ? '' : name.slice(dot).toUpperCase();
    switch (extension) {
      case '.XYZ':
      case '.TXT':
      case '.PTS':
      case '.CSV':
        return readXyz(file, report);
      case '.PLY':
        return readPly(file, report);
      case '.LAS':
        return readLas(file, report);
      case '.LAZ':
        return Promise.reject(
          new PointFileError('LAZ files are compressed and not supported. Convert the file to LAS first.'),
        );
      default:
        return Promise.reject(
          new PointFileError(`The kind of file '${extension}' is unknown. Known are XYZ, PLY and LAS.`),
        );
    }
  },

  /** Reads text with x, y and z per line, optionally followed by red, green and blue from 0 to 255. */
  readXyz,

  /** Reads a PLY file, as text or binary in either byte order. */
  readPly,

  /** Reads a LAS file of the versions 1.0 to 1.4. */
  readLas,
};
