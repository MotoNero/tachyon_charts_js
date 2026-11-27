// Reads shapefiles (ESRI, 1998) with their dBASE tables, as ShapefileReader of the .NET version: points, lines, areas
// and groups of points, Z and M read as plain shapes. A damaged file says what is wrong and at which byte.

/** The kind of the shapes of a shapefile. */
export type ShapeKind = 'point' | 'line' | 'polygon' | 'multiPoint';

/** A part of a shape: a run of corners, X the longitude and Y the latitude for maps in degrees. */
export interface ShapePart {
  /** The X of the corners. */
  readonly x: Float64Array;
  /** The Y of the corners. */
  readonly y: Float64Array;
}

/** A shape: its parts and the fields of its row in the table. */
export interface GeoShape {
  /** The parts: the rings of an area, the runs of a line, the points of a group. */
  readonly parts: readonly ShapePart[];
  /** The fields of its row, by field name. */
  readonly attributes: ReadonlyMap<string, string>;
}

/** A shapefile: the kind of its shapes, the shapes and the names of the fields of its table. */
export interface Shapefile {
  /** The kind of the shapes. */
  readonly kind: ShapeKind;
  /** The shapes, without the empty ones. */
  readonly shapes: readonly GeoShape[];
  /** The names of the fields of the table. */
  readonly fields: readonly string[];
}

/** A shapefile or its table that is damaged. */
export class ShapefileError extends Error {
  /** The byte where the damage lies. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = 'ShapefileError';
    this.offset = offset;
  }
}

const fileCode = 9994;
const headerSize = 100;

function damaged(name: string, what: string, offset: number): ShapefileError {
  return new ShapefileError(`${name} ${what} (at byte ${String(offset)}).`, offset);
}

function kindOf(type: number, name: string, offset: number): ShapeKind {
  switch (type) {
    case 1:
    case 11:
    case 21:
      return 'point';
    case 3:
    case 13:
    case 23:
      return 'line';
    case 5:
    case 15:
    case 25:
      return 'polygon';
    case 8:
    case 18:
    case 28:
      return 'multiPoint';
    default:
      throw damaged(
        name,
        `has shapes of the type ${String(type)}, which this reader does not know (multipatches are not supported)`,
        offset,
      );
  }
}

const count = (value: number): string => value.toLocaleString('en-US');

/** Reads shapefiles and their tables. */
export const ShapefileReader = {
  /**
   * Reads a shapefile from its bytes and those of its table.
   * @param shapes - The bytes of the `.shp` file.
   * @param table - The bytes of the `.dbf` file, or undefined for shapes without fields.
   * @param name - The name the messages of a damaged file use.
   * @throws ShapefileError when a file is damaged.
   */
  read(shapes: Uint8Array, table?: Uint8Array, name = 'shapefile'): Shapefile {
    const { fields, records } = table && table.length > 0 ? readTable(table, name) : { fields: [], records: [] };
    return readShapes(shapes, name, fields, records);
  },

  /**
   * Reads a shapefile from files, such as those a person drops on the page; the table is the `.dbf` file beside it.
   * @throws ShapefileError when a file is damaged.
   */
  async readFiles(
    shapes: Blob,
    table?: Blob,
    name = shapes instanceof File ? shapes.name : 'shapefile',
  ): Promise<Shapefile> {
    const bytes = new Uint8Array(await shapes.arrayBuffer());
    const rows = table ? new Uint8Array(await table.arrayBuffer()) : undefined;
    return ShapefileReader.read(bytes, rows, name);
  },
};

function readShapes(
  bytes: Uint8Array,
  name: string,
  fields: readonly string[],
  records: readonly ReadonlyMap<string, string>[],
): Shapefile {
  if (bytes.length < headerSize) {
    throw damaged(name, 'is shorter than the header of 100 bytes', 0);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, false) !== fileCode) {
    throw damaged(name, 'is no shapefile: the file code is not 9994', 0);
  }
  const declared = view.getInt32(24, false) * 2;
  if (declared > bytes.length) {
    throw damaged(
      name,
      `is cut off: the header announces ${count(declared)} bytes, the file has ${count(bytes.length)}`,
      24,
    );
  }
  const kind = kindOf(view.getInt32(32, true), name, 32);
  const shapes: GeoShape[] = [];
  let at = headerSize;
  let record = 0;
  while (at + 8 <= declared) {
    record++;
    const length = view.getInt32(at + 4, false) * 2;
    const content = at + 8;
    if (length < 4 || content + length > declared) {
      throw damaged(name, `has a record ${String(record)} of ${String(length)} bytes that runs past the end`, at);
    }
    const parts = readShape(
      new DataView(bytes.buffer, bytes.byteOffset + content, length),
      kind,
      name,
      record,
      content,
    );
    if (parts) {
      shapes.push({ parts, attributes: records[record - 1] ?? new Map<string, string>() });
    }
    at = content + length;
  }
  if (at !== declared) {
    throw damaged(name, `ends inside the header of record ${String(record + 1)}`, at);
  }
  return { kind, shapes, fields };
}

