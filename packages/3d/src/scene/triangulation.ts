// Delaunay triangulation by a sweep around the center, as Triangulation of the .NET version: points join the hull in
// order of their distance, and flipped edges restore the Delaunay condition. Sorting makes it O(n log n) in practice.
// The method follows the sweep-hull idea of Sinclair and the half-edge form known as Delaunator.

const missing = -1;

function distance(ax: number, ay: number, bx: number, by: number): number {
  return (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
}

function pseudo(dx: number, dy: number): number {
  const angle = dx / (Math.abs(dx) + Math.abs(dy));
  return (dy > 0 ? 3 - angle : 1 + angle) / 4;
}

class Triangulation {
  readonly triangles: Int32Array;
  edges = 0;
  private readonly halfEdges: Int32Array;
  private readonly next: Int32Array;
  private readonly previous: Int32Array;
  private readonly hullTriangle: Int32Array;
  private readonly hash: Int32Array;
  private readonly stack = new Int32Array(4096);
  private centerX = 0;
  private centerY = 0;
  private hullStart = 0;

  constructor(
    private readonly x: Float64Array,
    private readonly y: Float64Array,
  ) {
    const count = x.length;
    const capacity = Math.max(2 * count - 5, 1) * 3;
    this.triangles = new Int32Array(capacity);
    this.halfEdges = new Int32Array(capacity);
    this.next = new Int32Array(count);
    this.previous = new Int32Array(count);
    this.hullTriangle = new Int32Array(count);
    this.hash = new Int32Array(Math.max(Math.ceil(Math.sqrt(count)), 1)).fill(missing);
  }

  run(): boolean {
    const seed = this.findSeed();
    if (!seed) {
      return false;
    }
    const [i0, i1, i2] = seed;
    const x = this.x;
    const y = this.y;
    [this.centerX, this.centerY] = this.circumcenter(i0, i1, i2);
    const count = x.length;
    const distances = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      distances[i] = distance(x[i] as number, y[i] as number, this.centerX, this.centerY);
    }
    const order = Array.from({ length: count }, (_, i) => i).sort(
      (a, b) => (distances[a] as number) - (distances[b] as number),
    );
    this.hullStart = i0;
    this.next[i0] = i1;
    this.previous[i2] = i1;
    this.next[i1] = i2;
    this.previous[i0] = i2;
    this.next[i2] = i0;
    this.previous[i1] = i0;
    this.hullTriangle[i0] = 0;
    this.hullTriangle[i1] = 1;
    this.hullTriangle[i2] = 2;
    this.hash[this.hashKey(x[i0] as number, y[i0] as number)] = i0;
    this.hash[this.hashKey(x[i1] as number, y[i1] as number)] = i1;
    this.hash[this.hashKey(x[i2] as number, y[i2] as number)] = i2;
    this.addTriangle(i0, i1, i2, missing, missing, missing);
    let lastX = 0;
    let lastY = 0;
    let isFirst = true;
    for (const point of order) {
      const px = x[point] as number;
      const py = y[point] as number;
      if ((!isFirst && px === lastX && py === lastY) || point === i0 || point === i1 || point === i2) {
        continue;
      }
      lastX = px;
      lastY = py;
      isFirst = false;
      this.addPoint(point, px, py);
    }
    return true;
  }

  private orient(a: number, b: number, c: number): number {
    const x = this.x;
    const y = this.y;
    return (
      ((y[b] as number) - (y[a] as number)) * ((x[c] as number) - (x[b] as number)) -
      ((x[b] as number) - (x[a] as number)) * ((y[c] as number) - (y[b] as number))
    );
  }

  private radius(a: number, b: number, c: number): number {
    const [rx, ry] = this.offset(a, b, c);
    return rx * rx + ry * ry;
  }

  private circumcenter(a: number, b: number, c: number): [number, number] {
    const [rx, ry] = this.offset(a, b, c);
    return [(this.x[a] as number) + rx, (this.y[a] as number) + ry];
  }

  private offset(a: number, b: number, c: number): [number, number] {
    const x = this.x;
    const y = this.y;
    const dx = (x[b] as number) - (x[a] as number);
    const dy = (y[b] as number) - (y[a] as number);
    const ex = (x[c] as number) - (x[a] as number);
    const ey = (y[c] as number) - (y[a] as number);
    const bl = dx * dx + dy * dy;
    const cl = ex * ex + ey * ey;
    const d = 0.5 / (dx * ey - dy * ex);
    return [(ey * bl - dy * cl) * d, (dx * cl - ex * bl) * d];
  }

  private inCircle(a: number, b: number, c: number, p: number): boolean {
    const x = this.x;
    const y = this.y;
    const dx = (x[a] as number) - (x[p] as number);
    const dy = (y[a] as number) - (y[p] as number);
    const ex = (x[b] as number) - (x[p] as number);
    const ey = (y[b] as number) - (y[p] as number);
    const fx = (x[c] as number) - (x[p] as number);
    const fy = (y[c] as number) - (y[p] as number);
    const ap = dx * dx + dy * dy;
    const bp = ex * ex + ey * ey;
    const cp = fx * fx + fy * fy;
    return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) < 0;
  }

  private hashKey(x: number, y: number): number {
    return Math.floor(pseudo(x - this.centerX, y - this.centerY) * this.hash.length) % this.hash.length;
  }

  private findSeed(): [number, number, number] | undefined {
    const x = this.x;
    const y = this.y;
    let [lowX, highX, lowY, highY] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i < x.length; i++) {
      lowX = Math.min(lowX, x[i] as number);
      highX = Math.max(highX, x[i] as number);
      lowY = Math.min(lowY, y[i] as number);
      highY = Math.max(highY, y[i] as number);
    }
    const first = this.findClosest((lowX + highX) / 2, (lowY + highY) / 2, missing);
    let second = this.findClosest(x[first] as number, y[first] as number, first);
    let third = second >= 0 ? this.findSmallestCircle(first, second) : missing;
    if (third < 0) {
      return undefined;
    }
    if (this.orient(first, second, third) < 0) {
      [second, third] = [third, second];
    }
    return [first, second, third];
  }

  // Points at the very same place as the search point do not count, except when no point is excluded.
  private findClosest(px: number, py: number, excluded: number): number {
    let best = Infinity;
    let found = missing;
    for (let i = 0; i < this.x.length; i++) {
      const d = distance(px, py, this.x[i] as number, this.y[i] as number);
      if (i !== excluded && d < best && (excluded < 0 || d > 0)) {
        best = d;
        found = i;
      }
    }
    return found;
  }

  private findSmallestCircle(first: number, second: number): number {
    let best = Infinity;
    let found = missing;
    for (let i = 0; i < this.x.length; i++) {
      const radius = i !== first && i !== second ? this.radius(first, second, i) : Infinity;
      if (radius < best) {
        best = radius;
        found = i;
      }
    }
    return found;
  }

  private addPoint(point: number, px: number, py: number): void {
    const start = this.findVisibleStart(px, py);
    if (start < 0) {
      return;
    }
    let edge = start;
    let following: number;
    for (;;) {
      following = this.next[edge] as number;
      if (this.orient(point, edge, following) < 0) {
        break;
      }
      edge = following;
      if (edge === start) {
        return;
      }
    }
    const triangle = this.addTriangle(edge, point, following, missing, missing, this.hullTriangle[edge] as number);
    this.hullTriangle[point] = this.legalize(triangle + 2);
    this.hullTriangle[edge] = triangle;
    following = this.walkForward(point, following);
    if (edge === start) {
      edge = this.walkBackward(point, edge);
    }
    this.hullStart = edge;
    this.previous[point] = edge;
    this.next[edge] = point;
    this.previous[following] = point;
    this.next[point] = following;
    this.hash[this.hashKey(px, py)] = point;
    this.hash[this.hashKey(this.x[edge] as number, this.y[edge] as number)] = edge;
  }

  private findVisibleStart(px: number, py: number): number {
    const key = this.hashKey(px, py);
    let start = 0;
    for (let j = 0; j < this.hash.length; j++) {
      start = this.hash[(key + j) % this.hash.length] as number;
      if (start !== missing && start !== this.next[start]) {
        break;
      }
    }
    return this.previous[start] as number;
  }

  private walkForward(point: number, edge: number): number {
    let current = edge;
    for (;;) {
      const following = this.next[current] as number;
      if (this.orient(point, current, following) >= 0) {
        return current;
      }
      const triangle = this.addTriangle(
        current,
        point,
        following,
        this.hullTriangle[point] as number,
        missing,
        this.hullTriangle[current] as number,
      );
      this.hullTriangle[point] = this.legalize(triangle + 2);
      this.next[current] = current;
      current = following;
    }
  }

  private walkBackward(point: number, edge: number): number {
    let current = edge;
    for (;;) {
      const before = this.previous[current] as number;
      if (this.orient(point, before, current) >= 0) {
        return current;
      }
      const triangle = this.addTriangle(
        before,
        point,
        current,
        missing,
        this.hullTriangle[current] as number,
        this.hullTriangle[before] as number,
      );
      this.legalize(triangle + 2);
      this.hullTriangle[before] = triangle;
      this.next[current] = current;
      current = before;
    }
  }

  private addTriangle(a: number, b: number, c: number, ab: number, bc: number, ca: number): number {
    const at = this.edges;
    this.triangles[at] = a;
    this.triangles[at + 1] = b;
    this.triangles[at + 2] = c;
    this.link(at, ab);
    this.link(at + 1, bc);
    this.link(at + 2, ca);
    this.edges += 3;
    return at;
  }

  private link(a: number, b: number): void {
    this.halfEdges[a] = b;
    if (b !== missing) {
      this.halfEdges[b] = a;
    }
  }

  // Flips edges until the Delaunay condition holds, with a stack of its own because long flip chains would be deep.
  private legalize(startEdge: number): number {
    let depth = 0;
    let a = startEdge;
    for (;;) {
      const flipped = this.flip(a);
      if (flipped !== missing) {
        if (depth < this.stack.length) {
          this.stack[depth++] = flipped;
        }
        continue;
      }
      if (depth === 0) {
        return a - (a % 3) + ((a + 2) % 3);
      }
      a = this.stack[--depth] as number;
    }
  }

  // The edge that still needs a look after a flip, or missing when the edge was fine.
  private flip(a: number): number {
    const b = this.halfEdges[a] as number;
    if (b === missing) {
      return missing;
    }
    const a0 = a - (a % 3);
    const b0 = b - (b % 3);
    const al = a0 + ((a + 1) % 3);
    const ar = a0 + ((a + 2) % 3);
    const bl = b0 + ((b + 2) % 3);
    const t = this.triangles;
    const p0 = t[ar] as number;
    const pr = t[a] as number;
    const pl = t[al] as number;
    const p1 = t[bl] as number;
    if (!this.inCircle(p0, pr, pl, p1)) {
      return missing;
    }
    t[a] = p1;
    t[b] = p0;
    const hbl = this.halfEdges[bl] as number;
    if (hbl === missing) {
      this.repairHull(bl, a);
    }
    this.link(a, hbl);
    this.link(b, this.halfEdges[ar] as number);
    this.link(ar, bl);
    return b0 + ((b + 1) % 3);
  }

  private repairHull(oldEdge: number, newEdge: number): void {
    let edge = this.hullStart;
    do {
      if (this.hullTriangle[edge] === oldEdge) {
        this.hullTriangle[edge] = newEdge;
        return;
      }
      edge = this.previous[edge] as number;
    } while (edge !== this.hullStart);
  }
}

/**
 * @internal Connects points to triangles, three numbers of points per triangle; none for fewer than three points or
 * points on one line.
 * @throws RangeError for lists of different length.
 */
export function triangulate(x: ArrayLike<number>, y: ArrayLike<number>): number[] {
  if (x.length !== y.length) {
    throw new RangeError('Both lists need the same length.');
  }
  if (x.length < 3) {
    return [];
  }
  const triangulation = new Triangulation(Float64Array.from(x), Float64Array.from(y));
  return triangulation.run() ? Array.from(triangulation.triangles.subarray(0, triangulation.edges)) : [];
}
