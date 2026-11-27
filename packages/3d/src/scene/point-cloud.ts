// A very large cloud of points, as PointCloud3D of the .NET version.
import type { Colormap, Rgba8 } from '@tachyon-charts/core';
import { CloudPages } from '../files/cloud-pages';

/** The points of a cloud: coordinates and, if wanted, a color per point as red, green, blue and alpha bytes. */
export interface PointCloudArrays {
  /** The first coordinates. */
  readonly x: Float64Array;
  /** The second coordinates. */
  readonly y: Float64Array;
  /** The third coordinates. */
  readonly z: Float64Array;
  /** Four bytes per point; the color of the cloud when left out. */
  readonly colors?: Uint8Array;
}

/** Creates or reads the points of a cloud and tells how far it has come, from 0 to 1. */
export type PointCloudLoad = (report: (share: number) => void) => Promise<PointCloudArrays>;

/** The options of a cloud. */
export interface PointCloud3DOptions {
  /** Whether the values show as labels above their points; labels that would cover others are left out. */
  readonly showsValues?: boolean;
  /** The color of a cloud without colors; a light blue by default. */
  readonly color?: Rgba8;
  /** The number of points per frame; 30 million by default. It stays the same while turning and at rest. */
  readonly pointBudget?: number;
  /** The diameter of the points once so few are in view that single pixels would leave gaps; 2.5 by default. */
  readonly pointSize?: number;
  /** The colors by height of a cloud from pages; the color of the cloud when left out. */
  readonly heightColors?: Colormap;
  /** The most bytes of the GPU a cloud from pages keeps its pages in; 1 GB, about 64 million points, by default. */
  readonly pageMemory?: number;
}

const treeShare = 0.5;
const empty = new Float64Array(0);

/**
 * A very large cloud of points. A cloud of up to a million points shows whole in its first picture. A larger one shows
 * an even sample at once while an octree forms in a worker, and then each frame draws what helps the view: finer points
 * follow, and every point drawn is a real point at its exact place.
 */
export class PointCloud3D {
  /** Whether the values show as labels above their points. */
  readonly showsValues: boolean;
  /** The size up to which a cloud shows whole in its first picture. */
  static readonly previewLimit = 1_000_000;
  /** The color of a cloud without colors. */
  readonly color: Rgba8;
  /** The number of points per frame. */
  readonly pointBudget: number;
  /** The diameter of the points once few are in view. */
  readonly pointSize: number;
  /** The colors by height of a cloud from pages, or undefined for the color of the cloud. */
  readonly heightColors: Colormap | undefined;
  /** The most bytes of the GPU a cloud from pages keeps its pages in. */
  readonly pageMemory: number;
  /** The pages of a cloud from a file, or undefined for points in memory. */
  readonly pages: CloudPages | undefined;
  private readonly load: PointCloudLoad | undefined;
  private points: PointCloudArrays | undefined;
  private started = false;
  private share = 0;
  private ready = false;
  private stamp = 0;
  private failure: unknown;

  /**
   * @param source - The points, a function that creates or reads them, so that the page stays free while a large cloud
   * forms, or the pages of a cloud far larger than memory, sorted into a file beside its data; the chart then shows the
   * progress.
   * @param options - Color, budget and size of the points.
   */
  constructor(source: PointCloudArrays | PointCloudLoad | CloudPages, options: PointCloud3DOptions = {}) {
    this.pages = source instanceof CloudPages ? source : undefined;
    if (typeof source === 'function') {
      this.load = source;
    } else {
      this.load = undefined;
      this.points = source instanceof CloudPages ? undefined : source;
    }
    this.color = options.color ?? { r: 90, g: 170, b: 255, a: 255 };
    this.pointBudget = options.pointBudget ?? 30_000_000;
    this.pointSize = options.pointSize ?? 2.5;
    this.heightColors = options.heightColors;
    this.pageMemory = options.pageMemory ?? 2 ** 30;
    this.showsValues = options.showsValues ?? false;
  }

  /** The first coordinates; empty until the points exist. */
  get x(): Float64Array {
    return this.points?.x ?? empty;
  }

  /** The second coordinates. */
  get y(): Float64Array {
    return this.points?.y ?? empty;
  }

  /** The third coordinates. */
  get z(): Float64Array {
    return this.points?.z ?? empty;
  }

  /** The colors, four bytes per point, or undefined for the color of the cloud. */
  get colors(): Uint8Array | undefined {
    return this.points?.colors;
  }

  /** The number of points. */
  get count(): number {
    return this.pages ? this.pages.count : Math.min(this.x.length, this.y.length, this.z.length);
  }

  /** Whether all points have reached the GPU. */
  get isReady(): boolean {
    return this.ready;
  }

  /** How far the cloud has come, from 0 to 1. */
  get progress(): number {
    return this.ready ? 1 : this.share;
  }

  /** Why the points could not be created or read, if they could not. */
  get error(): unknown {
    return this.failure;
  }

  /** Grows as finer points arrive and the progress moves, so that the chart draws again. */
  get version(): number {
    // Pages are built in the background; their progress asks for pictures, so that the chart follows it.
    const pages = this.pages;
    return this.stamp + (pages ? Math.trunc(pages.share * 100) + (pages.isComplete ? 1 : 0) : 0);
  }

  /** @internal Whether the points exist. */
  get isLoaded(): boolean {
    return this.points !== undefined || this.pages !== undefined;
  }

  /** @internal Whether the chart shows how far the cloud has come. A small cloud shows whole at once. */
  get showsProgress(): boolean {
    return (
      !this.ready &&
      this.failure === undefined &&
      this.pages?.error === undefined &&
      (this.pages !== undefined || !this.isLoaded || this.count > PointCloud3D.previewLimit)
    );
  }

  /** @internal Starts creating or reading the points, once. */
  start(): void {
    if (this.started || !this.load) {
      return;
    }
    this.started = true;
    this.load((value) => {
      this.report(Math.min(Math.max(value, 0), 1) * treeShare);
    }).then(
      (points) => {
        this.points = points;
        this.report(treeShare);
        this.touch();
      },
      (error: unknown) => {
        this.failure = error;
        this.touch();
      },
    );
  }

  /** @internal Takes note of the progress, in whole percent. */
  report(progress: number): void {
    if (Math.trunc(progress * 100) !== Math.trunc(this.share * 100)) {
      this.share = progress;
      this.touch();
    }
  }

  /** @internal Marks whether all points are on the GPU. */
  setReady(value: boolean): void {
    if (value !== this.ready) {
      this.ready = value;
      this.touch();
    }
  }

  /** @internal Asks for a new picture. */
  touch(): void {
    this.stamp++;
  }
}