// A record: its type, then the points of a point, the points of a group, or the parts of a line or an area.
function readShape(
  content: DataView,
  kind: ShapeKind,
  name: string,
  record: number,
  offset: number,
): ShapePart[] | undefined {
  const type = content.getInt32(0, true);
  if (type === 0) {
    return undefined;
  }
  if (kindOf(type, name, offset) !== kind) {
    throw damaged(name, `mixes kinds: record ${String(record)} has the type ${String(type)}`, offset);
  }
  if (kind === 'point') {
    need(content, 20, name, record, offset);
    return [{ x: Float64Array.of(content.getFloat64(4, true)), y: Float64Array.of(content.getFloat64(12, true)) }];
  }
  if (kind === 'multiPoint') {
    need(content, 40, name, record, offset);
    const points = content.getInt32(36, true);
    need(content, 40 + points * 16, name, record, offset);
    const x = new Float64Array(points);
    const y = new Float64Array(points);
    for (let i = 0; i < points; i++) {
      x[i] = content.getFloat64(40 + i * 16, true);
      y[i] = content.getFloat64(48 + i * 16, true);
    }
    return [{ x, y }];
  }
  return readParts(content, name, record, offset);
}

// Lines and polygons: the parts, each a run of the points.
function readParts(content: DataView, name: string, record: number, offset: number): ShapePart[] {
  need(content, 44, name, record, offset);
  const parts = content.getInt32(36, true);
  const points = content.getInt32(40, true);
  if (parts < 0 || points < 0) {
    throw damaged(
      name,
      `has a record ${String(record)} with ${String(parts)} parts and ${String(points)} points`,
      offset,
    );
  }
  need(content, 44 + parts * 4 + points * 16, name, record, offset);
  const start = 44 + parts * 4;
  const result: ShapePart[] = [];
  for (let part = 0; part < parts; part++) {
    const first = content.getInt32(44 + part * 4, true);
    const end = part + 1 < parts ? content.getInt32(48 + part * 4, true) : points;
    if (first < 0 || end > points || end < first) {
      throw damaged(
        name,
        `has a record ${String(record)} whose part ${String(part + 1)} runs from point ${String(first)} to ${String(end)} of ${String(points)}`,
        offset,
      );
    }
    const x = new Float64Array(end - first);
    const y = new Float64Array(end - first);
    for (let i = first; i < end; i++) {
      x[i - first] = content.getFloat64(start + i * 16, true);
      y[i - first] = content.getFloat64(start + 8 + i * 16, true);
    }
    result.push({ x, y });
  }
  return result;
}

function need(content: DataView, bytes: number, name: string, record: number, offset: number): void {
  if (content.byteLength < bytes) {
    throw damaged(
      name,
      `has a record ${String(record)} of ${String(content.byteLength)} bytes that needs ${String(bytes)}`,
      offset,
    );
  }
}

// dBASE: a header with the number of records and the sizes, the fields of 32 bytes each up to 0x0D, then the records.
function readTable(bytes: Uint8Array, name: string): { fields: string[]; records: ReadonlyMap<string, string>[] } {
  if (bytes.length < 32) {
    throw damaged(name, 'is shorter than the header of a table', 0);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = view.getInt32(4, true);
  const size = view.getInt16(8, true);
  const recordSize = view.getInt16(10, true);
  if (records < 0 || size < 33 || recordSize < 1 || size + records * recordSize > bytes.length) {
    throw damaged(
      name,
      `announces ${count(records)} records of ${String(recordSize)} bytes after ${String(size)} bytes, more than it holds`,
      4,
    );
  }
  const ascii = new TextDecoder('ascii');
  const utf8 = new TextDecoder('utf-8');
  const fields: { name: string; offset: number; length: number }[] = [];
  let offset = 1;
  for (let at = 32; at + 32 <= size && bytes[at] !== 0x0d; at += 32) {
    const field = ascii.decode(bytes.subarray(at, at + 11)).replace(/[\0 ]+$/u, '');
    const length = bytes[at + 16] as number;
    fields.push({ name: field, offset, length });
    offset += length;
  }
  const rows: ReadonlyMap<string, string>[] = [];
  for (let record = 0; record < records; record++) {
    const row = bytes.subarray(size + record * recordSize, size + (record + 1) * recordSize);
    const values = new Map<string, string>();
    for (const field of fields) {
      values.set(
        field.name,
        field.offset + field.length <= row.length
          ? utf8
              .decode(row.subarray(field.offset, field.offset + field.length))
              .replace(/^[ \u00a0]+|[ \u00a0]+$/gu, '')
          : '',
      );
    }
    rows.push(values);
  }
  return { fields: fields.map((field) => field.name), records: rows };
}
