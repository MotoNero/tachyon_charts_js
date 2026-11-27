// Cuts areas of a map into triangles, as GeoTriangulator of the .NET version: ear cutting on a linked ring, holes joined
// by bridges (Eberly), and a grid of the corners, so that countries with many thousand corners cut quickly.

/** An area cut into triangles: its corners (outer ring, then holes), the triangles and the corners of each ring. */
export interface GeoTriangles {
  /** The X of the corners: the outer ring, then each hole. */
  readonly x: Float64Array;
  /** The Y of the corners. */
  readonly y: Float64Array;
  /** Three corners per triangle. */
  readonly triangles: Int32Array;
  /** The number of corners of each ring, the outer one first. */
  readonly rings: Int32Array;
}

interface CornerNode {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  prev: CornerNode;
  next: CornerNode;
  isRemoved: boolean;
}

function node(index: number, x: number, y: number): CornerNode {
  const created = { index, x, y, isRemoved: false } as CornerNode;
  created.prev = created;
  created.next = created;
  return created;
}

/** @internal Cuts an outer ring with its holes into triangles. */
export function triangulateArea(
  outer: { readonly x: ArrayLike<number>; readonly y: ArrayLike<number> },
  holes: readonly { readonly x: ArrayLike<number>; readonly y: ArrayLike<number> }[],
): GeoTriangles {
  const xs: number[] = [];
  const ys: number[] = [];
  const start = addRing(xs, ys, outer.x, outer.y, true);
  if (!start) {
    return { x: new Float64Array(0), y: new Float64Array(0), triangles: new Int32Array(0), rings: new Int32Array(0) };
  }
  const rings = [xs.length];
  // The holes from the one reaching farthest east, each joined by a bridge to the ring so far.
  const holeStarts: CornerNode[] = [];
  for (const hole of holes) {
    const before = xs.length;
    const first = addRing(xs, ys, hole.x, hole.y, false);
    if (first) {
      holeStarts.push(rightmost(first));
      rings.push(xs.length - before);
    }
  }
  holeStarts.sort((a, b) => b.x - a.x);
  for (const hole of holeStarts) {
    bridge(start, hole);
  }
  const triangles: number[] = [];
  cut(start, triangles);
  return {
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    triangles: Int32Array.from(triangles),
    rings: Int32Array.from(rings),
  };
}

// A ring as a linked list, turned positively (counterclockwise) for an outer ring and negatively for a hole.
function addRing(
  xs: number[],
  ys: number[],
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  positive: boolean,
): CornerNode | undefined {
  let count = Math.min(x.length, y.length);
  if (count > 1 && x[0] === x[count - 1] && y[0] === y[count - 1]) {
    count--;
  }
  if (count < 3) {
    return undefined;
  }
  let area = 0;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    area += ((x[j] as number) - (x[i] as number)) * ((y[j] as number) + (y[i] as number));
  }
  // The sum is positive for a counterclockwise ring.
  const reverse = area > 0 !== positive;
  let first: CornerNode | undefined;
  let last: CornerNode | undefined;
  for (let k = 0; k < count; k++) {
    const i = reverse ? count - 1 - k : k;
    const created = node(xs.length, x[i] as number, y[i] as number);
    xs.push(created.x);
    ys.push(created.y);
    if (last) {
      last.next = created;
      created.prev = last;
    } else {
      first = created;
    }
    last = created;
  }
  const head = first as CornerNode;
  const tail = last as CornerNode;
  tail.next = head;
  head.prev = tail;
  return head;
}

function rightmost(start: CornerNode): CornerNode {
  let best = start;
  let current = start.next;
  while (current !== start) {
    if (current.x > best.x || (current.x === best.x && current.y < best.y)) {
      best = current;
    }
    current = current.next;
  }
  return best;
}

// Eberly: a ray from the hole east meets an edge; the bridge goes to the end of that edge, or to the corner within the
// triangle of hole, meeting point and edge end that lies at the smallest angle.
function bridge(outer: CornerNode, hole: CornerNode): void {
  const hit = rayHit(outer, hole.x, hole.y);
  if (!hit) {
    return;
  }
  const target = visible(outer, hit.edge, hole.x, hole.y, hit.x);
  // Two copies of each end close the bridge: target → hole → around the hole → hole' → target' → on.
  const targetCopy = node(target.index, target.x, target.y);
  const holeCopy = node(hole.index, hole.x, hole.y);
  const afterTarget = target.next;
  const beforeHole = hole.prev;
  target.next = hole;
  hole.prev = target;
  beforeHole.next = holeCopy;
  holeCopy.prev = beforeHole;
  holeCopy.next = targetCopy;
  targetCopy.prev = holeCopy;
  targetCopy.next = afterTarget;
  afterTarget.prev = targetCopy;
}

// The edge the ray from the hole east meets first, and its end further east.
function rayHit(outer: CornerNode, hx: number, hy: number): { edge: CornerNode; x: number } | undefined {
  let edge: CornerNode | undefined;
  let nearest = Number.POSITIVE_INFINITY;
  let current = outer;
  do {
    const next = current.next;
    const crosses = (current.y <= hy && next.y >= hy) || (next.y <= hy && current.y >= hy);
    if (crosses && next.y !== current.y) {
      const x = current.x + ((hy - current.y) * (next.x - current.x)) / (next.y - current.y);
      if (x >= hx && x < nearest) {
        nearest = x;
        edge = current.x > next.x ? current : next;
      }
    }
    current = next;
  } while (current !== outer);
  return edge ? { edge, x: nearest } : undefined;
}

