// What color and opacity each value gets when looking through a volume, as TransferFunction3D of the .NET version.
import type { Rgba8 } from '@tachyon-charts/core';

/** A point of a transfer function: a share of the value range from 0 to 1, a color and an opacity from 0 to 1. */
export interface TransferPoint3D {
  /** The share of the value range. */
  readonly share: number;
  /** The color. */
  readonly color: Rgba8;
  /** The opacity. */
  readonly opacity: number;
}

/** @internal The number of entries that the GPU reads. */
export const transferTableSize = 256;

/** Says which color and opacity each value gets when looking through a volume. Both run straight between the points. */
export class TransferFunction3D {
  private list: TransferPoint3D[];
  private changes = 0;
  /** @internal Whether the small editor shows in the corner of the picture. */
  showsEditor = true;

  /**
   * @param points - At least two points, sorted by their share.
   * @throws RangeError for fewer than two points or points out of order.
   */
  constructor(points: readonly TransferPoint3D[]) {
    if (points.length < 2) {
      throw new RangeError('A transfer function needs at least two points.');
    }
    for (let i = 1; i < points.length; i++) {
      if ((points[i] as TransferPoint3D).share < (points[i - 1] as TransferPoint3D).share) {
        throw new RangeError('The points must be sorted by their share.');
      }
    }
    this.list = [...points];
  }

  /** The points. */
  get points(): readonly TransferPoint3D[] {
    return this.list;
  }

  /** Grows with each change of the points. */
  get version(): number {
    return this.changes;
  }

  /**
   * Moves a point. It stays between its neighbours, and the ends keep their share.
   * @throws RangeError for a point that does not exist.
   */
  move(index: number, share: number, opacity: number): void {
    const point = this.list[index];
    if (!point) {
      throw new RangeError(`There is no point ${String(index)}.`);
    }
    const isEnd = index === 0 || index === this.list.length - 1;
    const place = isEnd
      ? point.share
      : Math.min(
          Math.max(share, (this.list[index - 1] as TransferPoint3D).share),
          (this.list[index + 1] as TransferPoint3D).share,
        );
    this.list = this.list.map((item, i) =>
      i === index ? { ...item, share: place, opacity: Math.min(Math.max(opacity, 0), 1) } : item,
    );
    this.changes++;
  }

  /** The opacity at a share of the value range. */
  opacityAt(share: number): number {
    const out = new Float32Array(4);
    this.sample(share, out, 0);
    return out[3] as number;
  }

  /** @internal Writes the table for the GPU: red, green, blue and opacity per entry, in single precision. */
  writeTable(table: Float32Array): void {
    const count = table.length / 4;
    for (let i = 0; i < count; i++) {
      this.sample(i / (count - 1), table, i * 4);
    }
  }

  // Straight between the two points around a share, in single precision as Vector4.Lerp.
  private sample(share: number, into: Float32Array, at: number): void {
    const points = this.list;
    const write = (point: TransferPoint3D): void => {
      into[at] = Math.fround(point.color.r / 255);
      into[at + 1] = Math.fround(point.color.g / 255);
      into[at + 2] = Math.fround(point.color.b / 255);
      into[at + 3] = Math.fround(point.opacity);
    };
    const first = points[0] as TransferPoint3D;
    if (share <= first.share) {
      write(first);
      return;
    }
    for (let i = 1; i < points.length; i++) {
      const b = points[i] as TransferPoint3D;
      if (share <= b.share) {
        const a = points[i - 1] as TransferPoint3D;
        const step = b.share - a.share;
        const t = step > 0 ? Math.fround((share - a.share) / step) : 1;
        const lerp = (x: number, y: number): number => {
          const fx = Math.fround(x);
          const fy = Math.fround(y);
          // As Vector4.Lerp: a · (1 − t) + b · t, the first product added without rounding.
          return Math.fround(fx * Math.fround(1 - t) + Math.fround(fy * t));
        };
        into[at] = lerp(a.color.r / 255, b.color.r / 255);
        into[at + 1] = lerp(a.color.g / 255, b.color.g / 255);
        into[at + 2] = lerp(a.color.b / 255, b.color.b / 255);
        into[at + 3] = lerp(a.opacity, b.opacity);
        return;
      }
    }
    write(points[points.length - 1] as TransferPoint3D);
  }
}
