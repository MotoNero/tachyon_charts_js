// Models made of triangles from STL (text and binary) and OBJ, read with code of its own, as ModelFile, StlReader and
// ObjReader of the .NET version. Materials, textures and the normals of the file are not read: the chart lights the
// model itself and keeps edges sharp where faces meet at more than 40°.
import type { Colormap, DoubleRange, Rgba8 } from '@tachyon-charts/core';
import type { Chart3DBuilder } from '../chart3d-builder';
import { Point3D } from '../scene/matrix';
import { Mesh3D, type ColorScale3D, type Vertex3D } from '../scene/mesh';
import type { Material3D } from '../scene/surface';
import { joinCorners, splitCorners, type ModelParts } from './creases';

const gray: Rgba8 = { r: 190, g: 196, b: 204, a: 255 };
const headerSize = 84;
const triangleSize = 50;

/** A model file that is damaged or of an unknown kind. */
export class ModelFileError extends Error {
  /** The name of the error. */
  override readonly name = 'ModelFileError';
}

/** The options of a mesh from a model in one color. */
export interface ModelMeshOptions {
  /** The color; without it the colors of the file, without those the next color of the theme. */
  readonly color?: Rgba8;
  /** How the model takes the light. */
  readonly material?: Material3D;
  /** The scale of colors the colors of the file come from, shown beside the box. */
  readonly colorScale?: ColorScale3D;
}

/** The triangles of a model file. */
export class ModelFileData {
  /**
   * @param positions - The points. A corner where faces meet at a sharp edge exists once for each side of the edge,
   * so the edge stays sharp in the light.
   * @param triangles - Three numbers of points for each triangle.
   * @param colors - The colors of the points, if the file has them.
   */
  constructor(
    /** The points. */
    readonly positions: readonly Point3D[],
    /** Three numbers of points for each triangle. */
    readonly triangles: readonly number[],
    /** The colors of the points, if the file has them. */
    readonly colors?: readonly Rgba8[],
  ) {}

  /** The number of triangles. */
  get triangleCount(): number {
    return Math.trunc(this.triangles.length / 3);
  }

  /** The smallest coordinates of all points. */
  get lowest(): Point3D {
    return this.bounds()[0];
  }

  /** The largest coordinates of all points. */
  get highest(): Point3D {
    return this.bounds()[1];
  }

  /** Makes a surface for a 3D chart in one color or the colors of the file. */
  toMesh(options: ModelMeshOptions = {}): Mesh3D {
    const colors = this.colors;
    const vertices: Vertex3D[] = this.positions.map((position, i) => ({
      position,
      color: options.color ?? colors?.[i] ?? gray,
    }));
    return new Mesh3D(vertices, this.triangles, {
      material: options.material ?? {},
      ...(options.colorScale ? { colorScale: options.colorScale } : {}),
      // Without a color and without colors of the file the model takes the color of the theme.
      takesThemeColor: options.color === undefined && colors === undefined,
    });
  }

  /**
   * Makes a surface colored by a value per point, such as a measured temperature, with the color scale shown beside
   * the box.
   * @param values - A value per point; one that is not finite gives gray.
   * @param colormap - The colors from the lowest to the highest value.
   * @param range - The values of the ends of the colors.
   * @param material - How the model takes the light.
   * @param title - A title above the scale.
   * @throws RangeError for another number of values than points.
   */
  toValueMesh(
    values: readonly number[],
    colormap: Colormap,
    range: DoubleRange,
    material?: Material3D,
    title?: string,
  ): Mesh3D {
    if (values.length !== this.positions.length) {
      throw new RangeError(`There are ${String(values.length)} values for ${String(this.positions.length)} points.`);
    }
    const span = range.max - range.min;
    const vertices: Vertex3D[] = this.positions.map((position, i) => {
      const value = values[i] as number;
      // A single value in the range takes the middle of the colors.
      const place = span > 0 ? (value - range.min) / span : 0.5;
      return { position, color: Number.isFinite(value) ? colormap.sample(place) : gray };
    });
    return new Mesh3D(vertices, this.triangles, {
      material: material ?? {},
      values,
      colorScale: { colormap, range, ...(title === undefined ? {} : { title }) },
    });
  }