// Corners inside the triangle could block the bridge: the one at the smallest angle to the ray is visible.
function visible(outer: CornerNode, edge: CornerNode, hx: number, hy: number, mx: number): CornerNode {
  let target = edge;
  let smallest = Number.POSITIVE_INFINITY;
  let current = outer;
  do {
    if (current !== edge && current.x >= hx && inTriangle(hx, hy, mx, hy, edge.x, edge.y, current.x, current.y)) {
      const angle = Math.abs(current.y - hy) / Math.max(current.x - hx, 1e-300);
      if (angle < smallest || (angle === smallest && current.x > target.x)) {
        smallest = angle;
        target = current;
      }
    }
    current = current.next;
  } while (current !== outer);
  return target;
}

// Cuts ears along the ring; a grid over the corners finds those that could lie inside an ear.
function cut(start: CornerNode, triangles: number[]): void {
  const all: CornerNode[] = [];
  let current = start;
  do {
    all.push(current);
    current = current.next;
  } while (current !== start);
  const grid = new CornerGrid(all);
  let left = all.length;
  let stall = 0;
  current = start;
  while (left > 3) {
    const prev = current.prev;
    const next = current.next;
    if (isEar(prev, current, next, grid) || stall > left) {
      triangles.push(prev.index, current.index, next.index);
      prev.next = next;
      next.prev = prev;
      current.isRemoved = true;
      left--;
      stall = 0;
      // Back one, as the corner before may have become an ear.
      current = prev;
      continue;
    }
    current = next;
    stall++;
  }
  if (left === 3) {
    triangles.push(current.prev.index, current.index, current.next.index);
  }
}

function isEar(a: CornerNode, b: CornerNode, c: CornerNode, grid: CornerGrid): boolean {
  // Convex: the corner turns left on a counterclockwise ring.
  if (cross(a, b, c) <= 0) {
    return false;
  }
  const found = grid.within(
    Math.min(a.x, b.x, c.x),
    Math.min(a.y, b.y, c.y),
    Math.max(a.x, b.x, c.x),
    Math.max(a.y, b.y, c.y),
  );
  for (const other of found) {
    if (
      other.isRemoved ||
      other === a ||
      other === b ||
      other === c ||
      (other.x === a.x && other.y === a.y) ||
      (other.x === b.x && other.y === b.y) ||
      (other.x === c.x && other.y === c.y)
    ) {
      continue;
    }
    // Only a corner that turns right (a reflex one) can lie inside an ear.
    if (cross(other.prev, other, other.next) <= 0 && inTriangle(a.x, a.y, b.x, b.y, c.x, c.y, other.x, other.y)) {
      return false;
    }
  }
  return true;
}

function cross(a: CornerNode, b: CornerNode, c: CornerNode): number {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

function inTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  const first = (cx - px) * (ay - py) - (ax - px) * (cy - py);
  const second = (ax - px) * (by - py) - (bx - px) * (ay - py);
  const third = (bx - px) * (cy - py) - (cx - px) * (by - py);
  return (first >= 0 && second >= 0 && third >= 0) || (first <= 0 && second <= 0 && third <= 0);
}

// A grid of about one corner per cell over the box of the ring.
class CornerGrid {
  private readonly cells: (CornerNode[] | undefined)[];
  private readonly side: number;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cellWidth: number;
  private readonly cellHeight: number;
  private readonly found: CornerNode[] = [];

  constructor(nodes: readonly CornerNode[]) {
    this.side = Math.min(Math.max(Math.trunc(Math.sqrt(nodes.length)), 1), 1024);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const each of nodes) {
      minX = Math.min(minX, each.x);
      minY = Math.min(minY, each.y);
      maxX = Math.max(maxX, each.x);
      maxY = Math.max(maxY, each.y);
    }
    this.minX = minX;
    this.minY = minY;
    this.cellWidth = Math.max((maxX - minX) / this.side, 1e-12);
    this.cellHeight = Math.max((maxY - minY) / this.side, 1e-12);
    this.cells = new Array<CornerNode[] | undefined>(this.side * this.side);
    for (const each of nodes) {
      const at = this.row(each.y) * this.side + this.column(each.x);
      (this.cells[at] ??= []).push(each);
    }
  }

  within(minX: number, minY: number, maxX: number, maxY: number): readonly CornerNode[] {
    this.found.length = 0;
    const x0 = this.column(minX);
    const y0 = this.row(minY);
    const x1 = this.column(maxX);
    const y1 = this.row(maxY);
    for (let row = y0; row <= y1; row++) {
      for (let column = x0; column <= x1; column++) {
        const cell = this.cells[row * this.side + column];
        if (cell) {
          for (const each of cell) {
            this.found.push(each);
          }
        }
      }
    }
    return this.found;
  }

  private column(x: number): number {
    return Math.min(Math.max(Math.trunc((x - this.minX) / this.cellWidth), 0), this.side - 1);
  }

  private row(y: number): number {
    return Math.min(Math.max(Math.trunc((y - this.minY) / this.cellHeight), 0), this.side - 1);
  }
}
