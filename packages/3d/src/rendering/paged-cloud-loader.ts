// Shows a cloud from pages far larger than the GPU, as PagedCloudLoader of the .NET version: a sample of every page
// stays on the GPU, so the whole cloud is in view at once; the pages a view needs finer come into slots of a cache on
// the GPU, the ones longest unused leave first. Pages are read from their file a few at a time while frames go on.
import { CloudSelection, type CloudLeaves } from '../scene/cloud-tree';
import { Point3D, type Matrix3D } from '../scene/matrix';
import { pageSize, type CloudPages } from '../files/cloud-pages';
import type { PointCloud3D } from '../scene/point-cloud';
import { BoxMap, toSizeCode } from '../scene/points';
import type { Scene3D } from '../scene/scene';
import type { CloudBuffer } from './clouds';
import { cloudStride } from './cloud-work';
import type { Renderer3D } from './renderer';

/** @internal The points of each page that always stay on the GPU. */
export const sampleSize = 64;
const pagesPerPortion = 8;
const spotsFrom = 8_000_000;
const pointsTo = 10_000_000;

/** @internal The slots for whole pages a cloud gets from its memory. */
export function pageSlots(pages: CloudPages, pageMemory: number): number {
  const samples = pages.pageCount * sampleSize * cloudStride;
  const slots = Math.floor((pageMemory - samples) / (pageSize * cloudStride));
  return Math.min(Math.max(slots, 1), Math.max(pages.pageCount, 1));
}

/** @internal Brings the pages of one cloud to the GPU and chooses them for each view. */
export class PagedCloudLoader {
  private readonly selection = new CloudSelection();
  private leaves: CloudLeaves | undefined;
  private boxes = new Float64Array(0);
  private slotOf = new Int32Array(0);
  private pageInSlot = new Int32Array(0);
  private slotUsed = new Float64Array(0);
  private isWanted = new Uint8Array(0);
  private wanted: [number, number][] = [];
  private firsts = new Int32Array(1);
  private counts = new Int32Array(1);
  private buffer: CloudBuffer | undefined;
  private ranges = '';
  private frame = 0;
  private generation = 0;
  private hasSamples = false;
  private isBusy = false;
  private usesSpots = false;
  private map: BoxMap | undefined;
  /** The points of the last picture. */
  drawn = 0;
  /** The pages on the GPU in full. */
  loadedPages = 0;

  constructor(
    private readonly cloud: PointCloud3D,
    private readonly pages: CloudPages,
  ) {}

  /** Starts or follows the way of the pages to the GPU. */
  load(scene: Scene3D, renderer: Renderer3D): void {
    const pages = this.pages;
    if (!pages.isComplete) {
      this.cloud.report(pages.share * 0.9);
      return;
    }
    if (!this.leaves) {
      this.create(renderer);
    }
    const ranges = [scene.xAxis, scene.yAxis, scene.zAxis]
      .map((axis) => `${String(axis.visibleRange.min)}:${String(axis.visibleRange.max)}`)
      .join(' ');
    if (ranges !== this.ranges) {
      // Other ranges place every point anew: the samples and the slots are written again.
      this.ranges = ranges;
      this.generation++;
      this.hasSamples = false;
      this.loadedPages = 0;
      this.slotOf.fill(-1);
      this.pageInSlot.fill(-1);
      this.map = new BoxMap(scene.xAxis, scene.yAxis, scene.zAxis);
      this.measure(this.map);
    }
    if (!this.isBusy) {
      void this.startPortion();
    }
  }

