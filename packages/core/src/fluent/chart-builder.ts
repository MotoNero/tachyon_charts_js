// Describes a chart in a few chained calls and builds it (ChartBuilder of the .NET version, with the same words in
// camelCase). Themes, interactions, legends and the color axis join with the tasks that bring them.
import type { Axis, AxisPosition } from '../axes/axis';
import { CategoryAxis } from '../axes/category-axis';
import { ColorAxis } from '../axes/color-axis';
import type { TimeGapMap } from '../axes/time-gaps';
import { DateTimeAxis } from '../axes/date-time-axis';
import { LogAxis, type NonPositiveValues } from '../axes/log-axis';
import { NumericAxis } from '../axes/numeric-axis';
import type { PointSource } from '../data/source';
import type { LayoutPane } from '../layout/chart-layout';
import { DoubleRange } from '../numerics/range';
import type { ChartSeries } from '../pipeline/chart-series';
import { ChartSurface } from '../pipeline/chart-surface';
import type { ChartModifier } from '../input/modifier-pipeline';
import type { ChartOverlay } from '../overlays/chart-overlay';
import { LegendModifier, LegendOverlay, type LegendPlacement } from '../overlays/legend';
import type { MarkerShape } from '../render/commands';
import type { Rgba8 } from '../render/types';
import { LineSeries } from '../series/line-series';
import { Colormap } from '../series/colormap';
import { ScatterSeries } from '../series/scatter-series';
import type { TextEngine, TextFont } from '../text/engine';
import type { ThemeDocument } from '../themes/theme-document';

/** The kinds of axes a description can ask for. */
export type AxisKind = 'numeric' | 'dateTime' | 'log' | 'category' | 'color';

/** The description of an axis. */
export interface AxisDefinition {
  /** The kind of axis. */
  readonly kind: AxisKind;
  /** The identifier series refer to. */
  readonly id: string;
  /** The names of a category axis. */
  readonly categories: readonly string[];
  /** The title beside the labels. */
  readonly title?: string;
  /** The side; bottom for X and left for Y when left out. */
  readonly position?: AxisPosition;
  /** The visible range at the start. */
  readonly range?: DoubleRange;
  /** The bounds of zooming and panning. */
  readonly limits?: DoubleRange;
  /** Whether the axis follows the data. */
  readonly isAutoRange: boolean;
  /** Whether the axis runs against its usual direction. */
  readonly isInverted: boolean;
  /** Whether the axis takes no room and draws nothing. */
  readonly isHidden: boolean;
  /** The rotation of the labels in degrees. */
  readonly labelRotation: number;
  /** The pane of a vertical axis, 0 at the top. */
  readonly pane: number;
  /** The share of the height of the pane. */
  readonly paneWeight: number;
  /** The value of the other axis where this one runs through the plot. */
  readonly crossesAt?: number;
  /** The base of a logarithmic axis. */
  readonly logBase: number;
  /** What a logarithmic axis does with values at or below zero. */
  readonly nonPositive: NonPositiveValues;
  /** The value that values at or below zero stick to on a logarithmic axis. */
  readonly logFloor?: number;
  /** The name of the built-in colormap of a color axis. */
  readonly colormap?: string;
  /** The ranges a numeric axis leaves out. */
  readonly breaks?: readonly DoubleRange[];
  /** The intervals a time axis leaves out. */
  readonly gaps?: TimeGapMap;
}

/** What all descriptions of series share. */
export interface SeriesDefinitionBase {
  /** The name shown in rollovers and legends. */
  readonly name?: string;
  /** The axes by identifier; the first X and Y axis when left out. */
  readonly xAxisId?: string;
  /** The vertical axis by identifier; the first one when left out. */
  readonly yAxisId?: string;
}

/** The description of a line. */
export interface LineDefinition extends SeriesDefinitionBase {
  /** Marks a line. */
  readonly kind: 'line';
  /** The data. */
  readonly source: PointSource;
  /** The color. */
  readonly color: Rgba8;
  /** The thickness of the line in device-independent units. */
  readonly thickness: number;
  /** Dashes and spaces in turn; a solid line when left out. */
  readonly dashPattern?: readonly number[];
  /** Whether the line keeps each value until the next point. */
  readonly isStep: boolean;
  /** Whether the line runs as a smooth curve. */
  readonly isSpline: boolean;
  /** The reach of the glow; none when left out. */
  readonly glowRadius?: number;
  /** The strength of the glow, 0..1. */
  readonly glowIntensity: number;
}

