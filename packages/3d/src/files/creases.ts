// Shares corners between faces that meet at a gentle angle and keeps them apart at a sharp edge, as Creases of the
// .NET version. The light then runs smoothly over a curved part and still shows the edges of a machined one.
import type { Rgba8 } from '@tachyon-charts/core';
import { Point3D } from '../scene/matrix';

/** The cosine of the angle between two faces above which the edge between them stays sharp. */
const smooth = Math.cos((40 * Math.PI) / 180);

/** @internal The points, triangles and colors a reader gives. */
export interface ModelParts {
  readonly positions: Point3D[];
  readonly triangles: number[];
  readonly colors: Rgba8[] | undefined;
}

/** @internal Joins equal corners of separate triangles, as in STL, then keeps sharp edges apart. */
export function joinCorners(corners: readonly Point3D[]): ModelParts {
  const places = new Map<string, number>();
  const positions: Point3D[] = [];
  const triangles = new Array<number>(corners.length);
  const single = new Float32Array(3);
  for (let i = 0; i < corners.length; i++) {
    const point = corners[i] as Point3D;
    // Equal in single precision is the same place; adding zero turns -0 into 0.
    single[0] = point.x;
    single[1] = point.y;
    single[2] = point.z;
    const key = `${String(single[0] + 0)},${String(single[1] + 0)},${String(single[2] + 0)}`;
    let index = places.get(key);
    if (index === undefined) {
      index = positions.length;
      places.set(key, index);
      positions.push(point);
    }
    triangles[i] = index;
  }
  return splitCorners(positions, triangles, undefined);
}

function isZero(point: Point3D): boolean {
  return point.x === 0 && point.y === 0 && point.z === 0;
}

/** @internal Gives a corner one point for each group of faces around it that meet at a gentle angle. */
export function splitCorners(
  positions: readonly Point3D[],
  triangles: readonly number[],
  colors: readonly Rgba8[] | undefined,
): ModelParts {
  // One chain of points for each place, and the face direction each point was made for.
  const first = new Int32Array(positions.length).fill(-1);
  const next: number[] = [];
  const place: number[] = [];
  const facing: Point3D[] = [];
  const result = new Array<number>(triangles.length);
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = positions[triangles[t] as number] as Point3D;
    const b = positions[triangles[t + 1] as number] as Point3D;
    const c = positions[triangles[t + 2] as number] as Point3D;
    const face = Point3D.cross(b.minus(a), c.minus(a)).normalized();
    for (let k = 0; k < 3; k++) {
      const at = triangles[t + k] as number;
      let point = first[at] as number;
      while (
        point >= 0 &&
        Point3D.dot(facing[point] as Point3D, face) < smooth &&
        !isZero(face) &&
        !isZero(facing[point] as Point3D)
      ) {
        point = next[point] as number;
      }
      if (point < 0) {
        point = place.length;
        place.push(at);
        facing.push(face);
        next.push(first[at] as number);
        first[at] = point;
      }
      result[t + k] = point;
    }
  }
  return {
    positions: place.map((at) => positions[at] as Point3D),
    triangles: result,
    colors: colors ? place.map((at) => colors[at] as Rgba8) : undefined,
  };
}
