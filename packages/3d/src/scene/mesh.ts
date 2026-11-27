// Surfaces from triangles with a color per corner, as Mesh3D, Vertex3D and ColorScale3D of the .NET version.
import type { Colormap, DoubleRange, Rgba8 } from '@tachyon-charts/core';
import { Point3D } from './matrix';
import type { Material3D } from './surface';

/** A corner of a mesh: its place in units of the axes and its color. */
export interface Vertex3D {
  /** The place. */
  readonly position: Point3D;
  /** The color. */
  readonly color: Rgba8;
}

/** The scale of colors a mesh shows beside the box, with the values of its ends. */
export interface ColorScale3D {
  /** The colors from the lowest to the highest value. */
  readonly colormap: Colormap;
  /** The values of the ends. */
  readonly range: DoubleRange;
  /** A title above the scale. */
  readonly title?: string;
}

/** The options of a mesh. */
export interface Mesh3DOptions {
  /** How the mesh takes the light. */
  readonly material?: Material3D;
  /** The scale of colors beside the box. */
  readonly colorScale?: ColorScale3D;
  /** Whether the mesh takes the next color of the theme instead of the colors of its corners; false by default. */
  readonly takesThemeColor?: boolean;
  /** A value per corner, for its label. */
  readonly values?: readonly number[];
}

/** A surface from triangles: three corners per triangle, given by their numbers. */
export class Mesh3D {
  /** How the mesh takes the light. */
  readonly material: Material3D | undefined;
  /** The scale of colors beside the box. */
  readonly colorScale: ColorScale3D | undefined;
  /** Whether the mesh takes the next color of the theme. */
  readonly takesThemeColor: boolean;
  /** A value per corner. */
  readonly values: readonly number[] | undefined;
  /** The mesh does not change. */
  readonly version = 0;

  /**
   * @param vertices - The corners.
   * @param indices - Three numbers of corners per triangle.
   * @param options - Material, color scale and values.
   * @throws RangeError for a value list of another length than the corners.
   */
  constructor(
    /** The corners. */
    readonly vertices: readonly Vertex3D[],
    /** Three numbers of corners per triangle. */
    readonly indices: readonly number[],
    options: Mesh3DOptions = {},
  ) {
    if (options.values && options.values.length !== vertices.length) {
      throw new RangeError(`There are ${String(options.values.length)} values for ${String(vertices.length)} points.`);
    }
    this.material = options.material;
    this.colorScale = options.colorScale;
    this.takesThemeColor = options.takesThemeColor ?? false;
    this.values = options.values;
  }
}

function isFinite3(point: Point3D): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

/** @internal The triangles whose three corners are all finite. */
export function validIndices(positions: readonly Point3D[], indices: readonly number[]): Uint32Array {
  const valid: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] as number;
    const b = indices[i + 1] as number;
    const c = indices[i + 2] as number;
    if (
      isFinite3(positions[a] as Point3D) &&
      isFinite3(positions[b] as Point3D) &&
      isFinite3(positions[c] as Point3D)
    ) {
      valid.push(a, b, c);
    }
  }
  return Uint32Array.from(valid);
}

/** @internal A normal per corner: the sum of the faces around it, weighted by their size, made length 1. */
export function calculateNormals(positions: readonly Point3D[], indices: readonly number[]): Point3D[] {
  const normals = positions.map(() => Point3D.zero);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] as number;
    const b = indices[i + 1] as number;
    const c = indices[i + 2] as number;
    const pa = positions[a] as Point3D;
    const face = Point3D.cross((positions[b] as Point3D).minus(pa), (positions[c] as Point3D).minus(pa));
    if (isFinite3(face)) {
      normals[a] = (normals[a] as Point3D).plus(face);
      normals[b] = (normals[b] as Point3D).plus(face);
      normals[c] = (normals[c] as Point3D).plus(face);
    }
  }
  return normals.map((normal) => normal.normalized());
}