/** The description of markers. */
export interface ScatterDefinition extends SeriesDefinitionBase {
  /** Marks markers. */
  readonly kind: 'scatter';
  /** The data. */
  readonly source: PointSource;
  /** The color. */
  readonly color: Rgba8;
  /** The shape of the markers. */
  readonly shape: MarkerShape;
  /** The diameter of the markers in device-independent units. */
  readonly size: number;
  /** Diameters per point in device-independent units. */
  readonly pointSizes?: ArrayLike<number>;
  /** Fill colors per point. */
  readonly pointColors?: readonly Rgba8[];
  /** The color of the marker border. */
  readonly borderColor: Rgba8;
  /** The width of the marker border in device-independent units. */
  readonly borderThickness: number;
}

/** A series the application creates for the axes the chart gives it. */
export interface CustomSeriesDefinition extends SeriesDefinitionBase {
  /** Marks a series the application creates. */
  readonly kind: 'custom';
  /** Creates the series for the axes the chart gives it. */
  readonly factory: (xAxis: Axis, yAxis: Axis, axis: (id: string) => Axis) => ChartSeries;
}

/** The description of a series. */
export type SeriesDefinition = LineDefinition | ScatterDefinition | CustomSeriesDefinition;

/** A chart that was built: its surface, to render and to change. */
export interface BuiltChart {
  /** The chart, to render and to change. */
  readonly surface: ChartSurface;
  /** The modifiers of the description, such as dragging the marker of a Smith chart; the chart element's usual ones when empty. */
  readonly modifiers: readonly ChartModifier[];
  /** The group the chart element puts the chart in, so that it shows the same X range as the others. */
  readonly groupName?: string | undefined;
}

/** The description of a chart, independent of any framework; {@link ChartDefinition.build} makes the chart. */
export class ChartDefinition {
  constructor(
    /** The title above the plot. */
    readonly title: string | undefined,
    /** The horizontal axes. */
    readonly xAxes: readonly AxisDefinition[],
    /** The vertical axes. */
    readonly yAxes: readonly AxisDefinition[],
    /** The series, in the order they are drawn. */
    readonly series: readonly SeriesDefinition[],
    /** The font of the title. */
    readonly titleFont?: TextFont,
    /** The font of the axis labels and titles. */
    readonly axisFont?: TextFont,
    /** The theme; the colors of a chart without a theme when left out. */
    readonly theme?: ThemeDocument,
    /** Creates the overlays of the chart, such as the grid of a polar chart. */
    readonly overlays: readonly ((chart: ChartSurface) => ChartOverlay)[] = [],
    /** Creates the modifiers of the chart; the chart element's usual ones when there are none. */
    readonly modifiers: readonly (() => ChartModifier)[] = [],
    /** The group of charts with the same X range the chart element puts the chart in; none when left out. */
    readonly groupName?: string,
  ) {}

  /**
   * Creates the chart.
   * @throws RangeError when a series names an axis the chart does not have.
   */
  build(textEngine: TextEngine): BuiltChart {
    const xAxes = this.xAxes.map((axis) => createAxis(axis, 'bottom'));
    const yAxes = this.yAxes.map((axis) => createAxis(axis, 'left'));
    const surface = new ChartSurface(xAxes, this.panes(yAxes), textEngine);
    surface.title = this.title;
    surface.titleFont = this.titleFont;
    surface.axisFont = this.axisFont;
    surface.theme = this.theme;
    for (const description of this.series) {
      const x = find(xAxes, description.xAxisId, 'X');
      const y = find(yAxes, description.yAxisId, 'Y');
      const series = createSeries(description, x, y, (id) => find([...xAxes, ...yAxes], id, 'X or Y'));
      // A series made by a factory may name itself; a name from the description wins.
      if (description.name !== undefined) {
        series.name = description.name;
      }
      surface.addSeries(series);
    }
    for (const overlay of this.overlays) {
      surface.addOverlay(overlay(surface));
    }
    return { surface, modifiers: this.modifiers.map((modifier) => modifier()), groupName: this.groupName };
  }

