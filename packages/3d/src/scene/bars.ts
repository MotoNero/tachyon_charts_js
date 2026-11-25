// Columns over the cells of a grid, as tall as the value of each cell, as Bars3D of the .NET version.
import { Colormap, type DoubleRange, type HeatmapData } from '@tachyon-charts/core';
import { toBox, type SceneAxes } from './axis-box';
import { BoxMap } from './points';
import type { Material3D } from './surface';
import { Point3D } from './matrix';

/** @internal The bytes of one bar on the GPU: middle and half size, low and high end, color. */
export const barStride = 28;

/** The cells of a grid in the box: left and front edge, step per column and row, and the lines. */
export interface GridPlace {
  /** The left edge in the box. */
  readonly left: number;
  /** The front edge in the box. */
  readonly front: number;
  /** The step from line to line along X. */
  readonly stepX: number;
  /** The step from line to line along Y. */
  readonly stepY: number;
  /** The number of lines along X. */
  readonly columns: number;
  /** The number of lines along Y. */
  readonly rows: number;
}

/** @internal The grid of a range of X and Y in the box, with `columns` and `rows` lines. */
export function gridPlace(scene: SceneAxes, x: DoubleRange, y: DoubleRange, columns: number, rows: number): GridPlace {
  const left = toBox(scene.xAxis, x.min);
  const right = toBox(scene.xAxis, x.max);
  const front = toBox(scene.yAxis, y.min);
  const back = toBox(scene.yAxis, y.max);
  return { left, front, stepX: (right - left) / (columns - 1), stepY: (back - front) / (rows - 1), columns, rows };
}

/** The options of columns. */
export interface Bars3DOptions {
  /** The colors by value; Viridis by default. */
  readonly colormap?: Colormap;
  /** The values the ends of the colormap stand for; the range of the values by default. */
  readonly colorRange?: DoubleRange;
  /** How the columns take the light. */
  readonly material?: Material3D;
  /** The share of a cell a column covers; 0.8 by default. */
  readonly width?: number;
  /** The value the columns stand on; 0 by default. */
  readonly baseline?: number;
}

/** Columns over the cells of a grid, each as tall as its value and colored by it. */
export class Bars3D {
  /** The colors by value. */
  readonly colormap: Colormap;
  /** The values the ends of the colormap stand for. */
  readonly colorRange: DoubleRange | undefined;
  /** How the columns take the light. */
  readonly material: Material3D | undefined;
  /** The share of a cell a column covers. */
  readonly width: number;
  /** The value the columns stand on. */
  readonly baseline: number;

  /**
   * @param data - One value per cell; a missing value leaves the cell empty.
   * @param x - The range the columns of cells cover along X.
   * @param y - The range the rows of cells cover along Y.
   * @param options - Colors, material, width and baseline.
   */
  constructor(
    /** One value per cell. */
    readonly data: HeatmapData,
    /** The range the cells cover along X. */
    readonly x: DoubleRange,
    /** The range the cells cover along Y. */
    readonly y: DoubleRange,
    options: Bars3DOptions = {},
  ) {
    this.colormap = options.colormap ?? Colormap.builtIn('viridis');
    this.colorRange = options.colorRange;
    this.material = options.material;
    this.width = options.width ?? 0.8;
    this.baseline = options.baseline ?? 0;
  }

  /** Grows when the values change. */
  get version(): number {
    return this.data.version;
  }

  /** @internal The grid of the cells in the box. */
  cells(scene: SceneAxes): GridPlace {
    return gridPlace(scene, this.x, this.y, this.data.width + 1, this.data.height + 1);
  }

  /** @internal The low and high end of a column in the box, cut to the box; none for a missing value. */
  ends(value: number, map: BoxMap): [number, number] {
    if (!Number.isFinite(value)) {
      return [0, 0];
    }
    const a = map.toBox(new Point3D(0, 0, value)).z;
    const b = map.toBox(new Point3D(0, 0, this.baseline)).z;
    const clamp = (v: number): number => Math.min(Math.max(v, -1), 1);
    return [clamp(Math.min(a, b)), clamp(Math.max(a, b))];
  }

  /** @internal Writes one bar per cell, row by row, as the bar shader reads them. */
  write(scene: SceneAxes, into: ArrayBuffer): void {
    const place = this.cells(scene);
    const columns = this.data.width;
    const range = this.colorRange ?? this.data.valueRange;
    const sizeX = Math.fround((place.stepX * this.width) / 2);
    const sizeY = Math.fround((place.stepY * this.width) / 2);
    const map = new BoxMap(scene.xAxis, scene.yAxis, scene.zAxis);
    const floats = new Float32Array(into);
    const bytes = new Uint8Array(into);
    for (let row = 0; row < this.data.height; row++) {
      for (let column = 0; column < columns; column++) {
        const value = this.data.at(column, row);
        const [low, high] = this.ends(value, map);
        const share = range && range.max > range.min ? (value - range.min) / (range.max - range.min) : 0.5;
        const color = this.colormap.sample(share);
        const at = ((row * columns + column) * barStride) / 4;
        floats[at] = Math.fround(place.left + (column + 0.5) * place.stepX);
        floats[at + 1] = Math.fround(place.front + (row + 0.5) * place.stepY);
        floats[at + 2] = sizeX;
        floats[at + 3] = sizeY;
        floats[at + 4] = low;
        floats[at + 5] = high;
        bytes.set([color.r, color.g, color.b, color.a], (at + 6) * 4);
      }
    }
  }
}
