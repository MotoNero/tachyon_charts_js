// Multi-channel signed distance fields from outlines, as MsdfGenerator of the .NET version, in single precision
// operation by operation. Each channel sees some edges only, and edges meeting at a corner share one channel; the
// median of the channels then keeps corners sharp at any scale.
import type { Contour, Point } from './outlines';

const f = Math.fround;
const red = 1;
const green = 2;
const blue = 4;
const white = red | green | blue;
const cyan = green | blue;
const magenta = red | blue;
const yellow = red | green;
const cornerDotLimit = 0.5;
const tie = f(1e-4);
const far = f(3.4028234663852886e38);

interface Distance {
  true: number;
  pseudo: number;
  orthogonality: number;
}

const farAway: Distance = { true: far, pseudo: far, orthogonality: 0 };

// At a shared end point two edges are equally near; the one facing the point decides.
function closer(a: Distance, b: Distance): Distance {
  if (Math.abs(f(a.true - b.true)) < tie) {
    return b.orthogonality > a.orthogonality ? b : a;
  }
  return b.true < a.true ? b : a;
}

function normalize(x: number, y: number): [number, number] {
  const length = f(Math.sqrt(f(f(x * x) + f(y * y))));
  return [f(x / length), f(y / length)];
}

class ColoredEdge {
  constructor(
    readonly points: Point[],
    readonly color: number,
  ) {}

  measure(px: number, py: number): Distance {
    const points = this.points;
    let bestSquared = far;
    let bestSegment = 0;
    let bestParameter = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i] as Point;
      const end = points[i + 1] as Point;
      const ax = f(end.x - start.x);
      const ay = f(end.y - start.y);
      const lengthSquared = f(f(ax * ax) + f(ay * ay));
      if (lengthSquared === 0) {
        continue;
      }
      const ox = f(px - start.x);
      const oy = f(py - start.y);
      const parameter = f(f(f(ox * ax) + f(oy * ay)) / lengthSquared);
      const clamped = Math.min(Math.max(parameter, 0), 1);
      const nx = f(start.x + f(ax * clamped));
      const ny = f(start.y + f(ay * clamped));
      const dx = f(px - nx);
      const dy = f(py - ny);
      const squared = f(f(dx * dx) + f(dy * dy));
      if (squared < bestSquared) {
        bestSquared = squared;
        bestSegment = i;
        bestParameter = parameter;
      }
    }
    return this.toDistance(px, py, bestSegment, bestParameter, f(Math.sqrt(bestSquared)));
  }

  private toDistance(px: number, py: number, segment: number, parameter: number, distance: number): Distance {
    const start = this.points[segment] as Point;
    const end = this.points[segment + 1] as Point;
    const [dx, dy] = normalize(f(end.x - start.x), f(end.y - start.y));
    const ox = f(px - start.x);
    const oy = f(py - start.y);
    const cross = f(f(dx * oy) - f(dy * ox));
    const sign = cross >= 0 ? 1 : -1;
    const clamped = Math.min(Math.max(parameter, 0), 1);
    const nx = f(start.x + f(f(end.x - start.x) * clamped));
    const ny = f(start.y + f(f(end.y - start.y) * clamped));
    const tx = f(px - nx);
    const ty = f(py - ny);
    const toSquared = f(f(tx * tx) + f(ty * ty));
    const orthogonality = toSquared > 0 ? f(Math.abs(f(f(dx * ty) - f(dy * tx))) / f(Math.sqrt(toSquared))) : 1;
    // Beyond its ends, the edge continues as a straight line. That is what keeps corners sharp.
    const beyondStart = segment === 0 && parameter < 0;
    const beyondEnd = segment === this.points.length - 2 && parameter > 1;
    const pseudo = (beyondStart || beyondEnd) && Math.abs(cross) <= distance ? cross : f(sign * distance);
    return { true: distance, pseudo, orthogonality };
  }
}