  // Vertical axes go into the pane they name, from the top.
  private panes(yAxes: readonly Axis[]): LayoutPane[] {
    const count = this.yAxes.length === 0 ? 1 : Math.max(...this.yAxes.map((axis) => axis.pane)) + 1;
    const panes: LayoutPane[] = [];
    for (let pane = 0; pane < count; pane++) {
      const axes: Axis[] = [];
      let weight = 1;
      this.yAxes.forEach((axis, i) => {
        if (axis.pane === pane) {
          axes.push(yAxes[i] as Axis);
          weight = axis.paneWeight;
        }
      });
      panes.push({ axes, weight });
    }
    return panes;
  }
}

function createAxis(definition: AxisDefinition, fallback: AxisPosition): Axis {
  const position = definition.position ?? fallback;
  let axis: Axis;
  switch (definition.kind) {
    case 'dateTime': {
      const time = new DateTimeAxis(definition.id, position);
      time.gaps = definition.gaps;
      axis = time;
      break;
    }
    case 'category':
      axis = new CategoryAxis(definition.id, position, definition.categories);
      break;
    case 'color': {
      // Beside the plot, on the right unless the definition says left.
      const color = new ColorAxis(definition.id, definition.position ?? 'right');
      color.colormap = Colormap.builtIn(definition.colormap ?? 'Viridis');
      axis = color;
      break;
    }
    case 'log': {
      const log = new LogAxis(definition.id, position);
      log.base = definition.logBase;
      log.nonPositive = definition.nonPositive;
      if (definition.logFloor !== undefined) {
        log.floor = definition.logFloor;
      }
      axis = log;
      break;
    }
    default: {
      const numeric = new NumericAxis(definition.id, position);
      numeric.breaks = definition.breaks ?? [];
      axis = numeric;
      break;
    }
  }
  axis.title = definition.title;
  axis.limits = definition.limits;
  axis.isInverted = definition.isInverted;
  if (definition.range) {
    axis.visibleRange = definition.range;
  }
  axis.isAutoRange = definition.isAutoRange;
  axis.isHidden = definition.isHidden;
  axis.crossesAt = definition.crossesAt;
  if (definition.labelRotation !== 0) {
    axis.labelRotation = definition.labelRotation;
  }
  return axis;
}

function find(axes: readonly Axis[], id: string | undefined, kind: string): Axis {
  const axis = id === undefined ? axes[0] : axes.find((candidate) => candidate.id === id);
  if (!axis) {
    throw new RangeError(`The chart has no ${kind} axis '${id ?? ''}'.`);
  }
  return axis;
}

function createSeries(definition: SeriesDefinition, x: Axis, y: Axis, axis: (id: string) => Axis): ChartSeries {
  switch (definition.kind) {
    case 'line': {
      const line = new LineSeries(definition.source, x, y);
      line.color = definition.color;
      line.thickness = definition.thickness;
      line.dashPattern = definition.dashPattern;
      line.isStep = definition.isStep;
      line.isSpline = definition.isSpline;
      line.glowRadius = definition.glowRadius;
      line.glowIntensity = definition.glowIntensity;
      return line;
    }
    case 'scatter': {
      const scatter = new ScatterSeries(definition.source, x, y);
      scatter.color = definition.color;
      scatter.shape = definition.shape;
      scatter.size = definition.size;
      scatter.pointSizes = definition.pointSizes;
      scatter.pointColors = definition.pointColors;
      scatter.borderColor = definition.borderColor;
      scatter.borderThickness = definition.borderThickness;
      return scatter;
    }
    default:
      return definition.factory(x, y, axis);
  }
}

/** Describes an axis. */
export class AxisBuilder {
  private current: AxisDefinition;

  /** @param fallbackId - The identifier when none is given, x0, x1 … or y0, y1 …. */
  constructor(fallbackId: string) {
    this.current = {
      kind: 'numeric',
      id: fallbackId,
      categories: [],
      isAutoRange: false,
      isInverted: false,
      isHidden: false,
      labelRotation: 0,
      pane: 0,
      paneWeight: 1,
      logBase: 10,
      nonPositive: 'hide',
    };
  }

  /** The description so far. */
  get definition(): AxisDefinition {
    return this.current;
  }

  /** A numeric axis, the default. */
  numeric(id?: string): this {
    return this.change({ kind: 'numeric', id: id ?? this.current.id });
  }

