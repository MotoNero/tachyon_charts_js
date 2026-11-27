// Values on a raster in space and how they show, as VolumeData, Volume3D and VolumeGpuFit of the .NET version.
import { Colormap, DoubleRange } from '@tachyon-charts/core';
import { ClipPlane3D } from './clip-plane';
import { Point3D } from './matrix';
import type { Material3D } from './surface';
import type { SceneAxes } from './axis-box';
import type { Ray3D } from './camera';
import { limitToBox, rayAt } from './picking';
import { BoxMap } from './points';
import type { TransferFunction3D } from './transfer';

/** The values of a volume: 8 bits, 16 bits (with a linear scale, as scanners store them) or 32-bit floats. */
export type VolumeValues = Uint8Array | Uint16Array | Float32Array;

/** Values on a raster in space. The array stays with the application, there is no copy. */
export class VolumeData {
  private range: DoubleRange | undefined;

  /**
   * @param values - The values, x fastest, then y, then z.
   * @param width - The number of values along the first axis.
   * @param height - The number of values along the second axis.
   * @param depth - The number of values along the third axis.
   * @param slope - For 16 bits: each value is slope × stored value + intercept.
   * @param intercept - For 16 bits: the value of a stored 0.
   * @throws RangeError for sizes below 2, another number of values, or a slope that is 0 or not finite.
   */
  constructor(
    /** The values. */
    readonly values: VolumeValues,
    /** The number of values along the first axis. */
    readonly width: number,
    /** The number of values along the second axis. */
    readonly height: number,
    /** The number of values along the third axis. */
    readonly depth: number,
    /** The slope of 16-bit values. */
    readonly slope = 1,
    /** The intercept of 16-bit values. */
    readonly intercept = 0,
  ) {
    if (width < 2 || height < 2 || depth < 2) {
      throw new RangeError('A volume needs at least two values along each axis.');
    }
    if (width * height * depth !== values.length) {
      throw new RangeError(
        `The sizes ask for ${String(width * height * depth)} values, the list holds ${String(values.length)}.`,
      );
    }
    if (slope === 0 || !Number.isFinite(slope)) {
      throw new RangeError(`The slope must be finite and not zero, not ${String(slope)}.`);
    }
    if (!Number.isFinite(intercept)) {
      throw new RangeError(`The intercept must be finite, not ${String(intercept)}.`);
    }
  }

  /** The smallest and largest value. The first access walks through all values. */
  get valueRange(): DoubleRange {
    if (!this.range) {
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i < this.values.length; i++) {
        const value = this.read(i);
        if (Number.isFinite(value)) {
          low = Math.min(low, value);
          high = Math.max(high, value);
        }
      }
      this.range = Number.isFinite(low) ? new DoubleRange(low, high) : new DoubleRange(0, 1);
    }
    return this.range;
  }

  /** @internal Whether the GPU stores 8 bits per value. */
  get isBytes(): boolean {
    return this.values instanceof Uint8Array;
  }

  /** The value at a place of the raster. */
  at(x: number, y: number, z: number): number {
    return this.read(z * this.width * this.height + y * this.width + x);
  }

  /** @internal Writes a slice as shares from 0 to 1 of the value range, which the GPU keeps exact for all kinds. */
  writeShares(z: number, target: Float32Array): void {
    const range = this.valueRange;
    const low = range.min;
    const scale = range.max > range.min ? 1 / (range.max - range.min) : 0;
    const start = z * this.width * this.height;
    const count = this.width * this.height;
    for (let i = 0; i < count; i++) {
      const value = this.read(start + i);
      target[i] = Number.isNaN(value) ? 0 : (value - low) * scale;
    }
  }

  /** @internal A slice of 8-bit values. */
  byteSlice(z: number): Uint8Array {
    const count = this.width * this.height;
    return (this.values as Uint8Array).subarray(z * count, (z + 1) * count);
  }

  private read(at: number): number {
    const value = this.values[at] as number;
    return this.values instanceof Uint16Array ? value * this.slope + this.intercept : value;
  }
}

/** How a volume shows beyond its slices: through the transfer function, the highest value along each ray, or a surface. */
export type VolumeMode = 'transfer' | 'maximum' | 'surface';

/**
 * How a volume fits on the graphics card. A volume that does not fit at full size first keeps its resolution with
 * 16-bit floats, about 11 bits per value, and else shows every second, third … value along each axis.
 */
