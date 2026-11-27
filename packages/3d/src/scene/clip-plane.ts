// A plane through the box that cuts away what lies beyond it, as ClipPlane3D of the .NET version.
import type { DoubleRange } from '@tachyon-charts/core';
import type { SceneAxes } from './axis-box';
import { gridPlace, type Bars3D, type GridPlace } from './bars';
import { Point3D } from './matrix';
import type { Surface3D } from './surface';

const reach = 1.7321;
const tiny = 1e-9;
const rayTiny = 1e-12;

/** A cut through a raster along a plane, ready for a 2D chart. */
export interface CutCurve {
  /** The way along the cut, in units of the box. */
  readonly along: number[];
  /** The first coordinates of the points. */
  readonly x: number[];
  /** The second coordinates of the points. */
  readonly y: number[];
  /** The values at the points. */
  readonly values: number[];
}

/** The options of a plane. */
export interface ClipPlane3DOptions {
  /** Whether the far side disappears; true by default. Without it the plane only gives its cuts. */
  readonly hides?: boolean;
}

// Limits a way along one axis to a range; whether something is left.
function limit1(start: number, direction: number, low: number, high: number, span: [number, number]): boolean {
  if (Math.abs(direction) < rayTiny) {
    return start >= low && start <= high;
  }
  let a = (low - start) / direction;
  let b = (high - start) / direction;
  if (a > b) {
    [a, b] = [b, a];
  }
  span[0] = Math.max(span[0], a);
  span[1] = Math.min(span[1], b);
  return span[0] <= span[1];
}

// The corners of the box from -1 to 1, one bit per axis.
function corner(bits: number): Point3D {
  return new Point3D((bits & 1) === 0 ? -1 : 1, (bits & 2) === 0 ? -1 : 1, (bits & 4) === 0 ? -1 : 1);
}

/**
 * A plane through the box. What lies on the far side of its normal disappears, for every kind of data. The plane
 * lives in box coordinates, where all axes span -1 to 1, so that it can stand at any angle. The chart moves it when
 * its outline is dragged.
 */
export class ClipPlane3D {
  /** The direction to the side that stays, with the length 1. */
  readonly normal: Point3D;
  /** Whether the far side disappears. */
  readonly hides: boolean;
  private place: number;
  private changes = 0;

  /**
   * @param normal - The direction to the side that stays.
   * @param offset - The distance of the plane from the middle of the box.
   * @param options - Whether the far side disappears.
   * @throws RangeError for a normal without a direction.
   */
  constructor(normal: Point3D, offset = 0, options: ClipPlane3DOptions = {}) {
    if (normal.length < tiny) {
      throw new RangeError('A plane needs a direction.');
    }
    this.normal = normal.normalized();
    this.place = offset;
    this.hides = options.hides ?? true;
  }

  /** The distance of the plane from the middle of the box, kept inside the reach of the box. */
  get offset(): number {
    return this.place;
  }

  set offset(value: number) {
    this.place = Math.min(Math.max(value, -reach), reach);
    this.changes++;
  }

  /** Grows when the plane moves. */
  get version(): number {
    return this.changes;
  }

  /** Cuts a surface. It works for planes that stand upright, as a height needs one place per way along the cut. */
  cutSurface(surface: Surface3D, scene: SceneAxes): CutCurve {
    const data = surface.data;
    const place = gridPlace(scene, surface.x, surface.y, data.width, data.height);
    return this.cut(place, surface.x, surface.y, (x, y) => {
      const column = Math.min(Math.trunc(x), data.width - 2);
      const row = Math.min(Math.trunc(y), data.height - 2);
      const right = x - column;
      const back = y - row;
      const front = data.at(column, row) * (1 - right) + data.at(column + 1, row) * right;
      const rear = data.at(column, row + 1) * (1 - right) + data.at(column + 1, row + 1) * right;
      return front * (1 - back) + rear * back;
    });
  }

  /** Cuts columns. It works for planes that stand upright. */
  cutBars(bars: Bars3D, scene: SceneAxes): CutCurve {
    const data = bars.data;
    return this.cut(bars.cells(scene), bars.x, bars.y, (x, y) =>
      data.at(Math.min(Math.trunc(x), data.width - 1), Math.min(Math.trunc(y), data.height - 1)),
    );
  }

  /** @internal The corners of the plane inside the box, in order around it. */
  outline(): Point3D[] {
    const corners: Point3D[] = [];
    const offset = this.place;
    for (let bits = 0; bits < 8; bits++) {
      const a = corner(bits);
      for (let axis = 1; axis <= 4; axis *= 2) {
        // Each edge of the box once: from the corner on its low side.
        if ((bits & axis) === 0) {
          const b = corner(bits | axis);
          const first = Point3D.dot(a, this.normal) - offset;
          const second = Point3D.dot(b, this.normal) - offset;
          if (first < 0 !== second < 0) {
            corners.push(a.plus(b.minus(a).times(first / (first - second))));
          }
        }
      }
    }
    if (corners.length < 3) {
      return corners;
    }
    let middle = Point3D.zero;
    for (const point of corners) {
      middle = middle.plus(point.times(1 / corners.length));
    }
    const side = Math.abs(this.normal.x) < 0.9 ? new Point3D(1, 0, 0) : new Point3D(0, 1, 0);
    const u = Point3D.cross(this.normal, side).normalized();
    const v = Point3D.cross(this.normal, u);
    const angle = (point: Point3D): number => {
      const way = point.minus(middle);
      return Math.atan2(Point3D.dot(way, v), Point3D.dot(way, u));
    };
    return corners.sort((a, b) => angle(a) - angle(b));
  }

  private cut(place: GridPlace, x: DoubleRange, y: DoubleRange, read: (x: number, y: number) => number): CutCurve {
    const empty: CutCurve = { along: [], x: [], y: [], values: [] };
    const normal = this.normal;
    if (Math.abs(normal.z) > tiny) {
      return empty;
    }
    const startX = (normal.x * this.place - place.left) / place.stepX;
    const startY = (normal.y * this.place - place.front) / place.stepY;
    let wayX = -normal.y / place.stepX;
    let wayY = normal.x / place.stepY;
    // The curve runs along rising coordinates, which is what a 2D line needs.
    if (wayX < -tiny || (Math.abs(wayX) <= tiny && wayY < 0)) {
      wayX = -wayX;
      wayY = -wayY;
    }
    const span: [number, number] = [-Infinity, Infinity];
    if (!limit1(startX, wayX, 0, place.columns - 1, span) || !limit1(startY, wayY, 0, place.rows - 1, span)) {
      return empty;
    }
    const [near, far] = span;
    const count = Math.max(place.columns + place.rows, 2);
    const curve: CutCurve = { along: [], x: [], y: [], values: [] };
    for (let i = 0; i < count; i++) {
      const distance = near + ((far - near) * i) / (count - 1);
      const column = Math.min(Math.max(startX + wayX * distance, 0), place.columns - 1);
      const row = Math.min(Math.max(startY + wayY * distance, 0), place.rows - 1);
      curve.along.push(distance - near);
      curve.x.push(x.min + ((x.max - x.min) * column) / (place.columns - 1));
      curve.y.push(y.min + ((y.max - y.min) * row) / (place.rows - 1));
      curve.values.push(read(column, row));
    }
    return curve;
  }
}