  /** A time axis; it follows the data unless a range is set. */
  dateTime(id?: string): this {
    return this.change({ kind: 'dateTime', id: id ?? this.current.id, isAutoRange: true });
  }

  /** A logarithmic axis. */
  log(id?: string, logBase = 10, nonPositive: NonPositiveValues = 'hide'): this {
    return this.change({ kind: 'log', id: id ?? this.current.id, logBase, nonPositive });
  }

  /** The smallest value of a logarithmic axis that clamps. */
  floor(floor: number): this {
    return this.change({ logFloor: floor });
  }

  /**
   * A color axis beside the plot: the value scale of a heatmap, with a color bar. Put it into the pane of the heatmap
   * after its Y axis.
   */
  color(colormap = 'Viridis', id?: string): this {
    return this.change({ kind: 'color', id: id ?? this.current.id, colormap, isAutoRange: true });
  }

  /** An axis with named places. */
  category(categories: readonly string[], id?: string): this {
    return this.change({ kind: 'category', id: id ?? this.current.id, categories: [...categories] });
  }

  /** The title beside the labels. */
  title(title: string): this {
    return this.change({ title });
  }

  /** The side of the plot area. */
  position(position: AxisPosition): this {
    return this.change({ position });
  }

  /** The visible range; the axis then keeps it. */
  range(min: number, max: number): this {
    return this.change({ range: new DoubleRange(min, max), isAutoRange: false });
  }

  /** The bounds of zooming and panning. */
  limits(min: number, max: number): this {
    return this.change({ limits: new DoubleRange(min, max) });
  }

  /** The axis follows the data. */
  autoRange(): this {
    return this.change({ isAutoRange: true });
  }

  /** The axis runs against its usual direction. */
  inverted(): this {
    return this.change({ isInverted: true });
  }

  /** The axis takes no room and draws nothing; its range still maps the series. */
  hidden(): this {
    return this.change({ isHidden: true });
  }

  /** Leaves ranges out of a numeric axis, marked on the axis. */
  breaks(...breaks: DoubleRange[]): this {
    return this.change({ breaks });
  }

  /** Leaves intervals out of a time axis, such as weekends. */
  gaps(gaps: TimeGapMap): this {
    return this.change({ gaps });
  }

  /** Turns the labels of a category axis, up to 90 degrees either way. */
  labelRotation(degrees: number): this {
    return this.change({ labelRotation: degrees });
  }

  /** The value of the other axis where this one runs through the plot. */
  crossesAt(value: number): this {
    return this.change({ crossesAt: value });
  }

  /**
   * The pane of a vertical axis, 0 at the top, and its share of the height.
   * @throws RangeError when the index is negative or the weight not positive.
   */
  pane(index: number, weight = 1): this {
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError(`The pane index must not be negative, not ${String(index)}.`);
    }
    if (!(weight > 0)) {
      throw new RangeError(`The pane weight must be positive, not ${String(weight)}.`);
    }
    return this.change({ pane: index, paneWeight: weight });
  }

  private change(part: Partial<AxisDefinition>): this {
    this.current = { ...this.current, ...part };
    return this;
  }
}

/** Describes a line. */
export class LineBuilder {
  private current: LineDefinition;

  constructor(source: PointSource) {
    this.current = {
      kind: 'line',
      source,
      color: { r: 80, g: 170, b: 240, a: 255 },
      thickness: 1.5,
      isStep: false,
      isSpline: false,
      glowIntensity: 0.8,
    };
  }

  /** The description so far. */
  get definition(): LineDefinition {
    return this.current;
  }

  /** The name shown in rollovers and legends. */
  name(name: string): this {
    return this.change({ name });
  }

  /** The horizontal axis by identifier; the first one when left out. */
  xAxis(id: string): this {
    return this.change({ xAxisId: id });
  }

  /** The vertical axis by identifier; the first one when left out. */
  yAxis(id: string): this {
    return this.change({ yAxisId: id });
  }

  /** The color of the line. */
  stroke(color: Rgba8): this {
    return this.change({ color });
  }

  /** The thickness in device-independent units. */
  thickness(thickness: number): this {
    return this.change({ thickness });
  }

  /** Dashes and spaces in turn, in device-independent units. */
  dash(...lengths: number[]): this {
    return this.change({ dashPattern: lengths });
  }

  /** The line keeps each value until the next point. */
  step(): this {
    return this.change({ isStep: true });
  }

