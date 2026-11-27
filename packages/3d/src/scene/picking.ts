// What lies under the pointer, found on the CPU so that a frame never waits for the GPU, as Ray3D, PickReach,
// HeightGrid and MeshTree of the .NET version.
import { Point3D } from './matrix';
import type { GridPlace } from './bars';
import type { Ray3D } from './camera';

const tiny = 1e-12;

/** What lies under the pointer or at a marker. */
export interface Pick3D {
  /** The place in units of the axes. */
  readonly position: Point3D;
  /** What was hit: a surface, line, scatter, mesh, pie slice, volume … */
  readonly source: object;
  /** The value at this place, for data with a value beside the three axes. */
  readonly value?: number;
  /** @internal The place in the box. */
  readonly box: Point3D;
}

/** @internal A slice of a pie as the pointer finds it. */
export interface PieSlicePick {
  readonly pie: {
    explodedIndex: number;
    readonly names: readonly string[];
    readonly values: readonly number[];
    share(index: number): number;
  };
  readonly index: number;
}

/** How far from a ray something still counts: the picture of a pixel grows with the distance. */
export interface PickReach {
  /** The reach at the start of the ray. */
  readonly base: number;
  /** How much it grows per unit of distance. */
  readonly growth: number;
}

/** Finds what lies on a ray through the box of a scene. */
export interface Pick3DFinder {
  /** The nearest thing on the ray within the reach, or undefined. */
  find(ray: Ray3D, reach: PickReach): Pick3D | undefined;
}

/** @internal The number of pixels the reach stands for. */
export const pickPixels = 6;

/** @internal The reach at a distance along the ray. */
export function reachAt(reach: PickReach, distance: number): number {
  return reach.base + reach.growth * Math.max(distance, 0);
}

/** @internal A point of a ray. */
export function rayAt(ray: Ray3D, distance: number): Point3D {
  return ray.start.plus(ray.direction.times(distance));
}

