// Brings a cloud to the GPU and chooses its points for each view, as CloudLoader of the .NET version. A small cloud goes
// up whole at once; a larger one in portions that a worker prepares, so that no frame waits for millions of conversions:
// first an even sample, then leaf by leaf. The front of the buffer belongs to the sample.
import { CloudSelection, maximumCloudPoints, type CloudLeaves } from '../scene/cloud-tree';
import type { Matrix3D } from '../scene/matrix';
import { PointCloud3D } from '../scene/point-cloud';
import { BoxMap, toSizeCode } from '../scene/points';
import type { Scene3D } from '../scene/scene';
import type { CloudBuffer } from './clouds';
import { CloudWriter, cloudStride, describeAxis, runCloudJob, type CloudJob, type CloudMessage } from './cloud-work';
import type { Renderer3D } from './renderer';
import type { CloudOrder } from './scene-picker';

const spotsFrom = 8_000_000;
const pointsTo = 10_000_000;
const uploadStart = 0.7;

/** @internal Creates the worker of a cloud; tests and pages without workers run the job on the spot. */
export type CloudWorkerFactory = () => Worker | undefined;

function defaultWorker(): Worker | undefined {
  return typeof Worker === 'undefined'
    ? undefined
    : new Worker(new URL('./cloud-worker-entry.js', import.meta.url), { type: 'module' });
}

/** @internal Brings one cloud to the GPU. */
export class CloudLoader {
  private readonly selection = new CloudSelection();
  private firsts = new Int32Array(1);
  private counts = new Int32Array(1);
  private worker: Worker | undefined;
  private buffer: CloudBuffer | undefined;
  private ranges = '';
  private previewCount = 0;
  private nextLeaf = 0;
  private leaves: CloudLeaves | undefined;
  private order: Int32Array | undefined;
  private boxes = new Float64Array(0);
  private usesSpots = false;
  private job = 0;
  /** The number of points in the last picture. */
  drawn = 0;

  constructor(
    private readonly cloud: PointCloud3D,
    private readonly createWorker: CloudWorkerFactory = defaultWorker,
  ) {}

  private get isSmall(): boolean {
    return this.cloud.count <= PointCloud3D.previewLimit;
  }

  private get gpuStart(): number {
    return Math.min(this.cloud.count, PointCloud3D.previewLimit);
  }

  /** Starts or follows the way of the points to the GPU. */
  load(scene: Scene3D, renderer: Renderer3D): void {
    const cloud = this.cloud;
    cloud.start();
    if (!cloud.isLoaded) {
      return;
    }
    const ranges = [scene.xAxis, scene.yAxis, scene.zAxis]
      .map((axis) => `${String(axis.visibleRange.min)}:${String(axis.visibleRange.max)}`)
      .join(' ');
    if (ranges !== this.ranges) {
      this.ranges = ranges;
      this.restart();
    }
    const count = cloud.count;
    this.buffer ??= renderer.cloudOf(cloud, Math.min(count, maximumCloudPoints) + (this.isSmall ? 0 : this.gpuStart));
    if (this.isSmall) {
      if (this.previewCount === 0 && count > 0) {
        const writer = new CloudWriter(this.createJob(scene, count));
        const block = new ArrayBuffer(count * cloudStride);
        const floats = new Float32Array(block);
        const bytes = new Uint8Array(block);
        for (let i = 0; i < count; i++) {
          writer.write(i, floats, bytes, i);
        }
        this.buffer.write(0, block);
        this.previewCount = count;
      }
      cloud.setReady(true);
      return;
    }
    if (this.job === 0) {
      this.startJob(scene);
    }
  }