  /** The line runs as a smooth curve through its points. */
  spline(): this {
    return this.change({ isSpline: true });
  }

  /** A glow around the line: reach in device-independent units and strength 0..1. */
  glow(radius: number, intensity = 0.8): this {
    return this.change({ glowRadius: radius, glowIntensity: intensity });
  }

  private change(part: Partial<LineDefinition>): this {
    this.current = { ...this.current, ...part };
    return this;
  }
}

/** Describes markers. */
export class ScatterBuilder {
  private current: ScatterDefinition;

  constructor(source: PointSource) {
    this.current = {
      kind: 'scatter',
      source,
      color: { r: 240, g: 130, b: 90, a: 255 },
      shape: 'circle',
      size: 6,
      borderColor: { r: 20, g: 50, b: 70, a: 255 },
      borderThickness: 1,
    };
  }

  /** The description so far. */
  get definition(): ScatterDefinition {
    return this.current;
  }

  /** The name shown in rollovers and legends. */
  name(name: string): this {
    return this.change({ name });
  }

  /** The horizontal axis by identifier; the first one when left out. */
  xAxis(id: string): this {
    return this.change({ xAxisId: id });
  }

  /** The vertical axis by identifier; the first one when left out. */
  yAxis(id: string): this {
    return this.change({ yAxisId: id });
  }

  /** The fill color of the markers. */
  fill(color: Rgba8): this {
    return this.change({ color });
  }

  /** The shape of the markers. */
  marker(shape: MarkerShape): this {
    return this.change({ shape });
  }

  /** The diameter in device-independent units. */
  size(size: number): this {
    return this.change({ size });
  }

  /** Fill colors per point. */
  colors(colors: readonly Rgba8[]): this {
    return this.change({ pointColors: colors });
  }

  /** Diameters per point in device-independent units. */
  sizes(sizes: ArrayLike<number>): this {
    return this.change({ pointSizes: sizes });
  }

  /** The border of the markers: color and width in device-independent units. */
  border(color: Rgba8, thickness: number): this {
    return this.change({ borderColor: color, borderThickness: thickness });
  }

  private change(part: Partial<ScatterDefinition>): this {
    this.current = { ...this.current, ...part };
    return this;
  }
}

/**
 * Describes a chart in chained calls:
 * `new ChartBuilder().title('Pressure').xAxis((a) => a.title('Time')).yAxis((a) => a.autoRange()).addLine(source)`.
 */
export class ChartBuilder {
  private readonly xAxes: AxisDefinition[] = [];
  private readonly yAxes: AxisDefinition[] = [];
  private readonly seriesList: SeriesDefinition[] = [];
  private readonly overlayList: ((chart: ChartSurface) => ChartOverlay)[] = [];
  private readonly modifierList: (() => ChartModifier)[] = [];
  private groupName: string | undefined;
  private hasLegendModifier = false;
  private titleText: string | undefined;
  private titleTextFont: TextFont | undefined;
  private axisTextFont: TextFont | undefined;
  private themeDocument: ThemeDocument | undefined;

  /** Sets the chart title. */
  title(title: string): this {
    this.titleText = title;
    return this;
  }

  /** Sets the theme, such as `findBuiltInTheme('light')` or a theme of its own with a base. */
  theme(theme: ThemeDocument): this {
    this.themeDocument = theme;
    return this;
  }

  /** Sets the font of the title. */
  titleFont(font: TextFont): this {
    this.titleTextFont = font;
    return this;
  }

  /** Sets the font of the labels and titles of the axes. */
  axisFont(font: TextFont): this {
    this.axisTextFont = font;
    return this;
  }

  /** Adds a horizontal axis. */
  xAxis(configure: (axis: AxisBuilder) => unknown = () => undefined): this {
    this.xAxes.push(describe(configure, `x${String(this.xAxes.length)}`));
    return this;
  }

  /** Adds a vertical axis. */
  yAxis(configure: (axis: AxisBuilder) => unknown = () => undefined): this {
    this.yAxes.push(describe(configure, `y${String(this.yAxes.length)}`));
    return this;
  }

  /** Adds a line. */
  addLine(source: PointSource, configure?: (line: LineBuilder) => unknown): this {
    const builder = new LineBuilder(source);
    configure?.(builder);
    this.seriesList.push(builder.definition);
    return this;
  }

