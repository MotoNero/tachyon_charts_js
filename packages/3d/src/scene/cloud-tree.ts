// The octree of a very large cloud and the choice of points for each view, as CloudTree and CloudSelection of the .NET
// version. Points are sorted along a space-filling curve, so that each part of the octree lies together, and each leaf
// is mixed: any start of a leaf is then an even sample of it, which lets the number of points change without a jump.
import { SeededRandom } from '@tachyon-charts/core';
import type { Matrix3D } from './matrix';

const bits = 8;
const cells = 1 << (3 * bits);
const noCell = 0xffffffff;
const leafSize = 32_768;
const steps = 24;
const leastPoints = 8;
const leastDensity = 1e-7;
const mostDensity = 1e6;

/** @internal The most points of a cloud on the GPU; a larger cloud shows an even sample. */
export const maximumCloudPoints = 130_000_000;

/** @internal The leaves of an octree: for each, its first place in the order, its count and its first place on the GPU. */
export interface CloudLeaves {
  readonly first: Int32Array;
  /** The points of a leaf on the GPU, at most the points it holds. */
  readonly count: Int32Array;
  readonly gpuFirst: Int32Array;
  /** Lower and upper corner of each leaf in the units of the axes: six numbers per leaf. */
  readonly bounds: Float64Array;
}

/** @internal An octree: the numbers of the points in the order of the leaves, and the leaves. */
export interface CloudTree {
  readonly order: Int32Array;
  readonly leaves: CloudLeaves;
  readonly gpuCount: number;
}

function spread(value: number): number {
  let v = value;
  v = (v | (v << 8)) & 0x0f00f;
  v = (v | (v << 4)) & 0x0c30c3;
  return (v | (v << 2)) & 0x249249;
}

function toCell(value: number, low: number, high: number): number {
  return high > low
    ? Math.min(Math.max(Math.trunc(((value - low) / (high - low)) * (1 << bits)), 0), (1 << bits) - 1)
    : 0;
}

/** @internal Builds the octree of a cloud. */
export function buildCloudTree(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  z: ArrayLike<number>,
  maximumPoints = maximumCloudPoints,
): CloudTree {
  const count = x.length;
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const px = x[i] as number;
    const py = y[i] as number;
    const pz = z[i] as number;
    if (Number.isFinite(px + py + pz)) {
      low[0] = Math.min(low[0] as number, px);
      low[1] = Math.min(low[1] as number, py);
      low[2] = Math.min(low[2] as number, pz);
      high[0] = Math.max(high[0] as number, px);
      high[1] = Math.max(high[1] as number, py);
      high[2] = Math.max(high[2] as number, pz);
    }
  }
  const keys = new Uint32Array(count);
  const starts = new Int32Array(cells + 1);
  for (let i = 0; i < count; i++) {
    const px = x[i] as number;
    const py = y[i] as number;
    const pz = z[i] as number;
    if (Number.isFinite(px + py + pz)) {
      const key =
        (spread(toCell(px, low[0] as number, high[0] as number)) |
          (spread(toCell(py, low[1] as number, high[1] as number)) << 1) |
          (spread(toCell(pz, low[2] as number, high[2] as number)) << 2)) >>>
        0;
      keys[i] = key;
      starts[key + 1] = (starts[key + 1] as number) + 1;
    } else {
      keys[i] = noCell;
    }
  }
  for (let i = 1; i < starts.length; i++) {
    starts[i] = (starts[i] as number) + (starts[i - 1] as number);
  }
  const order = new Int32Array(starts[cells] as number);
  const next = starts.slice(0, cells);
  for (let i = 0; i < count; i++) {
    const key = keys[i] as number;
    if (key !== noCell) {
      const at = next[key] as number;
      next[key] = at + 1;
      order[at] = i;
    }
  }
  // Walks down until a part is small enough. A part that is one cell stays whole, even when it is large.
  const firsts: number[] = [];
  const counts: number[] = [];
  const visit = (from: number, to: number): void => {
    const inside = (starts[to] as number) - (starts[from] as number);
    if (inside === 0) {
      return;
    }
    if (inside <= leafSize || to - from === 1) {
      firsts.push(starts[from] as number);
      counts.push(inside);
      return;
    }
    const step = (to - from) / 8;
    for (let child = 0; child < 8; child++) {
      visit(from + child * step, from + (child + 1) * step);
    }
  };
  visit(0, cells);
  const leafCount = firsts.length;
  const leaves: CloudLeaves = {
    first: Int32Array.from(firsts),
    count: Int32Array.from(counts),
    gpuFirst: new Int32Array(leafCount),
    bounds: new Float64Array(leafCount * 6),
  };
  for (let index = 0; index < leafCount; index++) {
    const first = leaves.first[index] as number;
    const inside = leaves.count[index] as number;
    new SeededRandom(index).shuffle(order.subarray(first, first + inside));
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let place = first; place < first + inside; place++) {
      const point = order[place] as number;
      const px = x[point] as number;
      const py = y[point] as number;
      const pz = z[point] as number;
      b[0] = Math.min(b[0] as number, px);
      b[1] = Math.min(b[1] as number, py);
      b[2] = Math.min(b[2] as number, pz);
      b[3] = Math.max(b[3] as number, px);
      b[4] = Math.max(b[4] as number, py);
      b[5] = Math.max(b[5] as number, pz);
    }
    leaves.bounds.set(b, index * 6);
  }
  const share = Math.min(1, maximumPoints / Math.max(order.length, 1));
  let place = 0;
  for (let i = 0; i < leafCount; i++) {
    leaves.gpuFirst[i] = place;
    leaves.count[i] = Math.ceil((leaves.count[i] as number) * share);
    place += leaves.count[i] as number;
  }
  return { order, leaves, gpuCount: place };
}

