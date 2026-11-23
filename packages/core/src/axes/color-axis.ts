// The value scale of a raster, as ColorAxis of the .NET version: an axis beside the plot with a color bar. It belongs
// to the axes of a pane, after the Y axis, follows the values of its series, and does not follow zooming the pane.
import { DoubleRange } from '../numerics/range';
import { LogScaling, type AxisScaling } from '../numerics/scaling';
import type { RasterStyle } from '../render/commands';
import type { Rgba8 } from '../render/types';
import { Colormap } from '../series/colormap';
import { Axis, type AxisPosition, type TextMeasurer, type TickSet } from './axis';
import { LogAxis } from './log-axis';
import { NumericAxis } from './numeric-axis';

const barWidth = 14;
const relativeFloor = 1e-6;
const logarithm = new LogScaling(10);

/** The value scale of a raster or heatmap: a color bar beside the plot with the ticks of its values. */
export class ColorAxis extends Axis {
  private map = Colormap.builtIn('Viridis');
  private logarithmic = false;
  private missing: Rgba8 = { r: 0, g: 0, b: 0, a: 0 };
  private below: Rgba8 | undefined;
  private above: Rgba8 | undefined;
  private ticks: Axis;
  /** The width the layout keeps for the labels, so that the plot does not move while the range changes. */
  stableLabelWidth = 0;
  /** The length of the axis that width belongs to. */
  stableLabelLength = 0;

  /**
   * @param id - The name of the axis.
   * @param position - Left or right of the plot; right by default.
   * @throws RangeError for a position above or below the plot.
   */
  constructor(id: string, position: AxisPosition = 'right') {
    super(id, position);
    if (this.isHorizontal) {
      throw new RangeError('A color axis stands beside the plot.');
    }
    this.ticks = new NumericAxis(id, position);
    this.isAutoRange = true;
  }

  /** The colors; Viridis by default. */
  get colormap(): Colormap {
    return this.map;
  }

  set colormap(value: Colormap) {
    if (this.map !== value) {
      this.map = value;
      this.changed();
    }
  }

  /** Whether the colors follow the logarithm of the values. */
  get isLogarithmic(): boolean {
    return this.logarithmic;
  }

  set isLogarithmic(value: boolean) {
    if (this.logarithmic === value) {
      return;
    }
    this.logarithmic = value;
    this.ticks = value ? new LogAxis(this.id, this.position) : new NumericAxis(this.id, this.position);
    // Setting the range ends following the data, which this change is not meant to do.
    const follows = this.isAutoRange;
    this.visibleRange = this.normalizeRange(this.visibleRange);
    this.isAutoRange = follows;
    this.changed();
  }

  /** The color of missing values (NaN); transparent by default. */
  get missingColor(): Rgba8 {
    return this.missing;
  }

  set missingColor(value: Rgba8) {
    this.missing = value;
    this.changed();
  }

  /** The color of values below the range; the first color of the map when undefined. */
  get belowColor(): Rgba8 | undefined {
    return this.below;
  }

  set belowColor(value: Rgba8 | undefined) {
    this.below = value;
    this.changed();
  }

  /** The color of values above the range; the last color of the map when undefined. */
  get aboveColor(): Rgba8 | undefined {
    return this.above;
  }

  set aboveColor(value: Rgba8 | undefined) {
    this.above = value;
    this.changed();
  }

  /** {@inheritDoc Axis.scaling} */
  override get scaling(): AxisScaling | undefined {
    return this.logarithmic ? logarithm : undefined;
  }

  /** {@inheritDoc Axis.bandThickness} */
  override get bandThickness(): number {
    return barWidth;
  }

  /** How a renderer maps the values to colors. */
  rasterStyle(): RasterStyle {
    const range = this.visibleRange;
    return {
      minimum: Math.fround(range.min),
      maximum: Math.fround(range.max),
      isLogarithmic: this.logarithmic,
      missingColor: this.missing,
      ...(this.below ? { belowColor: this.below } : {}),
      ...(this.above ? { aboveColor: this.above } : {}),
    };
  }

  /** {@inheritDoc Axis.generateTicks} */
  generateTicks(length: number, measurer: TextMeasurer): TickSet {
    this.ticks.visibleRange = this.visibleRange;
    return this.ticks.generateTicks(length, measurer);
  }

  /** A logarithmic scale lifts a range at or below zero to a millionth of its top. */
  protected override normalizeRange(range: DoubleRange): DoubleRange {
    if (!this.logarithmic || range.min > 0) {
      return range;
    }
    const max = range.max > 0 ? range.max : 1;
    return new DoubleRange(max * relativeFloor, max);
  }
}
