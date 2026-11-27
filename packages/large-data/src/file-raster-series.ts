// A raster larger than memory, as the raster series over a raster file of the .NET version: from the coarsest level
// that still gives half a cell per pixel, it reads the region in view and a margin around it, and reads again when the
// view leaves that region or needs another level.
import { DoubleRange, RasterSeries, type Axis, type SeriesFrame } from '@tachyon-charts/core';
import type { LargeRaster } from './large-raster';
import type { RasterRegion } from './raster-worker';

/** Cells read at most for one region of the raster itself while the stages are not ready. */
const maximumCells = 1 << 24;

/** A raster series over a raster file; give it a {@link LargeRaster}. */
export class FileRasterSeries extends RasterSeries {
  private loaded: RasterRegion | undefined;
  private pending: RasterRegion | undefined;
  private ranged = false;
  private wish: RasterRegion | undefined;

  /**
   * @param raster - The raster it draws.
   * @param xAxis - The horizontal axis.
   * @param yAxis - The vertical axis.
   */
  constructor(
    /** The raster it draws. */
    readonly raster: LargeRaster,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.refiningProgress} */
  override get refiningProgress(): number | undefined {
    return this.raster.progress;
  }

  /**
   * Whether the colormap spans the lowest to the highest value of the raster once its stages know them; on by
   * default, off once a range is set.
   */
  autoValueRange = true;

  /** {@inheritDoc @tachyon-charts/core#RasterSeries.valueRange} */
  override get valueRange(): DoubleRange {
    return super.valueRange;
  }

  override set valueRange(value: DoubleRange) {
    this.autoValueRange = false;
    super.valueRange = value;
  }

  /** {@inheritDoc @tachyon-charts/core#RasterSeries.version} */
  override get version(): number {
    return super.version + this.raster.version;
  }

  /** The region of the level it shows, once read. */
  get region(): RasterRegion | undefined {
    return this.loaded;
  }

  /** {@inheritDoc @tachyon-charts/core#RasterSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const raster = this.raster;
    return axis === 'x'
      ? new DoubleRange(raster.xStart, raster.xStart + raster.width * raster.xStep)
      : new DoubleRange(raster.yStart, raster.yStart + raster.height * raster.yStep);
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.prepareData} */
  override prepareData(frame: SeriesFrame): void {
    const raster = this.raster;
    if (this.autoValueRange && !this.ranged && raster.isReady && raster.high >= raster.low) {
      this.ranged = true;
      super.valueRange = new DoubleRange(raster.low, raster.high);
    }
    const wanted = this.wanted(frame);
    if (!wanted || (this.loaded && this.covers(this.loaded, wanted))) {
      return;
    }
    this.wish = wanted;
    if (!this.pending) {
      this.load(wanted);
    }
  }

  // The level and the region with a margin of a quarter on each side that the view needs; none while the level is
  // not ready or the view misses the raster.
  private wanted(frame: SeriesFrame): RasterRegion | undefined {
    const raster = this.raster;
    const x = this.xAxis.visibleRange;
    const y = this.yAxis.visibleRange;
    const width = raster.width * raster.xStep;
    const height = raster.height * raster.yStep;
    const fx0 = Math.max(0, (Math.min(x.min, x.max) - raster.xStart) / width);
    const fx1 = Math.min(1, (Math.max(x.min, x.max) - raster.xStart) / width);
    const fy0 = Math.max(0, (Math.min(y.min, y.max) - raster.yStart) / height);
    const fy1 = Math.min(1, (Math.max(y.min, y.max) - raster.yStart) / height);
    if (!(fx1 > fx0 && fy1 > fy0)) {
      return undefined;
    }
    const pixelsX = Math.max(
      1,
      frame.bounds.width * ((fx1 - fx0) / ((Math.max(x.min, x.max) - Math.min(x.min, x.max)) / width)),
    );
    const pixelsY = Math.max(
      1,
      frame.bounds.height * ((fy1 - fy0) / ((Math.max(y.min, y.max) - Math.min(y.min, y.max)) / height)),
    );
    let level = 0;
    if (raster.isReady) {
      for (let candidate = raster.levels.length - 1; candidate > 0; candidate--) {
        const size = raster.levels[candidate] as { width: number; height: number };
        if ((fx1 - fx0) * size.width >= pixelsX / 2 && (fy1 - fy0) * size.height >= pixelsY / 2) {
          level = candidate;
          break;
        }
      }
    }
    const size = raster.levels[level] as { width: number; height: number };
    const marginX = (fx1 - fx0) / 4;
    const marginY = (fy1 - fy0) / 4;
    const column = Math.max(0, Math.floor((fx0 - marginX) * size.width));
    const row = Math.max(0, Math.floor((fy0 - marginY) * size.height));
    const columns = Math.min(size.width, Math.ceil((fx1 + marginX) * size.width)) - column;
    const rows = Math.min(size.height, Math.ceil((fy1 + marginY) * size.height)) - row;
    if (level === 0 && !raster.isReady && columns * rows > maximumCells) {
      return undefined;
    }
    return { level, column, row, columns, rows };
  }

  // Whether a loaded region serves the wish: the same level, and the part in view (the wish less its margin) inside.
  private covers(loaded: RasterRegion, wish: RasterRegion): boolean {
    if (loaded.level !== wish.level) {
      return false;
    }
    const marginX = Math.floor(wish.columns / 6);
    const marginY = Math.floor(wish.rows / 6);
    return (
      loaded.column <= wish.column + marginX &&
      loaded.row <= wish.row + marginY &&
      loaded.column + loaded.columns >= wish.column + wish.columns - marginX &&
      loaded.row + loaded.rows >= wish.row + wish.rows - marginY
    );
  }

  private load(region: RasterRegion): void {
    this.pending = region;
    void this.raster.readRegion(region).then(
      (values) => {
        this.pending = undefined;
        this.show(region, values);
        if (this.wish && !this.covers(region, this.wish)) {
          this.load(this.wish);
        }
      },
      () => {
        this.pending = undefined;
      },
    );
  }

  private show(region: RasterRegion, values: Float32Array): void {
    const raster = this.raster;
    const size = raster.levels[region.level] as { width: number; height: number };
    const cellWidth = (raster.width * raster.xStep) / size.width;
    const cellHeight = (raster.height * raster.yStep) / size.height;
    this.loaded = region;
    this.setValues(values, region.columns, region.rows, {
      left: raster.xStart + region.column * cellWidth,
      right: raster.xStart + (region.column + region.columns) * cellWidth,
      bottom: raster.yStart + region.row * cellHeight,
      top: raster.yStart + (region.row + region.rows) * cellHeight,
    });
  }
}