  /** Chooses the points for a view; until its page arrives, the sample of a page stands in for it. */
  select(scene: Scene3D, matrix: Matrix3D, width: number, height: number): void {
    const leaves = this.leaves;
    const buffer = this.buffer;
    if (!leaves || !buffer) {
      return;
    }
    this.frame++;
    let drawCount = 0;
    let total = 0;
    const sampleTotal = leaves.count.length * sampleSize;
    const add = (first: number, count: number): void => {
      // A draw that starts where the one before ends joins it, so a view of the whole cloud takes few draws.
      if (drawCount > 0 && (this.firsts[drawCount - 1] as number) + (this.counts[drawCount - 1] as number) === first) {
        this.counts[drawCount - 1] = (this.counts[drawCount - 1] as number) + count;
        return;
      }
      this.firsts[drawCount] = first;
      this.counts[drawCount] = count;
      drawCount++;
    };
    if (this.hasSamples) {
      this.selection.select(
        leaves,
        leaves.count.length,
        this.boxes,
        matrix,
        width,
        height,
        this.cloud.pointBudget,
        scene.planes,
      );
      if (this.firsts.length < this.selection.drawCount) {
        this.firsts = new Int32Array(this.selection.drawCount);
        this.counts = new Int32Array(this.selection.drawCount);
      }
      this.wanted = [];
      for (let i = 0; i < this.selection.drawCount; i++) {
        const page = this.selection.firsts[i] as number;
        const count = this.selection.counts[i] as number;
        const slot = this.slotOf[page] as number;
        if (slot >= 0) {
          add(sampleTotal + slot * pageSize, count);
          this.slotUsed[slot] = this.frame;
          total += count;
          continue;
        }
        const sample = Math.min(count, sampleSize, leaves.count[page] as number);
        add(page * sampleSize, sample);
        total += sample;
        if (count > sample && this.isWanted[page] === 0) {
          this.want(count, page);
        }
      }
    }
    this.drawn = total;
    this.usesSpots = this.usesSpots ? total < pointsTo : total < spotsFrom;
    buffer.setDraws(this.firsts, this.counts, drawCount, this.usesSpots);
  }

  /** Stops loading: a portion on its way is dropped when it arrives. */
  dispose(): void {
    this.generation++;
  }

  // Keeps the pages that want the most points, largest first; only as many as a portion loads.
  private want(count: number, page: number): void {
    const wanted = this.wanted;
    if (wanted.length === pagesPerPortion && (wanted[wanted.length - 1] as [number, number])[0] >= count) {
      return;
    }
    let at = wanted.length;
    while (at > 0 && (wanted[at - 1] as [number, number])[0] < count) {
      at--;
    }
    wanted.splice(at, 0, [count, page]);
    if (wanted.length > pagesPerPortion) {
      wanted.pop();
    }
  }

  private create(renderer: Renderer3D): void {
    const pages = this.pages;
    const count = pages.pageCount;
    // The place on the GPU of a leaf is its page; the loader finds where the page lies.
    this.leaves = {
      first: Int32Array.from({ length: count }, (_, i) => i),
      count: Int32Array.from({ length: count }, (_, i) => pages.page(i).count),
      gpuFirst: Int32Array.from({ length: count }, (_, i) => i),
      bounds: new Float64Array(count * 6),
    };
    this.boxes = new Float64Array(count * 6);
    this.isWanted = new Uint8Array(count);
    this.slotOf = new Int32Array(count).fill(-1);
    const slots = pageSlots(pages, this.cloud.pageMemory);
    this.pageInSlot = new Int32Array(slots).fill(-1);
    this.slotUsed = new Float64Array(slots);
    this.buffer = renderer.cloudOf(this.cloud, count * sampleSize + slots * pageSize);
  }

  // The boxes of the pages in the space of the scene, for the choice of what is in view.
  private measure(map: BoxMap): void {
    const pages = this.pages;
    for (let i = 0; i < pages.pageCount; i++) {
      const page = pages.page(i);
      const a = map.toBox(this.toData(page.low[0], page.low[1], page.low[2]));
      const b = map.toBox(this.toData(page.high[0], page.high[1], page.high[2]));
      this.boxes.set(
        [
          Math.min(a.x, b.x),
          Math.min(a.y, b.y),
          Math.min(a.z, b.z),
          Math.max(a.x, b.x),
          Math.max(a.y, b.y),
          Math.max(a.z, b.z),
        ],
        i * 6,
      );
    }
  }