function isCorner(before: Point[], after: Point[]): boolean {
  const last = before.at(-1) as Point;
  const previous = before.at(-2) as Point;
  const [ix, iy] = normalize(f(last.x - previous.x), f(last.y - previous.y));
  const first = after[0] as Point;
  const second = after[1] as Point;
  const [ox, oy] = normalize(f(second.x - first.x), f(second.y - first.y));
  return f(f(ix * ox) + f(iy * oy)) < cornerDotLimit;
}

function join(contour: Contour, start: number, count: number): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < count; i++) {
    const curve = contour[(start + i) % contour.length] as Point[];
    points.push(...(i === 0 ? curve : curve.slice(1)));
  }
  return points;
}

// A single corner has no neighbors to alternate with, so its outline splits into three edges.
function addTeardrop(points: Point[], edges: ColoredEdge[]): void {
  const first = Math.floor(points.length / 3);
  const second = Math.floor((2 * points.length) / 3);
  edges.push(new ColoredEdge(points.slice(0, first + 1), cyan));
  edges.push(new ColoredEdge(points.slice(first, second + 1), yellow));
  edges.push(new ColoredEdge(points.slice(second), magenta));
}

function addColoredEdges(contour: Contour, edges: ColoredEdge[]): void {
  const corners: number[] = [];
  for (let i = 0; i < contour.length; i++) {
    if (isCorner(contour[(i + contour.length - 1) % contour.length] as Point[], contour[i] as Point[])) {
      corners.push(i);
    }
  }
  if (corners.length === 0) {
    edges.push(new ColoredEdge(join(contour, 0, contour.length), white));
    return;
  }
  if (corners.length === 1) {
    addTeardrop(join(contour, corners[0] as number, contour.length), edges);
    return;
  }
  for (let i = 0; i < corners.length; i++) {
    const start = corners[i] as number;
    const next = corners[(i + 1) % corners.length] as number;
    const count = ((next - start + contour.length - 1) % contour.length) + 1;
    const color = i % 2 === 1 ? magenta : yellow;
    edges.push(new ColoredEdge(join(contour, start, count), i === 0 ? cyan : color));
  }
}

function signedArea(contours: Contour[]): number {
  let area = 0;
  for (const contour of contours) {
    for (const curve of contour) {
      for (let i = 1; i < curve.length; i++) {
        const a = curve[i - 1] as Point;
        const b = curve[i] as Point;
        area = f(area + f(f(a.x * b.y) - f(b.x * a.y)));
      }
    }
  }
  return area;
}

function encode(distance: number, range: number): number {
  const value = f(f(f(f(distance / f(2 * range)) + 0.5) * 255) + 0.5);
  return Math.trunc(Math.min(Math.max(value, 0), 255));
}

/**
 * Writes the field of the contours into RGBA pixels.
 * @param destination - The pixels; the field starts at `offset` and its rows are `stride` bytes apart.
 */
export function generateMsdf(
  contours: Contour[],
  width: number,
  height: number,
  range: number,
  destination: Uint8Array,
  offset: number,
  stride: number,
): void {
  const edges: ColoredEdge[] = [];
  for (const contour of contours) {
    addColoredEdges(contour, edges);
  }
  const orientation = signedArea(contours) >= 0 ? 1 : -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = farAway;
      let g = farAway;
      let b = farAway;
      const px = f(x + 0.5);
      const py = f(y + 0.5);
      for (const edge of edges) {
        const distance = edge.measure(px, py);
        if (edge.color & red) r = closer(r, distance);
        if (edge.color & green) g = closer(g, distance);
        if (edge.color & blue) b = closer(b, distance);
      }
      const at = offset + y * stride + x * 4;
      destination[at] = encode(f(r.pseudo * orientation), range);
      destination[at + 1] = encode(f(g.pseudo * orientation), range);
      destination[at + 2] = encode(f(b.pseudo * orientation), range);
      destination[at + 3] = 255;
    }
  }
}
