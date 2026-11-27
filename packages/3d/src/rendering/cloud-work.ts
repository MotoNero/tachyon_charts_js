// What the worker of a large cloud does and what it says, as the portions of CloudLoader of the .NET version: first an
// even sample, then the octree, then leaf by leaf, each portion a finished block for the GPU.
import {
  DoubleRange,
  LinearAxisTransform,
  LogScaling,
  SymLogScaling,
  type Axis,
  type AxisScaling,
} from '@tachyon-charts/core';
import { buildCloudTree, type CloudTree } from '../scene/cloud-tree';
import { BoxMap } from '../scene/points';

/** @internal The bytes of a point on the GPU: place and color with the size code in alpha. */
export const cloudStride = 16;
/** @internal The points the worker writes per portion. */
const pointsPerPortion = 2_000_000;

/** @internal An axis as a worker can rebuild it: its range, direction and scale. */
export interface AxisDescription {
  readonly min: number;
  readonly max: number;
  readonly horizontal: boolean;
  readonly scaling?:
    | { readonly kind: 'log'; readonly base: number; readonly floor: number }
    | { readonly kind: 'symlog'; readonly base: number; readonly linearThreshold: number };
}

/** @internal Describes an axis for a worker. */
export function describeAxis(axis: Axis): AxisDescription {
  const range = axis.visibleRange;
  const scaling = axis.scaling;
  const base = { min: range.min, max: range.max, horizontal: axis.isHorizontal };
  if (scaling instanceof LogScaling) {
    return { ...base, scaling: { kind: 'log', base: scaling.base, floor: scaling.floor } };
  }
  if (scaling instanceof SymLogScaling) {
    return { ...base, scaling: { kind: 'symlog', base: scaling.base, linearThreshold: scaling.linearThreshold } };
  }
  return base;
}

// What BoxMap reads of an axis, rebuilt from its description.
function toAxis(description: AxisDescription): Axis {
  const range = new DoubleRange(description.min, description.max);
  const kind = description.scaling;
  let scaling: AxisScaling | undefined;
  if (kind?.kind === 'log') {
    scaling = new LogScaling(kind.base, kind.floor);
  } else if (kind?.kind === 'symlog') {
    scaling = new SymLogScaling(kind.base, kind.linearThreshold);
  }
  return {
    isHorizontal: description.horizontal,
    createTransform: (start: number, length: number) =>
      description.horizontal
        ? new LinearAxisTransform(range, start, start + length, scaling)
        : new LinearAxisTransform(range, start + length, start, scaling),
  } as unknown as Axis;
}

/** @internal The order to the worker: the points and how to write them. */
export interface CloudJob {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly colors: Uint8Array | undefined;
  /** The color of a cloud without colors, red, green, blue. */
  readonly color: readonly [number, number, number];
  readonly sizeCode: number;
  readonly axes: readonly [AxisDescription, AxisDescription, AxisDescription];
  /** The points of the even sample at the front of the buffer. */
  readonly preview: number;
}

/** @internal What the worker says. */
export type CloudMessage =
  | { readonly kind: 'portion'; readonly place: number; readonly bytes: ArrayBuffer; readonly nextLeaf: number }
  | {
      readonly kind: 'tree';
      readonly first: Int32Array;
      readonly count: Int32Array;
      readonly gpuFirst: Int32Array;
      readonly bounds: Float64Array;
      readonly gpuCount: number;
      readonly order: Int32Array;
    }
  | { readonly kind: 'failed'; readonly message: string };

/** @internal Writes points of a cloud in the form of the GPU. */
export class CloudWriter {
  private readonly map: BoxMap;

  constructor(private readonly job: CloudJob) {
    this.map = new BoxMap(toAxis(job.axes[0]), toAxis(job.axes[1]), toAxis(job.axes[2]));
  }

  /** Writes the point with a number at a place of a block. */
  write(point: number, floats: Float32Array, bytes: Uint8Array, place: number): void {
    const job = this.job;
    this.map.write(job.x[point] as number, job.y[point] as number, job.z[point] as number, floats, place * 4);
    const colors = job.colors;
    const at = place * cloudStride + 12;
    if (colors) {
      bytes[at] = colors[point * 4] as number;
      bytes[at + 1] = colors[point * 4 + 1] as number;
      bytes[at + 2] = colors[point * 4 + 2] as number;
    } else {
      bytes[at] = job.color[0];
      bytes[at + 1] = job.color[1];
      bytes[at + 2] = job.color[2];
    }
    bytes[at + 3] = job.sizeCode;
  }

  /** The even sample: every n-th point, n the count divided by the size of the sample. */
  writePreview(): ArrayBuffer {
    const count = this.job.preview;
    const block = new ArrayBuffer(count * cloudStride);
    const floats = new Float32Array(block);
    const bytes = new Uint8Array(block);
    const step = Math.trunc(this.job.x.length / Math.max(count, 1));
    for (let i = 0; i < count; i++) {
      this.write(i * step, floats, bytes, i);
    }
    return block;
  }

  /** The leaves from `first` on, as many as fit a portion; they lie side by side on the GPU. */
  writeLeaves(tree: CloudTree, first: number): { place: number; bytes: ArrayBuffer; nextLeaf: number } {
    const leaves = tree.leaves;
    let last = first;
    let count = 0;
    while (last < leaves.count.length && count < pointsPerPortion) {
      count += leaves.count[last++] as number;
    }
    const block = new ArrayBuffer(count * cloudStride);
    const floats = new Float32Array(block);
    const bytes = new Uint8Array(block);
    const start = leaves.gpuFirst[first] as number;
    for (let index = first; index < last; index++) {
      const leafFirst = leaves.first[index] as number;
      const gpuFirst = (leaves.gpuFirst[index] as number) - start;
      const inside = leaves.count[index] as number;
      for (let i = 0; i < inside; i++) {
        this.write(tree.order[leafFirst + i] as number, floats, bytes, gpuFirst + i);
      }
    }
    return { place: this.job.preview + start, bytes: block, nextLeaf: last };
  }
}

/** @internal Runs a job: the sample, the tree, then the leaves, each said as soon as it is done. */
export function runCloudJob(job: CloudJob, say: (message: CloudMessage, transfer: Transferable[]) => void): void {
  const writer = new CloudWriter(job);
  const preview = writer.writePreview();
  say({ kind: 'portion', place: 0, bytes: preview, nextLeaf: 0 }, [preview]);
  const tree = buildCloudTree(job.x, job.y, job.z);
  const leaves = tree.leaves;
  say(
    {
      kind: 'tree',
      first: leaves.first,
      count: leaves.count,
      gpuFirst: leaves.gpuFirst,
      bounds: leaves.bounds,
      gpuCount: tree.gpuCount,
      order: tree.order,
    },
    [],
  );
  let next = 0;
  while (next < leaves.count.length) {
    const portion = writer.writeLeaves(tree, next);
    say({ kind: 'portion', place: portion.place, bytes: portion.bytes, nextLeaf: portion.nextLeaf }, [portion.bytes]);
    next = portion.nextLeaf;
  }
}