  private toData(u: number, v: number, w: number): Point3D {
    const low = this.pages.low;
    const high = this.pages.high;
    return new Point3D(
      low[0] + u * (high[0] - low[0]),
      low[1] + v * (high[1] - low[1]),
      low[2] + w * (high[2] - low[2]),
    );
  }

  // Writes points of a page in the form of the GPU.
  private convert(points: Float32Array, target: Float32Array, bytes: Uint8Array, first: number): void {
    const cloud = this.cloud;
    const map = this.map as BoxMap;
    const code = toSizeCode(cloud.pointSize);
    const colors = cloud.heightColors;
    const low = this.pages.low;
    const high = this.pages.high;
    const count = points.length / 3;
    for (let i = 0; i < count; i++) {
      const u = points[i * 3] as number;
      const v = points[i * 3 + 1] as number;
      const w = points[i * 3 + 2] as number;
      const place = first + i;
      map.write(
        low[0] + u * (high[0] - low[0]),
        low[1] + v * (high[1] - low[1]),
        low[2] + w * (high[2] - low[2]),
        target,
        place * 4,
      );
      const shade = colors ? colors.sample(w) : cloud.color;
      const at = place * cloudStride + 12;
      bytes[at] = shade.r;
      bytes[at + 1] = shade.g;
      bytes[at + 2] = shade.b;
      bytes[at + 3] = code;
    }
  }

  private async startPortion(): Promise<void> {
    const pages = this.pages;
    const buffer = this.buffer;
    if (!buffer) {
      return;
    }
    this.isBusy = true;
    const generation = this.generation;
    try {
      if (!this.hasSamples) {
        const count = pages.pageCount;
        const block = new ArrayBuffer(count * sampleSize * cloudStride);
        const floats = new Float32Array(block);
        const bytes = new Uint8Array(block);
        for (let page = 0; page < count; page++) {
          const points = await pages.points(page, sampleSize);
          if (generation !== this.generation) {
            return;
          }
          this.convert(points, floats, bytes, page * sampleSize);
          if (page % 256 === 255) {
            this.cloud.report(0.9 + (0.1 * page) / count);
          }
        }
        buffer.write(0, block);
        this.hasSamples = true;
        this.cloud.setReady(true);
        this.cloud.report(1);
        return;
      }
      // The pages the last frames wanted most, each into a free slot or the one longest unused.
      const chosen: [number, number][] = [];
      for (const [, page] of this.wanted) {
        if (chosen.length >= pagesPerPortion) {
          break;
        }
        if (this.isWanted[page] === 1 || (this.slotOf[page] as number) >= 0) {
          continue;
        }
        const slot = this.freeSlot();
        if (slot < 0) {
          break;
        }
        const old = this.pageInSlot[slot] as number;
        if (old >= 0) {
          this.slotOf[old] = -1;
          this.loadedPages--;
        }
        this.pageInSlot[slot] = page;
        this.slotUsed[slot] = this.frame;
        this.isWanted[page] = 1;
        chosen.push([page, slot]);
      }
      this.wanted = [];
      const sampleTotal = pages.pageCount * sampleSize;
      for (const [page, slot] of chosen) {
        const points = await pages.points(page, pageSize);
        this.isWanted[page] = 0;
        if (generation !== this.generation) {
          return;
        }
        const block = new ArrayBuffer((points.length / 3) * cloudStride);
        this.convert(points, new Float32Array(block), new Uint8Array(block), 0);
        buffer.write(sampleTotal + slot * pageSize, block);
        this.slotOf[page] = slot;
        this.loadedPages++;
      }
    } finally {
      this.isBusy = false;
      this.cloud.touch();
    }
  }

  // A slot no page of the last frame used: an empty one first, else the one unused longest.
  private freeSlot(): number {
    let best = -1;
    let oldest = Infinity;
    for (let slot = 0; slot < this.pageInSlot.length; slot++) {
      if ((this.pageInSlot[slot] as number) < 0) {
        return slot;
      }
      const used = this.slotUsed[slot] as number;
      if (used < this.frame - 1 && used < oldest) {
        best = slot;
        oldest = used;
      }
    }
    return best;
  }
}
