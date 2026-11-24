// Polygons with holes: their rings, the test whether a point lies inside, the triangles to fill them and the mask of
// a grid, as PolygonRing, Polygon, PolygonTriangulator and PolygonMask of the .NET version.
import type { Rgba8 } from '../render/types';

/** A closed ring of corners; the last corner connects to the first. */
export class PolygonRing {
  /** The X of the corners. */
  readonly x: readonly number[];
  /** The Y of the corners. */
  readonly y: readonly number[];

  /**
   * @param x - The X of the corners.
   * @param y - The Y of the corners, one per X.
   * @throws RangeError with fewer than three corners, a Y missing or a corner that is not finite.
   */
  constructor(x: ArrayLike<number>, y: ArrayLike<number>) {
    if (x.length !== y.length || x.length < 3) {
      throw new RangeError('A ring needs at least three corners with an X and a Y each.');
    }
    this.x = Array.from(x);
    this.y = Array.from(y);
    for (let i = 0; i < this.x.length; i++) {
      if (!Number.isFinite(this.x[i]) || !Number.isFinite(this.y[i])) {
        throw new RangeError('The corners of a ring must be finite.');
      }
    }
  }

  /** The number of corners. */
  get count(): number {
    return this.x.length;
  }

  /** @internal Twice the signed area: positive when the ring turns counterclockwise. */
  get doubleArea(): number {
    let sum = 0;
    for (let i = 0, j = this.count - 1; i < this.count; j = i++) {
      sum += (this.x[j] as number) * (this.y[i] as number) - (this.x[i] as number) * (this.y[j] as number);
    }
    return sum;
  }
}

function inside(ring: PolygonRing, x: number, y: number): boolean {
  let result = false;
  for (let i = 0, j = ring.count - 1; i < ring.count; j = i++) {
    const xi = ring.x[i] as number;
    const yi = ring.y[i] as number;
    const xj = ring.x[j] as number;
    const yj = ring.y[j] as number;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      result = !result;
    }
  }
  return result;
}

/** A polygon: an outer ring and holes, with a name and a color of its own if wanted. */
export class Polygon {
  /** The holes. */
  readonly holes: readonly PolygonRing[];

  /**
   * @param outer - The outer ring.
   * @param holes - The holes inside it.
   * @param name - The name.
   * @param color - The color; the palette when left out.
   */
  constructor(
    /** The outer ring. */
    readonly outer: PolygonRing,
    holes: readonly PolygonRing[] = [],
    /** The name. */
    readonly name = '',
    /** The color; the palette when left out. */
    readonly color?: Rgba8,
  ) {
    this.holes = [...holes];
  }

  /** Whether a point lies inside: in the outer ring and in no hole. */
  contains(x: number, y: number): boolean {
    return inside(this.outer, x, y) && !this.holes.some((hole) => inside(hole, x, y));
  }

  /** The corners joined into one ring with the holes, and the triangles as triples of corner indices. */
  triangulate(): { x: number[]; y: number[]; triangles: number[] } {
    return triangulate(this);
  }
}

const cross = (ax: number, ay: number, bx: number, by: number, px: number, py: number): number =>
  (bx - ax) * (py - ay) - (by - ay) * (px - ax);

function intersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

function ordered(ring: PolygonRing, counterclockwise: boolean): { x: number[]; y: number[] } {
  const x = [...ring.x];
  const y = [...ring.y];
  if (ring.doubleArea > 0 !== counterclockwise) {
    x.reverse();
    y.reverse();
  }
  return { x, y };
}

// The nearest corner of the ring that the hole corner sees without crossing an edge of the ring or of the hole
// itself: with several corners at the same distance, the first one may lie on the far side of the hole.
function nearest(xs: number[], ys: number[], hx: number[], hy: number[], start: number): number {
  const x = hx[start] as number;
  const y = hy[start] as number;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < xs.length; i++) {
    const cx = xs[i] as number;
    const cy = ys[i] as number;
    const distance = (cx - x) * (cx - x) + (cy - y) * (cy - y);
    if (distance >= bestDistance || crossesRing(xs, ys, i, x, y) || crossesHole(hx, hy, start, cx, cy)) {
      continue;
    }
    best = i;
    bestDistance = distance;
  }
  return best < 0 ? 0 : best;
}

function crossesRing(xs: number[], ys: number[], corner: number, x: number, y: number): boolean {
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    if (i === corner || j === corner) {
      continue;
    }
    if (
      intersect(
        xs[corner] as number,
        ys[corner] as number,
        x,
        y,
        xs[j] as number,
        ys[j] as number,
        xs[i] as number,
        ys[i] as number,
      )
    ) {
      return true;
    }
  }
  return false;
}

function crossesHole(hx: number[], hy: number[], start: number, x: number, y: number): boolean {
  for (let i = 0, j = hx.length - 1; i < hx.length; j = i++) {
    if (
      i !== start &&
      j !== start &&
      intersect(
        hx[start] as number,
        hy[start] as number,
        x,
        y,
        hx[j] as number,
        hy[j] as number,
        hx[i] as number,
        hy[i] as number,
      )
    ) {
      return true;
    }
  }
  return false;
}