/** @internal Limits a way along one axis to a range; whether something is left. */
export function limit1(start: number, direction: number, low: number, high: number, span: [number, number]): boolean {
  if (Math.abs(direction) < tiny) {
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

/** @internal Limits a ray to a box from low to high. */
export function limitToBox(ray: Ray3D, low: Point3D, high: Point3D, span: [number, number]): boolean {
  return (
    limit1(ray.start.x, ray.direction.x, low.x, high.x, span) &&
    limit1(ray.start.y, ray.direction.y, low.y, high.y, span) &&
    limit1(ray.start.z, ray.direction.z, low.z, high.z, span)
  );
}

/** @internal Limits a ray to the side of a plane that stays. */
export function limitToPlane(
  ray: Ray3D,
  plane: { readonly normal: Point3D; readonly offset: number },
  span: [number, number],
): boolean {
  const height = Point3D.dot(ray.start, plane.normal) - plane.offset;
  const climb = Point3D.dot(ray.direction, plane.normal);
  if (Math.abs(climb) < tiny) {
    return height >= 0;
  }
  const crossing = -height / climb;
  if (climb > 0) {
    span[0] = Math.max(span[0], crossing);
  } else {
    span[1] = Math.min(span[1], crossing);
  }
  return span[0] <= span[1];
}

/** @internal Meets a triangle, seen from both sides: the distance and the place on it, or undefined. */
export function hitTriangle(
  ray: Ray3D,
  a: Point3D,
  b: Point3D,
  c: Point3D,
): { distance: number; u: number; v: number } | undefined {
  const first = b.minus(a);
  const second = c.minus(a);
  const side = Point3D.cross(ray.direction, second);
  const area = Point3D.dot(first, side);
  if (Math.abs(area) < tiny) {
    return undefined;
  }
  const inverse = 1 / area;
  const offset = ray.start.minus(a);
  const u = Point3D.dot(offset, side) * inverse;
  if (u < 0 || u > 1) {
    return undefined;
  }
  const turned = Point3D.cross(offset, first);
  const v = Point3D.dot(ray.direction, turned) * inverse;
  if (v < 0 || u + v > 1) {
    return undefined;
  }
  const distance = Point3D.dot(second, turned) * inverse;
  return distance >= 0 ? { distance, u, v } : undefined;
}

/** @internal The distance between a ray and a line piece, with the place on the ray. */
export function pieceDistance(ray: Ray3D, a: Point3D, b: Point3D): { distance: number; along: number; share: number } {
  const piece = b.minus(a);
  const offset = ray.start.minus(a);
  const length = Point3D.dot(piece, piece);
  const turn = Point3D.dot(piece, ray.direction);
  const side = Point3D.dot(ray.direction, offset);
  const reach = Point3D.dot(piece, offset);
  const denominator = length - turn * turn;
  const share = denominator > 1e-18 ? Math.min(Math.max((reach - side * turn) / denominator, 0), 1) : 0;
  const along = share * turn - side;
  return { distance: a.plus(piece.times(share)).minus(rayAt(ray, along)).length, along, share };
}

/** @internal The point of a raster nearest to a place of the box. */
export function nearestNode(place: GridPlace, point: Point3D): [number, number] {
  return [
    Math.min(Math.max(Math.round((point.x - place.left) / place.stepX), 0), place.columns - 1),
    Math.min(Math.max(Math.round((point.y - place.front) / place.stepY), 0), place.rows - 1),
  ];
}

function crossing(start: number, direction: number, cell: number): number {
  return direction === 0 ? Infinity : (cell + (direction > 0 ? 1 : 0) - start) / direction;
}

/**
 * @internal Follows a ray from cell to cell of a raster and asks each cell for a hit. It crosses at most columns + rows
 * cells, so even 4096 × 4096 stays far below a millisecond without any preparation.
 * @returns The distance and the cell of the first hit, or undefined.
 */
export function findInGrid(
  ray: Ray3D,
  place: GridPlace,
  near: number,
  far: number,
  hit: (i: number, j: number, from: number, to: number) => number | undefined,
): { distance: number; column: number; row: number } | undefined {
  if (place.columns < 2 || place.rows < 2) {
    return undefined;
  }
  const startX = (ray.start.x - place.left) / place.stepX;
  const startY = (ray.start.y - place.front) / place.stepY;
  const directionX = ray.direction.x / place.stepX;
  const directionY = ray.direction.y / place.stepY;
  const span: [number, number] = [near, far];
  if (!limit1(startX, directionX, 0, place.columns - 1, span) || !limit1(startY, directionY, 0, place.rows - 1, span)) {
    return undefined;
  }
  const [from, to] = span;
  let i = Math.min(Math.max(Math.floor(startX + directionX * from), 0), place.columns - 2);
  let j = Math.min(Math.max(Math.floor(startY + directionY * from), 0), place.rows - 2);
  const stepI = Math.sign(directionX);
  const stepJ = Math.sign(directionY);
  let nextI = crossing(startX, directionX, i);
  let nextJ = crossing(startY, directionY, j);
  const deltaI = Math.abs(1 / directionX);
  const deltaJ = Math.abs(1 / directionY);
  while (i >= 0 && j >= 0 && i < place.columns - 1 && j < place.rows - 1) {
    const distance = hit(i, j, from, to);
    if (distance !== undefined) {
      return { distance, column: i, row: j };
    }
    if (Math.min(nextI, nextJ) > to) {
      return undefined;
    }
    if (nextI < nextJ) {
      i += stepI;
      nextI += deltaI;
    } else {
      j += stepJ;
      nextJ += deltaJ;
    }
  }
  return undefined;
}

/** @internal The first hit on the two triangles between four heights of a raster cell, or undefined. */
export function hitHeights(
  ray: Ray3D,
  place: GridPlace,
  height: (column: number, row: number) => number,
  i: number,
  j: number,
  from: number,
  to: number,
): number | undefined {
  const h00 = height(i, j);
  const h10 = height(i + 1, j);
  const h01 = height(i, j + 1);
  const h11 = height(i + 1, j + 1);
  if (Number.isNaN(h00 + h10 + h01 + h11)) {
    return undefined;
  }
  const x0 = place.left + i * place.stepX;
  const y0 = place.front + j * place.stepY;
  const x1 = x0 + place.stepX;
  const y1 = y0 + place.stepY;
  const a = new Point3D(x0, y0, h00);
  const b = new Point3D(x1, y0, h10);
  const c = new Point3D(x1, y1, h11);
  const d = new Point3D(x0, y1, h01);
  let distance = Infinity;
  const first = hitTriangle(ray, a, b, c);
  if (first && first.distance >= from && first.distance <= to) {
    distance = first.distance;
  }
  const second = hitTriangle(ray, a, c, d);
  if (second && second.distance >= from && second.distance <= to) {
    distance = Math.min(distance, second.distance);
  }
  return Number.isFinite(distance) ? distance : undefined;
}

interface TreeNode {
  readonly low: Point3D;
  readonly high: Point3D;
  /** The first triangle of a leaf, or the first child of an inner node. */
  first: number;
  /** The triangles of a leaf; 0 for an inner node. */
  count: number;
}

const leafSize = 8;

/** @internal A tree of boxes around the triangles of a surface, so that a search only visits few of them. */
export class MeshTree {
  private readonly order: Int32Array;
  private readonly nodes: TreeNode[] = [];

  constructor(
    private readonly positions: readonly Point3D[],
    private readonly indices: Uint32Array,
  ) {
    this.order = Int32Array.from({ length: Math.trunc(indices.length / 3) }, (_, i) => i);
    if (this.order.length > 0) {
      this.build(0, this.order.length);
    }
  }

  /** The first hit: its distance, triangle and place on it, or undefined. */
  find(
    ray: Ray3D,
    near: number,
    far: number,
  ): { distance: number; triangle: number; u: number; v: number } | undefined {
    if (this.nodes.length === 0) {
      return undefined;
    }
    let best: { distance: number; triangle: number; u: number; v: number } | undefined;
    let limit = far;
    const stack = [0];
    while (stack.length > 0) {
      const node = this.nodes[stack.pop() as number] as TreeNode;
      if (!limitToBox(ray, node.low, node.high, [near, limit])) {
        continue;
      }
      if (node.count === 0) {
        stack.push(node.first, node.first + 1);
        continue;
      }
      for (let i = node.first; i < node.first + node.count; i++) {
        const triangle = this.order[i] as number;
        const at = triangle * 3;
        const hit = hitTriangle(
          ray,
          this.positions[this.indices[at] as number] as Point3D,
          this.positions[this.indices[at + 1] as number] as Point3D,
          this.positions[this.indices[at + 2] as number] as Point3D,
        );
        if (hit && hit.distance >= near && hit.distance <= limit) {
          limit = hit.distance;
          best = { distance: hit.distance, triangle, u: hit.u, v: hit.v };
        }
      }
    }
    return best;
  }

  /** The numbers of the corners of a triangle. */
  corners(triangle: number): [number, number, number] {
    const at = triangle * 3;
    return [this.indices[at] as number, this.indices[at + 1] as number, this.indices[at + 2] as number];
  }

  private center(triangle: number, axis: number): number {
    const [a, b, c] = this.corners(triangle);
    const get = (point: Point3D): number => (axis === 0 ? point.x : axis === 1 ? point.y : point.z);
    return (
      (get(this.positions[a] as Point3D) + get(this.positions[b] as Point3D) + get(this.positions[c] as Point3D)) / 3
    );
  }

  private build(first: number, count: number): number {
    let lx = Infinity;
    let ly = Infinity;
    let lz = Infinity;
    let hx = -Infinity;
    let hy = -Infinity;
    let hz = -Infinity;
    for (let i = first; i < first + count; i++) {
      for (const corner of this.corners(this.order[i] as number)) {
        const p = this.positions[corner] as Point3D;
        lx = Math.min(lx, p.x);
        ly = Math.min(ly, p.y);
        lz = Math.min(lz, p.z);
        hx = Math.max(hx, p.x);
        hy = Math.max(hy, p.y);
        hz = Math.max(hz, p.z);
      }
    }
    const index = this.nodes.length;
    const node: TreeNode = { low: new Point3D(lx, ly, lz), high: new Point3D(hx, hy, hz), first, count };
    this.nodes.push(node);
    if (count <= leafSize) {
      return index;
    }
    const sx = hx - lx;
    const sy = hy - ly;
    const sz = hz - lz;
    let axis = 2;
    if (sx >= sy && sx >= sz) {
      axis = 0;
    } else if (sy >= sz) {
      axis = 1;
    }
    const middle = axis === 0 ? (lx + hx) / 2 : axis === 1 ? (ly + hy) / 2 : (lz + hz) / 2;
    // Splits at the middle of the space; should all fall to one side, it halves the list, which keeps the depth bounded.
    let left = first;
    let right = first + count - 1;
    while (left <= right) {
      if (this.center(this.order[left] as number, axis) < middle) {
        left++;
      } else {
        const kept = this.order[left] as number;
        this.order[left] = this.order[right] as number;
        this.order[right] = kept;
        right--;
      }
    }
    let below = left - first;
    if (below === 0 || below === count) {
      below = Math.trunc(count / 2);
    }
    const children = this.nodes.length;
    this.nodes.push(node, node);
    this.nodes[children] = this.nodes[this.build(first, below)] as TreeNode;
    this.nodes[children + 1] = this.nodes[this.build(first + below, count - below)] as TreeNode;
    node.first = children;
    node.count = 0;
    return index;
  }
}