export interface VolumeGpuFit {
  /** Every how many values along each axis the GPU keeps one. */
  readonly reduction: number;
  /** Whether the GPU keeps the values exact. */
  readonly isExact: boolean;
  /** The bytes on the graphics card. */
  readonly bytes: number;
  /** The bytes of the full volume, exact. */
  readonly fullBytes: number;
  /** The bytes the volume may take. */
  readonly budget: number;
}

function size(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1e9).toFixed(1)} GB`;
  }
  return bytes >= 1_000_000 ? `${(bytes / 1e6).toFixed(0)} MB` : `${(bytes / 1e3).toFixed(0)} KB`;
}

function ordinal(value: number): string {
  if (value === 2) {
    return '2nd';
  }
  return value === 3 ? '3rd' : `${String(value)}th`;
}

/** A sentence on how a volume fits on the graphics card, for a status line or a log. */
export function describeGpuFit(fit: VolumeGpuFit): string {
  if (fit.reduction > 1) {
    return `Volume reduced to every ${ordinal(fit.reduction)} value: ${size(fit.fullBytes)} exceed the budget of ${size(fit.budget)}, now ${size(fit.bytes)}.`;
  }
  return fit.isExact
    ? `Volume at full resolution, exact: ${size(fit.bytes)}.`
    : `Volume at full resolution as 16-bit floats: ${size(fit.fullBytes)} exact exceed the budget of ${size(fit.budget)}, now ${size(fit.bytes)}.`;
}

/** The options of a volume. */
export interface Volume3DOptions {
  /** The colors of the slices and of the maximum projection; Viridis by default. */
  readonly colormap?: Colormap;
  /** The values mapped across the colormap; the complete data range by default. */
  readonly colorRange?: DoubleRange;
  /** The function for looking through the volume; slices only without one. */
  readonly transfer?: TransferFunction3D;
  /** How the volume shows beyond its slices; through the transfer function by default. */
  readonly mode?: VolumeMode;
  /** How the surface takes the light; a little gloss by default. */
  readonly material?: Material3D;
  /** Whether the three slices show; true by default. */
  readonly showsSlices?: boolean;
  /** The share of the value range below which a slice stays clear, from 0 to 1; 0 by default. */
  readonly sliceThreshold?: number;
  /** The bytes the volume may take on the graphics card; 2 GiB by default, as the browser does not tell the memory. */
  readonly gpuMemoryLimit?: number;
}

/**
 * A volume with three slices that show as colored pictures, and rays through it as the mode asks. The data reach the
 * GPU slice by slice over several frames, so the page never waits.
 */
export class Volume3D {
  /** The colors of the slices. */
  readonly colormap: Colormap;
  /** The function for looking through the volume, or undefined for slices only. */
  readonly transfer: TransferFunction3D | undefined;
  /** How the volume shows beyond its slices. */
  readonly mode: VolumeMode;
  /** How the surface takes the light. */
  readonly material: Material3D;
  /** Whether the three slices show. */
  readonly showsSlices: boolean;
  /** The share of the value range below which a slice stays clear. */
  readonly sliceThreshold: number;
  /** The bytes the volume may take on the graphics card. */
  readonly gpuMemoryLimit: number;
  /** The slice across the first axis; it cuts nothing away. */
  readonly sliceX = new ClipPlane3D(new Point3D(1, 0, 0), 0, { hides: false });
  /** The slice across the second axis. */
  readonly sliceY = new ClipPlane3D(new Point3D(0, 1, 0), 0, { hides: false });
  /** The slice across the third axis. */
  readonly sliceZ = new ClipPlane3D(new Point3D(0, 0, 1), 0, { hides: false });
  private colors: DoubleRange | undefined;
  private isoPlace = 0.5;
  private loaded = 0;
  private ready = false;
  private fit: VolumeGpuFit | undefined;
  private changes = 0;
  /** @internal Whether the slider of the surface or the editor of the transfer function shows. */
  showsEditor = true;

  /**
   * @param data - The values.
   * @param x - The range of the first axis the volume fills.
   * @param y - The range of the second axis.
   * @param z - The range of the third axis.
   * @param options - Colors, mode, slices and memory.
   */
  constructor(
    /** The values. */
    readonly data: VolumeData,
    /** The range of the first axis. */
    readonly x: DoubleRange,
    /** The range of the second axis. */
    readonly y: DoubleRange,
    /** The range of the third axis. */
    readonly z: DoubleRange,
    options: Volume3DOptions = {},
  ) {
    this.colormap = options.colormap ?? Colormap.builtIn('viridis');
    this.colors = options.colorRange;
    this.transfer = options.transfer;
    this.mode = options.mode ?? 'transfer';
    this.material = options.material ?? { gloss: 0.35 };
    this.showsSlices = options.showsSlices ?? true;
    this.sliceThreshold = options.sliceThreshold ?? 0;
    this.gpuMemoryLimit = options.gpuMemoryLimit ?? 2 ** 31;
  }

  /**
   * The values mapped across the colormap, or undefined for the complete data range.
   * @throws RangeError when set to an empty range.
   */
  get colorRange(): DoubleRange | undefined {
    return this.colors;
  }

  set colorRange(value: DoubleRange | undefined) {
    if (value?.isEmpty) {
      throw new RangeError('The color range must not be empty.');
    }
    this.colors = value;
    this.changes++;
  }

  /** The value of the surface in the surface mode; the chart also moves it with a slider. */
  get isoValue(): number {
    const range = this.data.valueRange;
    return range.min + this.isoPlace * (range.max - range.min);
  }

  set isoValue(value: number) {
    const range = this.data.valueRange;
    this.isoShare = range.max > range.min ? (value - range.min) / (range.max - range.min) : 0.5;
  }

  /** @internal The value of the surface as a share of the value range. */
  get isoShare(): number {
    return this.isoPlace;
  }

  set isoShare(value: number) {
    this.isoPlace = Math.min(Math.max(value, 0), 1);
    this.changes++;
  }

  /** @internal Whether rays run through the volume. */
  get marches(): boolean {
    return this.mode !== 'transfer' || this.transfer !== undefined;
  }

  /** Whether all values have reached the GPU. */
  get isReady(): boolean {
    return this.ready;
  }

  /** How the volume fits on the graphics card, or undefined before it first shows. */
  get gpuFit(): VolumeGpuFit | undefined {
    return this.fit;
  }

  /** @internal The share of the slices on the GPU, from 0 to 1. */
  get progress(): number {
    return Math.min(1, this.loaded / this.data.depth);
  }

  /** Grows as slices arrive and the look changes. */
  get version(): number {
    return (
      this.changes + this.sliceX.version + this.sliceY.version + this.sliceZ.version + (this.transfer?.version ?? 0)
    );
  }

  /** @internal The color range as shares of the stored data range. */
  get colorShares(): [number, number] {
    const stored = this.data.valueRange;
    const range = this.colors ?? stored;
    const span = stored.max - stored.min;
    const scale = span > 0 ? 1 / span : 0;
    const minimum = (range.min - stored.min) * scale;
    const maximum = (range.max - stored.min) * scale;
    return maximum > minimum ? [minimum, maximum] : [minimum, minimum + 1e-12];
  }

  /** @internal Takes note of the slices on the GPU. */
  setLoaded(slices: number): void {
    this.loaded = slices;
    this.ready = slices >= this.data.depth;
    this.changes++;
  }

  /** @internal Takes note of how the volume fits. */
  setFit(fit: VolumeGpuFit): void {
    this.fit = fit;
  }
  /** @internal The corners of the volume in the box. */
  boxOf(scene: SceneAxes): [Point3D, Point3D] {
    const map = new BoxMap(scene.xAxis, scene.yAxis, scene.zAxis);
    const a = map.toBox(new Point3D(this.x.min, this.y.min, this.z.min));
    const b = map.toBox(new Point3D(this.x.max, this.y.max, this.z.max));
    return [
      new Point3D(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)),
      new Point3D(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)),
    ];
  }

  /** @internal A place of the raster in the units of the axes. */
  toData(place: readonly [number, number, number]): Point3D {
    const data = this.data;
    return new Point3D(
      this.x.min + ((this.x.max - this.x.min) * place[0]) / (data.width - 1),
      this.y.min + ((this.y.max - this.y.min) * place[1]) / (data.height - 1),
      this.z.min + ((this.z.max - this.z.min) * place[2]) / (data.depth - 1),
    );
  }

  /** @internal The slice that a ray meets first, as distance, place in the box and in the raster. */
  findOnSlice(ray: Ray3D, scene: SceneAxes, near: number, far: number): VolumeHit | undefined {
    const [low, high] = this.boxOf(scene);
    let found: VolumeHit | undefined;
    let limit = far;
    for (const slice of [this.sliceX, this.sliceY, this.sliceZ]) {
      const climb = Point3D.dot(ray.direction, slice.normal);
      const along = climb === 0 ? Number.NaN : (slice.offset - Point3D.dot(ray.start, slice.normal)) / climb;
      if (along >= near && along <= limit) {
        const box = rayAt(ray, along);
        if (contains(box, low, high)) {
          const place = this.toRaster(box, low, high);
          if (this.isShown(place)) {
            limit = along;
            found = { distance: along, box, place };
          }
        }
      }
    }
    return found;
  }

  /** @internal Follows a ray through the volume as its mode shows it, as distance, place in the box and in the raster. */
  findInside(ray: Ray3D, scene: SceneAxes, near: number, far: number): VolumeHit | undefined {
    if (!this.marches) {
      return undefined;
    }
    const [low, high] = this.boxOf(scene);
    const span: [number, number] = [near, far];
    if (!limitToBox(ray, low, high, span)) {
      return undefined;
    }
    const [from, to] = span;
    const step = (high.x - low.x) / this.data.width;
    const range = this.data.valueRange;
    const scale = range.max > range.min ? 1 / (range.max - range.min) : 0;
    const valueAt = (place: readonly [number, number, number]): number => this.data.at(place[0], place[1], place[2]);
    if (this.mode === 'maximum') {
      let best = -Infinity;
      let bestAlong = Number.NaN;
      let bestPlace: [number, number, number] = [0, 0, 0];
      for (let along = from; along <= to; along += step) {
        const place = this.toRaster(rayAt(ray, along), low, high);
        const value = valueAt(place);
        if (value > best) {
          best = value;
          bestAlong = along;
          bestPlace = place;
        }
      }
      const share = (best - range.min) * scale;
      return Number.isNaN(bestAlong) || share <= this.sliceThreshold
        ? undefined
        : { distance: bestAlong, box: rayAt(ray, bestAlong), place: bestPlace };
    }
    if (this.mode === 'surface') {
      const level = this.isoValue;
      const below = valueAt(this.toRaster(rayAt(ray, from), low, high)) < level;
      for (let along = from + step; along <= to; along += step) {
        const place = this.toRaster(rayAt(ray, along), low, high);
        if (valueAt(place) < level !== below) {
          return { distance: along, box: rayAt(ray, along), place };
        }
      }
      return undefined;
    }
    // Adds up opacity until it covers half of what lies behind.
    let covered = 0;
    for (let along = from; along <= to; along += step) {
      const place = this.toRaster(rayAt(ray, along), low, high);
      covered += (1 - covered) * (this.transfer as TransferFunction3D).opacityAt((valueAt(place) - range.min) * scale);
      if (covered >= 0.5) {
        return { distance: along, box: rayAt(ray, along), place };
      }
    }
    return undefined;
  }

  private toRaster(place: Point3D, low: Point3D, high: Point3D): [number, number, number] {
    const index = (value: number, a: number, b: number, count: number): number =>
      Math.min(Math.max(Math.round(((value - a) / (b - a)) * (count - 1)), 0), count - 1);
    return [
      index(place.x, low.x, high.x, this.data.width),
      index(place.y, low.y, high.y, this.data.height),
      index(place.z, low.z, high.z, this.data.depth),
    ];
  }

  private isShown(place: readonly [number, number, number]): boolean {
    const range = this.data.valueRange;
    const value = this.data.at(place[0], place[1], place[2]);
    const share = range.max > range.min ? (value - range.min) / (range.max - range.min) : 0;
    return share >= this.sliceThreshold;
  }
}

/** A hit in a volume. */
export interface VolumeHit {
  /** The distance along the ray. */
  readonly distance: number;
  /** The place in the box. */
  readonly box: Point3D;
  /** The place in the raster: column, row and slice. */
  readonly place: [number, number, number];
}

function contains(place: Point3D, low: Point3D, high: Point3D): boolean {
  return (
    place.x >= low.x &&
    place.x <= high.x &&
    place.y >= low.y &&
    place.y <= high.y &&
    place.z >= low.z &&
    place.z <= high.z
  );
}
