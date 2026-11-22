// A scatter of any size as a density, as PointDensitySeries of the .NET version: its point tiles count the view per
// pixel in their worker, from the grid when the view is wide and from the points of the visible tiles when it is
// narrow, and the counts are drawn as a raster in a colormap.
import { DoubleRange, RasterSeries, type Axis, type SeriesFrame } from '@tachyon-charts/core';
import type { DensityView } from './point-tiles-file';
import type { CountedView, PointTiles } from './point-tiles';

/** A density of the points of point tiles; give it {@link PointTiles}. */
export class PointDensitySeries extends RasterSeries {
  /** The most points read for one view; 4 million by default. */
  pointBudget = 4_000_000;
  private pending = false;
  private wish: DensityView | undefined;
  private shown: DensityView | undefined;
  private highest = 0;
  private read = 0;

  /**
   * @param tiles - The point tiles it draws.
   * @param xAxis - The horizontal axis.
   * @param yAxis - The vertical axis.
   */
  constructor(
    /** The point tiles it draws. */
    readonly tiles: PointTiles,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
    this.isLogarithmic = true;
  }

  /** The highest count of a pixel in the view shown. */
  get maximum(): number {
    return this.highest;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.drawnPointCount} */
  override get drawnPointCount(): number {
    return this.read;
  }

  /** {@inheritDoc @tachyon-charts/core#RasterSeries.version} */
  override get version(): number {
    return super.version + this.tiles.version;
  }

  /** {@inheritDoc @tachyon-charts/core#RasterSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const extent = this.tiles.extent;
    if (!extent) {
      return undefined;
    }
    return axis === 'x' ? new DoubleRange(extent.minX, extent.maxX) : new DoubleRange(extent.minY, extent.maxY);
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.prepareData} */
  override prepareData(frame: SeriesFrame): void {
    if (!this.tiles.isReady) {
      return;
    }
    const x = this.xAxis.visibleRange;
    const y = this.yAxis.visibleRange;
    const view: DensityView = {
      width: Math.max(1, Math.floor(frame.bounds.width)),
      height: Math.max(1, Math.floor(frame.bounds.height)),
      left: Math.min(x.min, x.max),
      right: Math.max(x.min, x.max),
      bottom: Math.min(y.min, y.max),
      top: Math.max(y.min, y.max),
    };
    if (same(view, this.shown) || same(view, this.wish)) {
      return;
    }
    this.wish = view;
    if (!this.pending) {
      this.count(view);
    }
  }

  private count(view: DensityView): void {
    this.pending = true;
    void this.tiles.countView(view, this.pointBudget).then(
      (counted) => {
        this.pending = false;
        this.show(counted);
        if (this.wish && !same(this.wish, counted.view)) {
          this.count(this.wish);
        }
      },
      () => {
        this.pending = false;
      },
    );
  }

  private show(counted: CountedView): void {
    const { view } = counted;
    this.shown = view;
    this.highest = counted.maximum;
    this.read = counted.drawn;
    if (counted.maximum > 0) {
      // On a logarithmic scale from a thousandth of the highest count up; fewer points show in the lowest color.
      const low = Math.min(1, counted.maximum / 1000);
      super.valueRange = new DoubleRange(low, Math.max(counted.maximum, low * 2));
    }
    this.setValues(counted.values, view.width, view.height, {
      left: view.left,
      right: view.right,
      bottom: view.bottom,
      top: view.top,
    });
  }
}

function same(a: DensityView, b: DensityView | undefined): boolean {
  return (
    b?.width === a.width &&
    a.height === b.height &&
    a.left === b.left &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.top === b.top
  );
}
