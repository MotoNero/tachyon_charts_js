// A map from measured points at uneven places, as MeasuredMap3D of the .NET version.
import { Colormap, type Axis } from '@tachyon-charts/core';
import { toBox } from './axis-box';
import { Point3D } from './matrix';
import { Mesh3D, type Vertex3D } from './mesh';
import type { Material3D } from './surface';
import { triangulate } from './triangulation';

/** The options of a measured map. */
export interface MeasuredMap3DOptions {
  /** The colors from the lowest to the highest value; Viridis by default. */
  readonly colormap?: Colormap;
  /** How the surface takes the light. */
  readonly material?: Material3D;
  /** Whether the measured points are marked; true by default. */
  readonly showsPoints?: boolean;
  /**
   * The longest edge of a triangle as a share of the box width; no limit by default. Longer triangles are left out,
   * so that wide gaps between measurements stay empty.
   */
  readonly longestEdge?: number;
}

/**
 * A map from measured points at uneven places, such as temperature over speed and load: the points are connected to a
 * surface. Beyond the outer points the surface ends, and points with a missing value are left out.
 */
export class MeasuredMap3D {
  /** The first coordinates. */
  readonly x: readonly number[];
  /** The second coordinates. */
  readonly y: readonly number[];
  /** The measured values. */
  readonly z: readonly number[];
  /** The colors. */
  readonly colormap: Colormap;
  /** How the surface takes the light. */
  readonly material: Material3D;
  /** Whether the measured points are marked. */
  readonly showsPoints: boolean;
  /** The longest edge of a triangle as a share of the box width, or undefined for no limit. */
  readonly longestEdge: number | undefined;
  /** The map does not change. */
  readonly version = 0;

  /**
   * @param x - The first coordinates.
   * @param y - The second coordinates.
   * @param z - The measured values.
   * @param options - Colors, material, marks and the longest edge.
   */
  constructor(x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>, options: MeasuredMap3DOptions = {}) {
    this.x = Array.from(x);
    this.y = Array.from(y);
    this.z = Array.from(z);
    this.colormap = options.colormap ?? Colormap.builtIn('viridis');
    this.material = options.material ?? {};
    this.showsPoints = options.showsPoints ?? true;
    this.longestEdge = options.longestEdge;
  }

  /** @internal Connects the points. The triangles form in the box, so that axes of different size weigh alike. */
  createMesh(xAxis: Axis, yAxis: Axis): Mesh3D {
    const count = Math.min(this.x.length, this.y.length, this.z.length);
    const kept: number[] = [];
    for (let i = 0; i < count; i++) {
      if (Number.isFinite(this.x[i]) && Number.isFinite(this.y[i]) && Number.isFinite(this.z[i])) {
        kept.push(i);
      }
    }
    const boxX = kept.map((i) => toBox(xAxis, this.x[i] as number));
    const boxY = kept.map((i) => toBox(yAxis, this.y[i] as number));
    let low = Infinity;
    let high = -Infinity;
    for (const i of kept) {
      low = Math.min(low, this.z[i] as number);
      high = Math.max(high, this.z[i] as number);
    }
    const vertices: Vertex3D[] = kept.map((i) => {
      const value = this.z[i] as number;
      const share = high > low ? (value - low) / (high - low) : 0.5;
      return {
        position: new Point3D(this.x[i] as number, this.y[i] as number, value),
        color: this.colormap.sample(share),
      };
    });
    return new Mesh3D(vertices, this.shorten(triangulate(boxX, boxY), boxX, boxY), { material: this.material });
  }

  private shorten(triangles: number[], x: readonly number[], y: readonly number[]): number[] {
    const longest = this.longestEdge;
    if (longest === undefined) {
      return triangles;
    }
    const limit = 2 * longest * 2 * longest;
    const square = (a: number, b: number): number =>
      ((x[a] as number) - (x[b] as number)) * ((x[a] as number) - (x[b] as number)) +
      ((y[a] as number) - (y[b] as number)) * ((y[a] as number) - (y[b] as number));
    const kept: number[] = [];
    for (let i = 0; i + 2 < triangles.length; i += 3) {
      const a = triangles[i] as number;
      const b = triangles[i + 1] as number;
      const c = triangles[i + 2] as number;
      if (square(a, b) <= limit && square(b, c) <= limit && square(c, a) <= limit) {
        kept.push(a, b, c);
      }
    }
    return kept;
  }
}
