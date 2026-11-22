// Values on a grid of cells, colored by a table, as the raster drawing of the .NET version: the values go to the GPU
// as one texture of floats, the colormap as a row of colors, and the shader looks up each pixel. Only the part of the
// raster inside the plot is drawn, through the section of the texture.
import { builtInColormapEntries } from '../generated/colormaps';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList, RasterReduction, RasterStyle } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuTexture } from '../render/resources';
import { parseColor, type PixelRect, type Rgba8 } from '../render/types';

/** A table of colors from low to high values. */
export class Colormap {
  /**
   * @param name - The name.
   * @param entries - The colors from the lowest value to the highest, at least two.
   */
  constructor(
    /** The name. */
    readonly name: string,
    /** The colors from the lowest value to the highest. */
    readonly entries: readonly Rgba8[],
  ) {
    if (entries.length < 2) {
      throw new RangeError('A colormap needs at least two colors.');
    }
  }

  /** The names of the built-in colormaps, those of the .NET version: Viridis, Inferno, Magma, Plasma, Turbo, Grayscale. */
  static get builtInNames(): readonly string[] {
    return Object.keys(builtInColormapEntries);
  }

  /**
   * A built-in colormap by its name, in any case.
   * @throws RangeError for an unknown name.
   */
  static builtIn(name: string): Colormap {
    const key = Object.keys(builtInColormapEntries).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const text = key === undefined ? undefined : builtInColormapEntries[key];
    if (key === undefined || text === undefined) {
      throw new RangeError(`There is no colormap "${name}".`);
    }
    const entries: Rgba8[] = [];
    for (let at = 0; at < text.length; at += 9) {
      entries.push(parseColor(text.slice(at, at + 9)));
    }
    return new Colormap(key, entries);
  }

  /** The colors as bytes, red, green, blue and alpha, for a texture one row high. */
  toBytes(): Uint8Array {
    const bytes = new Uint8Array(this.entries.length * 4);
    this.entries.forEach((color, i) => {
      bytes.set([color.r, color.g, color.b, color.a], i * 4);
    });
    return bytes;
  }
}

/** Where a grid of cells lies on the axes: the edges of its first and last cells. */
export interface RasterExtent {
  /** The left edge of the first column. */
  readonly left: number;
  /** The right edge of the last column. */
  readonly right: number;
  /** The lower edge of the first row. */
  readonly bottom: number;
  /** The upper edge of the last row. */
  readonly top: number;
}

/**
 * A raster of values, row 0 at the bottom, colored by a colormap over a range of values. Give it values with
 * {@link RasterSeries.setValues}; series that read rasters from files give it the part they read.
 */
export class RasterSeries extends ChartSeries {
  private values: Float32Array = new Float32Array(1).fill(Number.NaN);
  private columns = 1;
  private rows = 1;
  private extent: RasterExtent | undefined;
  private map: Colormap = Colormap.builtIn('Viridis');
  private low = 0;
  private high = 1;
  private logarithmic = false;
  private interpolated = false;
  private missing: Rgba8 = { r: 0, g: 0, b: 0, a: 0 };
  private changes = 0;
  private valuesTexture: GpuTexture | undefined;
  private colorTexture: GpuTexture | undefined;
  private uploadedValues = -1;
  private uploadedColors: Colormap | undefined;
  private style: RasterStyle | undefined;
  private bounds: PixelRect | undefined;

  /** The colormap; Viridis by default. */
  get colormap(): Colormap {
    return this.map;
  }

  set colormap(value: Colormap) {
    this.map = value;
    this.changes++;
  }

  /** The values at the ends of the colormap; 0 and 1 by default. */
  get valueRange(): DoubleRange {
    return new DoubleRange(this.low, this.high);
  }

  set valueRange(value: DoubleRange) {
    this.low = value.min;
    this.high = value.max;
    this.changes++;
  }

  /** Whether the colors follow the logarithm of the values; the lowest value must then be positive. */
  get isLogarithmic(): boolean {
    return this.logarithmic;
  }

  set isLogarithmic(value: boolean) {
    this.logarithmic = value;
    this.changes++;
  }

  /** Whether the values blend between the centers of the cells. */
  get isInterpolated(): boolean {
    return this.interpolated;
  }