/** @internal A plane as the choice reads it: its normal, its offset and whether it hides. */
export interface CloudPlane {
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
  readonly offset: number;
  readonly hides: boolean;
}

function isCut(boxes: Float64Array, at: number, planes: readonly CloudPlane[]): boolean {
  for (const plane of planes) {
    const n = plane.normal;
    const fx = n.x > 0 ? (boxes[at + 3] as number) : (boxes[at] as number);
    const fy = n.y > 0 ? (boxes[at + 4] as number) : (boxes[at + 1] as number);
    const fz = n.z > 0 ? (boxes[at + 5] as number) : (boxes[at + 2] as number);
    if (plane.hides && fx * n.x + fy * n.y + fz * n.z < plane.offset) {
      return true;
    }
  }
  return false;
}

function share(count: number, area: number, density: number): number {
  return Math.trunc(Math.min(count, leastPoints + density * area));
}

/** @internal Chooses how many points of each leaf a frame draws, in arrays it keeps from frame to frame. */
export class CloudSelection {
  private areas = new Float32Array(0);
  private indices = new Int32Array(0);
  /** The first place of each run to draw. */
  firsts = new Int32Array(0);
  /** The points of each run to draw. */
  counts = new Int32Array(0);
  /** The number of runs. */
  drawCount = 0;
  /** The points in all runs. */
  total = 0;

  /**
   * Shares the budget out by the area of the leaves on the screen: all get the same density, and a leaf that holds
   * fewer points gives its share to the others. The result only depends on the view, so it stays at rest.
   * @param boxes - Lower and upper corner of each leaf in the box, six numbers per leaf.
   */
  select(
    leaves: CloudLeaves,
    leafCount: number,
    boxes: Float64Array,
    matrix: Matrix3D,
    width: number,
    height: number,
    budget: number,
    planes: readonly CloudPlane[],
  ): void {
    if (this.areas.length < leafCount) {
      this.areas = new Float32Array(leafCount);
      this.indices = new Int32Array(leafCount);
      this.firsts = new Int32Array(leafCount);
      this.counts = new Int32Array(leafCount);
    }
    let visible = 0;
    for (let i = 0; i < leafCount; i++) {
      const area = isCut(boxes, i * 6, planes) ? 0 : measureArea(boxes, i * 6, matrix, width, height);
      if (area > 0) {
        this.areas[visible] = area;
        this.indices[visible] = i;
        visible++;
      }
    }
    let low = leastDensity;
    let high = mostDensity;
    for (let step = 0; step < steps; step++) {
      // In equal ratios, as a density can lie anywhere between a point per screen and thousands per pixel.
      const middle = Math.sqrt(low * high);
      let total = 0;
      for (let i = 0; i < visible; i++) {
        total += share(leaves.count[this.indices[i] as number] as number, this.areas[i] as number, middle);
      }
      if (total > budget) {
        high = middle;
      } else {
        low = middle;
      }
    }
    this.drawCount = 0;
    this.total = 0;
    for (let i = 0; i < visible; i++) {
      const leaf = this.indices[i] as number;
      const count = share(leaves.count[leaf] as number, this.areas[i] as number, low);
      this.firsts[this.drawCount] = leaves.gpuFirst[leaf] as number;
      this.counts[this.drawCount] = count;
      this.drawCount++;
      this.total += count;
    }
  }
}

function measureArea(boxes: Float64Array, at: number, matrix: Matrix3D, width: number, height: number): number {
  let left = Infinity;
  let right = -Infinity;
  let bottom = Infinity;
  let top = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const x = (corner & 1) === 0 ? (boxes[at] as number) : (boxes[at + 3] as number);
    const y = (corner & 2) === 0 ? (boxes[at + 1] as number) : (boxes[at + 4] as number);
    const z = (corner & 4) === 0 ? (boxes[at + 2] as number) : (boxes[at + 5] as number);
    const w = matrix.at(3, 0) * x + matrix.at(3, 1) * y + matrix.at(3, 2) * z + matrix.at(3, 3);
    // A corner behind the eye can land anywhere, so the leaf counts as the whole picture.
    if (w <= 0) {
      return width * height;
    }
    const px = (matrix.at(0, 0) * x + matrix.at(0, 1) * y + matrix.at(0, 2) * z + matrix.at(0, 3)) / w;
    const py = (matrix.at(1, 0) * x + matrix.at(1, 1) * y + matrix.at(1, 2) * z + matrix.at(1, 3)) / w;
    left = Math.min(left, px);
    right = Math.max(right, px);
    bottom = Math.min(bottom, py);
    top = Math.max(top, py);
  }
  const w = Math.min(right, 1) - Math.max(left, -1);
  const h = Math.min(top, 1) - Math.max(bottom, -1);
  return w <= 0 || h <= 0 ? 0 : Math.max(Math.fround((w * h * width * height) / 4), 1);
}