  /**
   * Adds the model to a chart to scale: all three axes get the length of the longest side, centered on the model, so
   * that it keeps its true proportions in the cube of the chart. The axes take the coordinates of the file as they are.
   * @param chart - The chart.
   * @param mesh - The surface of the model; by default the model in the color of the theme.
   * @param unit - The unit of the coordinates in the titles of the axes.
   * @returns The chart.
   */
  addToScale(chart: Chart3DBuilder, mesh?: Mesh3D, unit = 'mm'): Chart3DBuilder {
    const [low, high] = this.bounds();
    let side = Math.max(high.x - low.x, high.y - low.y, high.z - low.z);
    side = side > 0 ? side * 1.02 : 1;
    const center = low.plus(high).times(0.5);
    return chart
      .xAxis(center.x - side / 2, center.x + side / 2, `x in ${unit}`)
      .yAxis(center.y - side / 2, center.y + side / 2, `y in ${unit}`)
      .zAxis(center.z - side / 2, center.z + side / 2, `z in ${unit}`)
      .addMesh(mesh ?? this.toMesh());
  }

  private bounds(): [Point3D, Point3D] {
    if (this.positions.length === 0) {
      return [Point3D.zero, Point3D.zero];
    }
    let [lx, ly, lz, hx, hy, hz] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const p of this.positions) {
      lx = Math.min(lx, p.x);
      ly = Math.min(ly, p.y);
      lz = Math.min(lz, p.z);
      hx = Math.max(hx, p.x);
      hy = Math.max(hy, p.y);
      hz = Math.max(hz, p.z);
    }
    return [new Point3D(lx, ly, lz), new Point3D(hx, hy, hz)];
  }
}

function toData(parts: ModelParts): ModelFileData {
  return new ModelFileData(parts.positions, parts.triangles, parts.colors);
}

function startsWith(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (bytes[i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

// Calls back for each line, trimmed, with its number from 1.
function forEachLine(bytes: Uint8Array, read: (line: string, number: number) => void): void {
  const text = new TextDecoder().decode(bytes);
  let number = 1;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) {
      end = text.length;
    }
    read(text.slice(start, end).trim(), number++);
    start = end + 1;
  }
}

// The numbers of the rest of a line, separated by blanks, tabs, commas or semicolons; NaN where a word is no number.
function numbers(rest: string): number[] {
  const words = rest.split(/[ \t,;]+/).filter((word) => word.length > 0);
  return words.map((word) => (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word) ? Number(word) : Number.NaN));
}

function finite3(values: readonly number[]): boolean {
  return values.length >= 3 && values.slice(0, 3).every((value) => Number.isFinite(value));
}