// The outer ring counterclockwise, each hole clockwise, joined at its rightmost corner to a visible corner of the ring.
function join(polygon: Polygon): { x: number[]; y: number[] } {
  let { x: xs, y: ys } = ordered(polygon.outer, true);
  // The holes from the one reaching furthest right; a stable order for equal ones, as OrderByDescending.
  const holes = polygon.holes
    .map((hole, index) => ({ hole, index, right: Math.max(...hole.x) }))
    .sort((a, b) => b.right - a.right || a.index - b.index);
  for (const { hole } of holes) {
    const { x: hx, y: hy } = ordered(hole, false);
    const start = hx.indexOf(Math.max(...hx));
    const bridge = nearest(xs, ys, hx, hy, start);
    const joinedX: number[] = [];
    const joinedY: number[] = [];
    for (let i = 0; i <= bridge; i++) {
      joinedX.push(xs[i] as number);
      joinedY.push(ys[i] as number);
    }
    for (let i = 0; i <= hx.length; i++) {
      joinedX.push(hx[(start + i) % hx.length] as number);
      joinedY.push(hy[(start + i) % hx.length] as number);
    }
    for (let i = bridge; i < xs.length; i++) {
      joinedX.push(xs[i] as number);
      joinedY.push(ys[i] as number);
    }
    xs = joinedX;
    ys = joinedY;
  }
  return { x: xs, y: ys };
}

function isEar(xs: number[], ys: number[], indices: number[], a: number, b: number, c: number): boolean {
  const ax = xs[a] as number;
  const ay = ys[a] as number;
  const bx = xs[b] as number;
  const by = ys[b] as number;
  const cx = xs[c] as number;
  const cy = ys[c] as number;
  // Convex at b for a counterclockwise ring, and no other corner inside the triangle.
  if (cross(ax, ay, bx, by, cx, cy) <= 0) {
    return false;
  }
  for (const p of indices) {
    const px = xs[p] as number;
    const py = ys[p] as number;
    if (
      p === a ||
      p === b ||
      p === c ||
      (px === ax && py === ay) ||
      (px === bx && py === by) ||
      (px === cx && py === cy)
    ) {
      continue;
    }
    if (
      cross(ax, ay, bx, by, px, py) >= 0 &&
      cross(bx, by, cx, cy, px, py) >= 0 &&
      cross(cx, cy, ax, ay, px, py) >= 0
    ) {
      return false;
    }
  }
  return true;
}

/** @internal The triangles of a polygon by ear clipping, after joining its holes into the outer ring. */
export function triangulate(polygon: Polygon): { x: number[]; y: number[]; triangles: number[] } {
  const { x: xs, y: ys } = join(polygon);
  const count = xs.length;
  const indices = Array.from({ length: count }, (_, i) => i);
  const triangles: number[] = [];
  let guard = 0;
  while (indices.length > 3 && guard++ < count * count) {
    let clipped = false;
    for (let k = 0; k < indices.length; k++) {
      const a = indices[(k + indices.length - 1) % indices.length] as number;
      const b = indices[k] as number;
      const c = indices[(k + 1) % indices.length] as number;
      if (!isEar(xs, ys, indices, a, b, c)) {
        continue;
      }
      triangles.push(a, b, c);
      indices.splice(k, 1);
      clipped = true;
      break;
    }
    // A ring that is not simple has no more ears; the rest falls out rather than looping.
    if (!clipped) {
      break;
    }
  }
  if (indices.length === 3) {
    triangles.push(indices[0] as number, indices[1] as number, indices[2] as number);
  }
  return { x: xs, y: ys, triangles };
}

function addCrossings(ring: PolygonRing, y: number, crossings: number[]): void {
  for (let i = 0, j = ring.count - 1; i < ring.count; j = i++) {
    const y1 = ring.y[j] as number;
    const y2 = ring.y[i] as number;
    if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
      const xj = ring.x[j] as number;
      crossings.push(xj + ((y - y1) * ((ring.x[i] as number) - xj)) / (y2 - y1));
    }
  }
}

function lowerBound(sorted: ArrayLike<number>, value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] as number) < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Sets the cells of a grid outside the polygons to NaN, row by row between pairs of crossings with all rings.
 * @param values - The values, rows from the first Y, each with one value per column.
 * @param columns - The X of the cell centers, rising.
 * @param rows - The Y of the cell centers.
 */
export function maskByPolygons(
  values: Float32Array,
  columns: ArrayLike<number>,
  rows: ArrayLike<number>,
  polygons: readonly Polygon[],
): void {
  const crossings: number[] = [];
  const inside = new Uint8Array(columns.length);
  for (let row = 0; row < rows.length; row++) {
    const y = rows[row] as number;
    crossings.length = 0;
    for (const polygon of polygons) {
      addCrossings(polygon.outer, y, crossings);
      for (const hole of polygon.holes) {
        addCrossings(hole, y, crossings);
      }
    }
    crossings.sort((a, b) => a - b);
    inside.fill(0);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const end = crossings[k + 1] as number;
      for (
        let column = lowerBound(columns, crossings[k] as number);
        column < columns.length && (columns[column] as number) <= end;
        column++
      ) {
        inside[column] = inside[column] === 1 ? 0 : 1;
      }
    }
    const offset = row * columns.length;
    for (let column = 0; column < columns.length; column++) {
      if (inside[column] === 0) {
        values[offset + column] = Number.NaN;
      }
    }
  }
}
