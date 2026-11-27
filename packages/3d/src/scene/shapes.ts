// Flat shapes in space as meshes, as Shapes3D of the .NET version: free polygons, rectangles and planes at a limit.
// They take the light, cut planes and the pointer like any mesh, and with an opacity below 1 they show what lies behind
// them, without sorting.
import { Polygon, PolygonRing, type DoubleRange, type Rgba8 } from '@tachyon-charts/core';
import { Point3D } from './matrix';
import { Mesh3D, type Vertex3D } from './mesh';
import type { Material3D } from './surface';

/** The look of a plane at a limit: see-through and without highlights. */
const limitMaterial: Material3D = { opacity: 0.35, gloss: 0 };

/** Makes flat shapes in space as meshes: free polygons, rectangles and planes at a limit. */
export const Shapes3D = {
  /** The look of a plane at a limit: see-through and without highlights. */
  limitMaterial,

  /**
   * Places a polygon, holes included, on a plane in space: a corner (x, y) of the polygon lies at
   * origin + across · x + up · y.
   */
  polygon(
    shape: Polygon,
    origin: Point3D,
    across: Point3D,
    up: Point3D,
    color: Rgba8,
    material: Material3D = {},
  ): Mesh3D {
    const { x, y, triangles } = shape.triangulate();
    const vertices: Vertex3D[] = x.map((value, i) => ({
      position: origin.plus(across.times(value)).plus(up.times(y[i] as number)),
      color,
    }));
    return new Mesh3D(vertices, triangles, { material });
  },
  /**
   * Makes a flat polygon from corners in space. Corners off one plane are moved onto the plane that fits them best.
   * @throws RangeError for fewer than three corners or corners on one line.
   */
  polygonThrough(corners: readonly Point3D[], color: Rgba8, material: Material3D = {}): Mesh3D {
    if (corners.length < 3) {
      throw new RangeError(`A polygon needs at least three corners, there are ${String(corners.length)}.`);
    }
    // The normal of Newell's method fits any order of corners, also when the polygon is concave.
    let normal = Point3D.zero;
    let middle = Point3D.zero;
    corners.forEach((a, i) => {
      const b = corners[(i + 1) % corners.length] as Point3D;
      normal = normal.plus(
        new Point3D((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)),
      );
      middle = middle.plus(a);
    });
    middle = middle.times(1 / corners.length);
    if (normal.length < 1e-12 || !Number.isFinite(normal.length)) {
      throw new RangeError('The corners lie on one line or are not finite.');
    }
    normal = normal.normalized();
    const helper = Math.abs(normal.z) < 0.9 ? new Point3D(0, 0, 1) : new Point3D(1, 0, 0);
    const across = Point3D.cross(helper, normal).normalized();
    const up = Point3D.cross(normal, across);
    const xs = corners.map((corner) => Point3D.dot(corner.minus(middle), across));
    const ys = corners.map((corner) => Point3D.dot(corner.minus(middle), up));
    return Shapes3D.polygon(new Polygon(new PolygonRing(xs, ys)), middle, across, up, color, material);
  },
  /** Makes a rectangle from a corner and its two sides. */
  rectangle(corner: Point3D, across: Point3D, up: Point3D, color: Rgba8, material: Material3D = {}): Mesh3D {
    const vertices: Vertex3D[] = [
      { position: corner, color },
      { position: corner.plus(across), color },
      { position: corner.plus(across).plus(up), color },
      { position: corner.plus(up), color },
    ];
    return new Mesh3D(vertices, [0, 1, 2, 0, 2, 3], { material });
  },
  /** Makes a level plane at a limit of the third axis, such as an alarm threshold; see-through by default. */
  limit(x: DoubleRange, y: DoubleRange, value: number, color: Rgba8, material: Material3D = limitMaterial): Mesh3D {
    const plane = Shapes3D.rectangle(
      new Point3D(x.min, y.min, value),
      new Point3D(x.max - x.min, 0, 0),
      new Point3D(0, y.max - y.min, 0),
      color,
    );
    return new Mesh3D(plane.vertices, plane.indices, { material, values: [value, value, value, value] });
  },
};