function readBinaryStl(bytes: Uint8Array): ModelFileData {
  if (bytes.length < headerSize) {
    throw new ModelFileError(
      `The file holds ${String(bytes.length)} bytes, a binary STL file needs at least ${String(headerSize)}.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (count === 0) {
    throw new ModelFileError('The file holds no triangles.');
  }
  const present = Math.trunc((bytes.length - headerSize) / triangleSize);
  if (present < count) {
    throw new ModelFileError(`The file ends after ${String(present)} of ${String(count)} triangles.`);
  }
  const corners = new Array<Point3D>(count * 3);
  for (let t = 0; t < count; t++) {
    for (let c = 0; c < 3; c++) {
      const at = headerSize + t * triangleSize + 12 + c * 12;
      const point = new Point3D(
        view.getFloat32(at, true),
        view.getFloat32(at + 4, true),
        view.getFloat32(at + 8, true),
      );
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
        throw new ModelFileError(`Triangle ${String(t + 1)} has a corner that is not a finite number.`);
      }
      corners[t * 3 + c] = point;
    }
  }
  return toData(joinCorners(corners));
}

const knownStlWords = ['solid', 'endsolid', 'facet', 'endfacet', 'outer', 'endloop'];

function readTextStl(bytes: Uint8Array): ModelFileData {
  const corners: Point3D[] = [];
  forEachLine(bytes, (line, number) => {
    if (!line.startsWith('vertex')) {
      if (line.length > 0 && !knownStlWords.some((word) => line.startsWith(word))) {
        throw new ModelFileError(`Line ${String(number)} is not part of an STL file: '${line.slice(0, 40)}'.`);
      }
      return;
    }
    const values = numbers(line.slice('vertex'.length));
    if (!finite3(values)) {
      throw new ModelFileError(`Line ${String(number)} needs three finite numbers after 'vertex'.`);
    }
    corners.push(new Point3D(values[0] as number, values[1] as number, values[2] as number));
  });
  if (corners.length === 0) {
    throw new ModelFileError('The file holds no triangles.');
  }
  if (corners.length % 3 !== 0) {
    throw new ModelFileError(
      `The file holds ${String(corners.length)} corners, which is no whole number of triangles.`,
    );
  }
  return toData(joinCorners(corners));
}

function toByte(value: number): number {
  return Math.min(Math.max(Math.round(value * 255), 0), 255);
}

function readObjModel(bytes: Uint8Array): ModelFileData {
  const positions: Point3D[] = [];
  const colors: Rgba8[] = [];
  const triangles: number[] = [];
  let highest = -1;
  let highestLine = 0;
  forEachLine(bytes, (line, number) => {
    const kind = line[0];
    if (line.length < 2 || (line[1] !== ' ' && line[1] !== '\t') || (kind !== 'v' && kind !== 'f')) {
      return;
    }
    const rest = line.slice(2);
    if (kind === 'v') {
      const values = numbers(rest);
      if (!finite3(values)) {
        throw new ModelFileError(`Line ${String(number)} needs three finite numbers after 'v'.`);
      }
      positions.push(new Point3D(values[0] as number, values[1] as number, values[2] as number));
      if (values.length >= 6 && values.slice(3, 6).every((value) => !Number.isNaN(value))) {
        colors.push({
          r: toByte(values[3] as number),
          g: toByte(values[4] as number),
          b: toByte(values[5] as number),
          a: 255,
        });
      }
      return;
    }
    // A corner is "i", "i/t", "i//n" or "i/t/n"; only the number of the point counts. Negative numbers count back from
    // the last point read so far.
    const corners = rest
      .split(/[ \t]+/)
      .filter((word) => word.length > 0)
      .map((word) => {
        const head = word.split('/')[0] ?? '';
        const index = /^[+-]?\d+$/.test(head) ? Number(head) : 0;
        if (index === 0) {
          throw new ModelFileError(`Line ${String(number)} holds a corner that is not a point number.`);
        }
        const corner = index > 0 ? index - 1 : positions.length + index;
        if (corner < 0) {
          throw new ModelFileError(
            `Line ${String(number)} counts back ${String(-index)} points, but only ${String(positions.length)} are read so far.`,
          );
        }
        return corner;
      });
    if (corners.length < 3) {
      throw new ModelFileError(`The face in line ${String(number)} has fewer than three corners.`);
    }
    // A face with more than three corners becomes a fan of triangles around its first corner.
    for (let i = 1; i + 1 < corners.length; i++) {
      triangles.push(corners[0] as number, corners[i] as number, corners[i + 1] as number);
    }
    const most = Math.max(...corners);
    if (most > highest) {
      highest = most;
      highestLine = number;
    }
  });
  if (triangles.length === 0) {
    throw new ModelFileError('The file holds no faces.');
  }
  // Faces may name points that follow later, so the check waits for the end.
  if (highest >= positions.length) {
    throw new ModelFileError(
      `The face in line ${String(highestLine)} uses point ${String(highest + 1)}, but the file holds only ${String(positions.length)} points.`,
    );
  }
  const hasColors = colors.length > 0 && colors.length === positions.length;
  return toData(splitCorners(positions, triangles, hasColors ? colors : undefined));
}

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** Reads models made of triangles from STL (text and binary) and OBJ. */
export const ModelFile = {
  /**
   * Reads an STL file, as text or binary. A binary file has no shared corners, so equal corners are joined to give a
   * smooth surface.
   * @throws {@link ModelFileError} for a damaged file.
   */
  readStl(data: ArrayBuffer | Uint8Array): ModelFileData {
    const bytes = toBytes(data);
    if (bytes.length === 0) {
      throw new ModelFileError('The file is empty.');
    }
    const named =
      bytes.length >= headerSize
        ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true)
        : 0;
    const isText =
      startsWith(bytes, 'solid') && (bytes.length < headerSize || bytes.length !== headerSize + named * triangleSize);
    return isText ? readTextStl(bytes) : readBinaryStl(bytes);
  },

  /**
   * Reads the points (`v`, optionally with red, green and blue from 0 to 1) and faces (`f`) of an OBJ file. Faces with
   * more than three corners become a fan of triangles.
   * @throws {@link ModelFileError} for a damaged file.
   */
  readObj(data: ArrayBuffer | Uint8Array): ModelFileData {
    return readObjModel(toBytes(data));
  },

  /**
   * Reads a file by the extension of its name, `.stl` or `.obj`.
   * @throws {@link ModelFileError} for a damaged file or one of an unknown kind.
   */
  async read(file: Blob, name = file instanceof File ? file.name : ''): Promise<ModelFileData> {
    const dot = name.lastIndexOf('.');
    const extension = dot < 0 ? '' : name.slice(dot).toUpperCase();
    if (extension !== '.STL' && extension !== '.OBJ') {
      throw new ModelFileError(`The kind of file '${extension}' is unknown. Known are STL and OBJ.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return extension === '.STL' ? ModelFile.readStl(bytes) : ModelFile.readObj(bytes);
  },
};