  /** Adds markers. */
  addScatter(source: PointSource, configure?: (scatter: ScatterBuilder) => unknown): this {
    const builder = new ScatterBuilder(source);
    configure?.(builder);
    this.seriesList.push(builder.definition);
    return this;
  }

  /**
   * Adds a series the application creates, such as an area or bars, for the axes the chart gives it; `axis` finds any
   * other axis by name, such as the color axis of a heatmap.
   */
  addSeries(
    factory: (xAxis: Axis, yAxis: Axis, axis: (id: string) => Axis) => ChartSeries,
    xAxis?: string,
    yAxis?: string,
  ): this {
    this.seriesList.push({
      kind: 'custom',
      factory,
      ...(xAxis === undefined ? {} : { xAxisId: xAxis }),
      ...(yAxis === undefined ? {} : { yAxisId: yAxis }),
    });
    return this;
  }

  /**
   * Finishes the description.
   * @throws RangeError without an X and a Y axis, or with an axis name used twice.
   */
  toDefinition(): ChartDefinition {
    if (this.xAxes.length === 0 || this.yAxes.length === 0) {
      throw new RangeError('A chart needs an X axis and a Y axis.');
    }
    const ids = [...this.xAxes, ...this.yAxes].map((axis) => axis.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate !== undefined) {
      throw new RangeError(`The axis name '${duplicate}' occurs twice.`);
    }
    return new ChartDefinition(
      this.titleText,
      [...this.xAxes],
      [...this.yAxes],
      [...this.seriesList],
      this.titleTextFont,
      this.axisTextFont,
      this.themeDocument,
      [...this.overlayList],
      [...this.modifierList],
      this.groupName,
    );
  }

  /**
   * Puts the chart in a group of charts that show the same X range, line up their plots and share the crosshair line;
   * an overview names the group with `OverviewModifier.of`.
   * @throws RangeError for an empty name.
   */
  group(name: string): this {
    if (name.length === 0) {
      throw new RangeError('A group needs a name.');
    }
    this.groupName = name;
    return this;
  }

  /**
   * Adds a legend of all series, or of those named, in a corner of the plot or beside it, and the modifier that
   * highlights a series under the pointer and switches it off and on with a click.
   */
  legend(configure?: (legend: LegendBuilder) => unknown): this {
    const legend = new LegendBuilder();
    configure?.(legend);
    const { placement, titleText, names } = legend;
    this.overlayList.push((chart) =>
      Object.assign(new LegendOverlay(chart), { placement, title: titleText, seriesNames: names }),
    );
    if (!this.hasLegendModifier) {
      this.hasLegendModifier = true;
      this.modifierList.push(() => new LegendModifier());
    }
    return this;
  }

  /** Adds an overlay the chart creates once it has its axes and series, such as the grid of a polar chart. */
  addOverlay(factory: (chart: ChartSurface) => ChartOverlay): this {
    this.overlayList.push(factory);
    return this;
  }

  /**
   * Adds a modifier, such as dragging the marker of a Smith chart. A description with modifiers gets exactly these in
   * the chart element, as in the .NET version; one without gets the usual zooming, panning, crosshair and tooltip.
   */
  addModifier(factory: () => ChartModifier): this {
    this.modifierList.push(factory);
    return this;
  }

  /** Finishes the description and creates the chart. */
  build(textEngine: TextEngine): BuiltChart {
    return this.toDefinition().build(textEngine);
  }
}

function describe(configure: (axis: AxisBuilder) => unknown, fallbackId: string): AxisDefinition {
  const builder = new AxisBuilder(fallbackId);
  configure(builder);
  return builder.definition;
}

/** Describes a legend. */
export class LegendBuilder {
  /** @internal The placement. */
  placement: LegendPlacement = 'topRight';
  /** @internal The title. */
  titleText: string | undefined;
  /** @internal The names of the series shown. */
  names: readonly string[] | undefined;

  /** Where the legend stands; the top right corner of the plot by default. */
  place(placement: LegendPlacement): this {
    this.placement = placement;
    return this;
  }

  /** A title above the rows. */
  title(title: string): this {
    this.titleText = title;
    return this;
  }

  /** The names of the series the legend shows; all when not called. */
  series(...names: string[]): this {
    this.names = names;
    return this;
  }
}