  set isInterpolated(value: boolean) {
    this.interpolated = value;
    this.changes++;
  }

  /** The color of cells without a value (NaN); transparent by default. */
  get missingColor(): Rgba8 {
    return this.missing;
  }

  set missingColor(value: Rgba8) {
    this.missing = value;
    this.changes++;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.changes;
  }

  /**
   * Sets the values, `columns` per row, row 0 at the bottom, and where the grid lies.
   * @throws RangeError when the values do not fill the grid.
   */
  setValues(values: Float32Array, columns: number, rows: number, extent: RasterExtent): void {
    if (columns < 1 || rows < 1 || values.length < columns * rows) {
      throw new RangeError(`${String(values.length)} values do not fill ${String(columns)} × ${String(rows)} cells.`);
    }
    this.values = values;
    this.columns = columns;
    this.rows = rows;
    this.extent = extent;
    this.changes++;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const extent = this.extent;
    if (!extent) {
      return undefined;
    }
    return axis === 'x' ? new DoubleRange(extent.left, extent.right) : new DoubleRange(extent.bottom, extent.top);
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    this.prepareData(frame);
    const extent = this.extent;
    this.bounds = undefined;
    if (!extent) {
      return;
    }
    if (!this.valuesTexture || this.uploadedValues !== this.changes) {
      const size = this.valuesTexture?.size;
      if (!this.valuesTexture || size?.width !== this.columns || size.height !== this.rows) {
        this.valuesTexture?.dispose();
        this.valuesTexture = device.createTexture({
          size: { width: this.columns, height: this.rows },
          format: 'r32float',
        });
      }
      this.valuesTexture.write(this.values.subarray(0, this.columns * this.rows));
      this.uploadedValues = this.changes;
    }
    if (!this.colorTexture || this.uploadedColors !== this.map) {
      this.colorTexture?.dispose();
      this.colorTexture = device.createTexture({
        size: { width: this.map.entries.length, height: 1 },
        format: 'rgba8unorm',
      });
      this.colorTexture.write(this.map.toBytes());
      this.uploadedColors = this.map;
    }
    this.place(frame, extent);
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList): void {
    if (this.bounds && this.style && this.valuesTexture && this.colorTexture) {
      commands.drawRaster(this.valuesTexture, this.colorTexture, this.bounds, this.style);
    }
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.valuesTexture?.dispose();
    this.colorTexture?.dispose();
    this.valuesTexture = undefined;
    this.colorTexture = undefined;
    this.uploadedColors = undefined;
  }

  // The part of the raster inside the plot: its pixels and the section of the texture they show. Row 0 is at the
  // bottom, so the section runs from the top row down.
  private place(frame: SeriesFrame, extent: RasterExtent): void {
    const plot = frame.bounds;
    const left = frame.x.toPixel(extent.left);
    const right = frame.x.toPixel(extent.right);
    const top = frame.y.toPixel(extent.top);
    const bottom = frame.y.toPixel(extent.bottom);
    const x0 = Math.max(Math.min(left, right), plot.x);
    const x1 = Math.min(Math.max(left, right), plot.x + plot.width);
    const y0 = Math.max(Math.min(top, bottom), plot.y);
    const y1 = Math.min(Math.max(top, bottom), plot.y + plot.height);
    if (!(x1 > x0 && y1 > y0)) {
      return;
    }
    const fx0 = (x0 - left) / (right - left);
    const fx1 = (x1 - left) / (right - left);
    // Fractions from the bottom row up.
    const fyTop = (bottom - y0) / (bottom - top);
    const fyBottom = (bottom - y1) / (bottom - top);
    const cellsPerPixel = ((fx1 - fx0) * this.columns) / (x1 - x0);
    const reduction: RasterReduction = cellsPerPixel > 1 && !this.interpolated ? 'mean' : 'nearest';
    this.bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    this.style = {
      minimum: this.low,
      maximum: this.high,
      isLogarithmic: this.logarithmic,
      isInterpolated: this.interpolated,
      missingColor: this.missing,
      reduction,
      sectionX: fx0,
      sectionY: fyTop,
      sectionWidth: fx1 - fx0,
      sectionHeight: fyBottom - fyTop,
    };
  }
}