  /** Chooses the points for a view. As long as leaves are missing, the sample fills in for them. */
  select(scene: Scene3D, matrix: Matrix3D, width: number, height: number): void {
    const buffer = this.buffer;
    if (!buffer) {
      return;
    }
    let budget = this.cloud.pointBudget;
    let drawCount = 0;
    let total = 0;
    const room = 1 + (this.leaves ? this.nextLeaf : 0);
    if (this.firsts.length < room) {
      this.firsts = new Int32Array(room);
      this.counts = new Int32Array(room);
    }
    if (this.previewCount > 0 && (!this.cloud.isReady || this.isSmall)) {
      this.firsts[0] = 0;
      this.counts[0] = this.previewCount;
      drawCount = 1;
      budget -= this.previewCount;
      total = this.previewCount;
    }
    if (this.leaves && this.nextLeaf > 0) {
      const selection = this.selection;
      selection.select(this.leaves, this.nextLeaf, this.boxes, matrix, width, height, budget, scene.planes);
      for (let i = 0; i < selection.drawCount; i++) {
        this.firsts[drawCount] = (selection.firsts[i] as number) + this.gpuStart;
        this.counts[drawCount] = selection.counts[i] as number;
        drawCount++;
      }
      total += selection.total;
    }
    this.drawn = total;
    this.usesSpots = this.usesSpots ? total < pointsTo : total < spotsFrom;
    buffer.setDraws(this.firsts, this.counts, drawCount, this.usesSpots);
  }

  /** @internal The octree as far as its leaves are on the GPU, for the picker; none before the tree stands. */
  get octree(): CloudOrder | undefined {
    return this.leaves && this.order && this.nextLeaf > 0
      ? { leaves: this.leaves, order: this.order, leafCount: this.nextLeaf }
      : undefined;
  }

  /** Stops the worker. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }

  // New ranges move every point in the box, so the points go up again.
  private restart(): void {
    this.dispose();
    this.job = 0;
    this.previewCount = 0;
    this.nextLeaf = 0;
    this.leaves = undefined;
    this.order = undefined;
    this.cloud.setReady(false);
  }

  private createJob(scene: Scene3D, preview: number): CloudJob {
    const cloud = this.cloud;
    return {
      x: cloud.x,
      y: cloud.y,
      z: cloud.z,
      colors: cloud.colors,
      color: [cloud.color.r, cloud.color.g, cloud.color.b],
      sizeCode: toSizeCode(cloud.pointSize),
      axes: [describeAxis(scene.xAxis), describeAxis(scene.yAxis), describeAxis(scene.zAxis)],
      preview,
    };
  }

  private startJob(scene: Scene3D): void {
    const job = ++this.job;
    const order = this.createJob(scene, this.gpuStart);
    const map = new BoxMap(scene.xAxis, scene.yAxis, scene.zAxis);
    const take = (message: CloudMessage): void => {
      if (job === this.job) {
        this.take(message, map);
      }
    };
    const worker = this.createWorker();
    if (!worker) {
      runCloudJob(order, take);
      return;
    }
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<CloudMessage>) => {
      take(event.data);
    };
    worker.postMessage(order);
  }

  private take(message: CloudMessage, map: BoxMap): void {
    const cloud = this.cloud;
    if (message.kind === 'failed') {
      cloud.touch();
      return;
    }
    if (message.kind === 'tree') {
      this.leaves = { first: message.first, count: message.count, gpuFirst: message.gpuFirst, bounds: message.bounds };
      this.order = message.order;
      // The corners of each leaf in the box, ordered low and high, for the choice of each view.
      const leafCount = message.count.length;
      this.boxes = new Float64Array(leafCount * 6);
      const corner = new Float32Array(3);
      for (let i = 0; i < leafCount; i++) {
        const b = message.bounds;
        map.write(b[i * 6] as number, b[i * 6 + 1] as number, b[i * 6 + 2] as number, corner, 0);
        const [ax, ay, az] = corner;
        map.write(b[i * 6 + 3] as number, b[i * 6 + 4] as number, b[i * 6 + 5] as number, corner, 0);
        const [bx, by, bz] = corner;
        this.boxes.set(
          [
            Math.min(ax as number, bx as number),
            Math.min(ay as number, by as number),
            Math.min(az as number, bz as number),
            Math.max(ax as number, bx as number),
            Math.max(ay as number, by as number),
            Math.max(az as number, bz as number),
          ],
          i * 6,
        );
      }
      cloud.report(uploadStart);
      cloud.touch();
      return;
    }
    this.buffer?.write(message.place, message.bytes);
    if (message.place === 0 && message.nextLeaf === 0) {
      this.previewCount = this.gpuStart;
    } else {
      this.nextLeaf = message.nextLeaf;
      const leafCount = this.leaves?.count.length ?? 1;
      cloud.report(uploadStart + ((1 - uploadStart) * this.nextLeaf) / leafCount);
      if (this.nextLeaf >= leafCount) {
        this.dispose();
        cloud.setReady(true);
      }
    }
    cloud.touch();
  }
}
