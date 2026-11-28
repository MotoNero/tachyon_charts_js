// The types, interactions and samples of the core, as CoreModule and CoreTypes of the .NET version.
import {
  AreaSeries,
  AxisDragModifier,
  BandSeries,
  BarSeries,
  BoxPlotSeries,
  ColorAxis,
  Colormap,
  computeHistogram,
  CrosshairModifier,
  DataSource,
  HeatmapData,
  HeatmapSeries,
  KeyboardNavigationModifier,
  LegendModifier,
  MeasureCursorModifier,
  PositionGradientFill,
  RolloverModifier,
  RubberBandZoomModifier,
  SeededRandom,
  SelectionModifier,
  SolidFill,
  StackedAreaSeries,
  TooltipModifier,
  ViolinSeries,
  ZoomPanModifier,
  pie,
  type BarLayout,
  type BinningRule,
  type MarkerShape,
  type PieLabels,
  type Rgba8,
} from '@tachyon-charts/core';
import {
  parseColor,
  sampleScope,
  type ChartModule,
  type ChartTypeInfo,
  type ModifierInfo,
  type ParameterInfo,
} from './catalog';
import { coreSamples } from './samples-core';
import { curveSamples } from './samples-curves';
import { flagOf, numberOf, textOf, type SpecValues } from './spec';

// Math.Round of .NET: halves to the even neighbour.
function round(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  return rest === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}

Object.assign(sampleScope, { DataSource, HeatmapData, SeededRandom, round });

/** A name of the .NET version, such as NameAndPercent, as the JS version spells it, nameAndPercent. */
export function camel(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

const dashes: Record<string, readonly number[]> = {
  Solid: [],
  Dashed: [8, 4],
  Dotted: [2, 3],
  'Dash dot': [8, 3, 2, 3],
  'Long dashes': [10, 6],
  'Sparse dots': [1, 7],
  'Long dash dot': [16, 4, 4, 4],
};
const colormaps = ['Viridis', 'Inferno', 'Magma', 'Plasma', 'Turbo', 'Grayscale'];
const markers = ['Circle', 'Square', 'Triangle', 'Diamond', 'Cross', 'Plus'];
const color: ParameterInfo = {
  name: 'color',
  label: 'Color',
  kind: 'color',
  default: '',
  description: 'Empty for the color of the theme.',
};
const valuesParameter: ParameterInfo = {
  name: 'values',
  label: 'Show values',
  kind: 'flag',
  default: false,
  description: 'Labels with the values at the points; labels that would cover others are left out.',
};

const colorOf = (values: SpecValues, name: string): Rgba8 | undefined => parseColor(textOf(values, name));

function type(info: ChartTypeInfo): ChartTypeInfo {
  return info;
}

const line = type({
  id: 'line',
  name: 'Line',
  category: 'twoD',
  shape: 'points',
  defaultSample: 'sine',
  parameters: [
    { name: 'thickness', label: 'Thickness', kind: 'number', default: 1.5, minimum: 0.5, maximum: 10 },
    color,
    { name: 'style', label: 'Style', kind: 'choice', default: 'straight', choices: ['straight', 'step', 'spline'] },
    { name: 'dash', label: 'Dashes', kind: 'choice', default: 'Solid', choices: Object.keys(dashes) },
    { name: 'glow', label: 'Glow radius', kind: 'number', default: 0, minimum: 0, maximum: 40 },
    { name: 'glowIntensity', label: 'Glow intensity', kind: 'number', default: 0.8, minimum: 0, maximum: 1 },
    { name: 'lastValue', label: 'Last value at the axis', kind: 'flag', default: false },
    valuesParameter,
  ],
  apply(chart, series, data, axes) {
    const values = series.parameters;
    chart.addLine(data as DataSource, (l) => {
      l.name(series.name)
        .xAxis(axes.x)
        .yAxis(axes.y)
        .thickness(numberOf(values, 'thickness', 1.5));
      const stroke = colorOf(values, 'color');
      if (stroke) {
        l.stroke(stroke);
      }
      const style = textOf(values, 'style', 'straight');
      if (style === 'step') {
        l.step();
      } else if (style === 'spline') {
        l.spline();
      }
      const pattern = dashes[textOf(values, 'dash', 'Solid')] ?? [];
      if (pattern.length > 0) {
        l.dash(...pattern);
      }
      if (numberOf(values, 'glow', 0) > 0) {
        l.glow(numberOf(values, 'glow', 0), numberOf(values, 'glowIntensity', 0.8));
      }
      if (flagOf(values, 'lastValue')) {
        l.lastValue();
      }
      if (flagOf(values, 'values')) {
        l.values();
      }
    });
  },
});

const scatter = type({
  id: 'scatter',
  name: 'Scatter',
  category: 'twoD',
  shape: 'points',
  defaultSample: 'signal',
  parameters: [
    { name: 'size', label: 'Size', kind: 'number', default: 4, minimum: 1, maximum: 30 },
    { name: 'marker', label: 'Marker', kind: 'choice', default: 'Circle', choices: markers },
    color,
    { name: 'density', label: 'Density colors', kind: 'flag', default: false },
    {
      name: 'densityColormap',
      label: 'Colormap of the density',
      kind: 'choice',
      default: 'Viridis',
      choices: colormaps,
    },
    { name: 'borderColor', label: 'Border color', kind: 'color', default: '' },
    { name: 'border', label: 'Border thickness', kind: 'number', default: 1, minimum: 0, maximum: 10 },
    valuesParameter,
  ],
  apply(chart, series, data, axes) {
    const values = series.parameters;
    chart.addScatter(data as DataSource, (s) => {
      s.name(series.name)
        .xAxis(axes.x)
        .yAxis(axes.y)
        .size(numberOf(values, 'size', 4))
        .marker(camel(textOf(values, 'marker', 'Circle')) as MarkerShape);
      const fill = colorOf(values, 'color');
      if (fill) {
        s.fill(fill);
      }
      const thickness = numberOf(values, 'border', 1);
      const border = colorOf(values, 'borderColor');
      if (border || thickness !== 1) {
        s.border(border ?? { r: 20, g: 50, b: 70, a: 255 }, thickness);
      }
    });
  },
});

const bubbles = type({
  id: 'bubbles',
  name: 'Bubbles',
  category: 'twoD',
  shape: 'bubbles',
  defaultSample: 'cloudSizes',
  parameters: [
    { name: 'marker', label: 'Marker', kind: 'choice', default: 'Circle', choices: markers },
    color,
    valuesParameter,
  ],
  apply(chart, series, data, axes) {
    const values = series.parameters;
    const bubble = data as { points: DataSource; sizes: Float32Array; colors?: Rgba8[] };
    chart.addScatter(bubble.points, (s) => {
      s.name(series.name)
        .xAxis(axes.x)
        .yAxis(axes.y)
        .marker(camel(textOf(values, 'marker', 'Circle')) as MarkerShape)
        .sizes(bubble.sizes);
      if (bubble.colors) {
        s.colors(bubble.colors).border({ r: 0, g: 0, b: 0, a: 0 }, 0);
      }
      const fill = colorOf(values, 'color');
      if (fill) {
        s.fill(fill);
      }
    });
  },
});

const area = type({
  id: 'area',
  name: 'Area',
  category: 'twoD',
  shape: 'points',
  defaultSample: 'damped',
  parameters: [
    { name: 'baseline', label: 'Baseline', kind: 'number', default: 0 },
    { name: 'valueColors', label: 'Colors by value', kind: 'flag', default: false },
    { name: 'colormap', label: 'Colormap', kind: 'choice', default: 'Turbo', choices: colormaps },
    { name: 'colorFrom', label: 'Lowest color at', kind: 'number', default: -1 },
    { name: 'colorTo', label: 'Highest color at', kind: 'number', default: 1 },
    color,
    valuesParameter,
  ],
  apply(chart, series, data, axes) {
    const values = series.parameters;
    chart.addSeries(
      (x, y) => {
        const series2 = new AreaSeries(data as DataSource, x, y);
        series2.name = series.name;
        series2.baseline = numberOf(values, 'baseline', 0);
        series2.showsValues = flagOf(values, 'values');
        const fill = colorOf(values, 'color');
        if (fill) {
          series2.fill = new SolidFill(fill);
        }
        return series2;
      },
      axes.x,
      axes.y,
    );
  },
});

const bars = type({
  id: 'bars',
  name: 'Bars',
  category: 'twoD',
  shape: 'rows',
  defaultSample: 'barRows',
  parameters: [
    { name: 'layout', label: 'Layout', kind: 'choice', default: 'Grouped', choices: ['Grouped', 'Stacked', 'Percent'] },
    { name: 'width', label: 'Width', kind: 'number', default: 0.8, minimum: 0.05, maximum: 1 },
    { name: 'horizontal', label: 'Horizontal', kind: 'flag', default: false },
    { name: 'corners', label: 'Corner radius', kind: 'number', default: 0, minimum: 0, maximum: 30 },
    { name: 'shadow', label: 'Soft shadow', kind: 'flag', default: false },
    { name: 'shadowColor', label: 'Shadow color', kind: 'color', default: '' },
    { name: 'gradientFrom', label: 'Gradient from', kind: 'color', default: '' },
    { name: 'gradientTo', label: 'Gradient to', kind: 'color', default: '' },
    valuesParameter,
  ],
  apply(chart, series, data, axes) {
    const values = series.parameters;
    const rowsOf = data as number[][];
    chart.addSeries(
      (x, y) => {
        const series2 = new BarSeries(rowsOf, x, y);
        series2.name = series.name;
        series2.layout = camel(textOf(values, 'layout', 'Grouped')) as BarLayout;
        series2.barWidth = numberOf(values, 'width', 0.8);
        series2.isHorizontal = flagOf(values, 'horizontal');
        series2.cornerRadius = numberOf(values, 'corners', 0);
        const shadow =
          colorOf(values, 'shadowColor') ?? (flagOf(values, 'shadow') ? { r: 0, g: 0, b: 0, a: 110 } : undefined);
        if (shadow) {
          series2.shadowColor = shadow;
        }
        const from = colorOf(values, 'gradientFrom');
        const to = colorOf(values, 'gradientTo');
        if (from && to) {
          series2.fills = rowsOf.map(() => new PositionGradientFill(from, to));
        }
        series2.showsValues = flagOf(values, 'values');
        return series2;
      },
      axes.x,
      axes.y,
    );
  },
});

let colorAxes = 0;

const heatmap = type({
  id: 'heatmap',
  name: 'Heatmap',
  category: 'twoD',
  shape: 'grid',
  defaultSample: 'fineField',
  parameters: [
    { name: 'colormap', label: 'Colormap', kind: 'choice', default: 'Viridis', choices: colormaps },
    { name: 'interpolated', label: 'Smooth', kind: 'flag', default: false },
    { name: 'size', label: 'Extent', kind: 'number', default: 10, minimum: 1e-9 },
    { name: 'missingColor', label: 'Color of missing values', kind: 'color', default: '' },
    { name: 'logColors', label: 'Colors on a logarithmic scale', kind: 'flag', default: false },
    valuesParameter,
  ],
  apply(chart, series, data, axes) {
    const values = series.parameters;
    const grid = data as HeatmapData;
    const id = `values-${String(++colorAxes)}`;
    const size = numberOf(values, 'size', 10);
    chart.yAxis((axis) => axis.color(textOf(values, 'colormap', 'Viridis'), id));
    chart.addSeries(
      (x, y, axis) => {
        const colors = axis(id) as ColorAxis;
        if (flagOf(values, 'logColors')) {
          colors.isLogarithmic = true;
        }
        const missing = colorOf(values, 'missingColor');
        if (missing) {
          colors.missingColor = missing;
        }
        const series2 = new HeatmapSeries(grid, x, y, colors);
        series2.name = series.name;
        series2.xStart = 0;
        series2.xStep = size / grid.width;
        series2.yStart = 0;
        series2.yStep = size / grid.height;
        series2.isInterpolated = flagOf(values, 'interpolated');
        series2.showsValues = flagOf(values, 'values');
        return series2;
      },
      axes.x,
      axes.y,
    );
  },
});

const stackedArea = type({
  id: 'stackedarea',
  name: 'Stacked area',
  category: 'twoD',
  shape: 'layers',
  defaultSample: 'threeLayers',
  parameters: [
    { name: 'percent', label: 'Share in percent', kind: 'flag', default: false },
    { name: 'colors', label: 'Colors of the layers', kind: 'text', default: '' },
  ],
  apply(chart, series, data, axes) {
    const values = series.parameters;
    chart.addSeries(
      (x, y) => {
        const series2 = new StackedAreaSeries(data as DataSource[], x, y);
        series2.name = series.name;
        series2.isPercent = flagOf(values, 'percent');
        const fills = textOf(values, 'colors')
          .split(',')
          .map((part) => parseColor(part.trim()))
          .filter((fill): fill is Rgba8 => fill !== undefined);
        if (fills.length > 0) {
          series2.fills = fills.map((fill) => new SolidFill(fill));
        }
        return series2;
      },
      axes.x,
      axes.y,
    );
  },
});

const band = type({
  id: 'band',
  name: 'Band',
  category: 'twoD',
  shape: 'band',
  defaultSample: 'band',
  parameters: [
    { name: 'firstAbove', label: 'Color where the first is above', kind: 'color', default: '' },
    { name: 'secondAbove', label: 'Color where the second is above', kind: 'color', default: '' },
  ],
  apply(chart, series, data, axes) {
    const values = series.parameters;
    const pair = data as { first: DataSource; second: DataSource };
    chart.addSeries(
      (x, y) => {
        const series2 = new BandSeries(pair.first, pair.second, x, y);
        series2.name = series.name;
        const first = colorOf(values, 'firstAbove');
        const second = colorOf(values, 'secondAbove');
        if (first) {
          series2.firstAboveFill = new SolidFill(first);
        }
        if (second) {
          series2.secondAboveFill = new SolidFill(second);
        }
        return series2;
      },
      axes.x,
      axes.y,
    );
  },
});

const histogram = type({
  id: 'histogram',
  name: 'Histogram',
  category: 'twoD',
  shape: 'values',
  defaultSample: 'exponential',
  parameters: [
    {
      name: 'rule',
      label: 'Bins',
      kind: 'choice',
      default: 'Sturges',
      choices: ['FixedCount', 'FixedWidth', 'Sturges', 'FreedmanDiaconis'],
    },
    { name: 'parameter', label: 'Count or width', kind: 'number', default: 30, minimum: 0.001, maximum: 10000 },
    { name: 'width', label: 'Width', kind: 'number', default: 1, minimum: 0.05, maximum: 1 },
  ],
  apply(chart, series, data, axes) {
    const values = series.parameters;
    chart.addSeries(
      (x, y) => {
        const counted = computeHistogram(
          data as Float64Array,
          camel(textOf(values, 'rule', 'Sturges')) as BinningRule,
          numberOf(values, 'parameter', 30),
        );
        const series2 = BarSeries.fromHistogram(counted, x, y);
        series2.name = series.name;
        series2.barWidth = numberOf(values, 'width', 1);
        return series2;
      },
      axes.x,
      axes.y,
    );
  },
});

function distribution(id: 'boxplot' | 'violin', name: string): ChartTypeInfo {
  return type({
    id,
    name,
    category: 'twoD',
    shape: 'groups',
    defaultSample: 'threeGroups',
    parameters: [
      { name: 'width', label: 'Width', kind: 'number', default: 0.6, minimum: 0.05, maximum: 1 },
      { name: 'color', label: 'Fill', kind: 'color', default: '' },
      { name: 'lineColor', label: 'Line color', kind: 'color', default: '' },
    ],
    apply(chart, series, data, axes) {
      const values = series.parameters;
      chart.addSeries(
        (x, y) => {
          const groups = data as number[][];
          const series2 = id === 'boxplot' ? new BoxPlotSeries(groups, x, y) : new ViolinSeries(groups, x, y);
          series2.name = series.name;
          series2.width = numberOf(values, 'width', 0.6);
          const fill = colorOf(values, 'color');
          const lineColor = colorOf(values, 'lineColor');
          if (fill) {
            series2.fill = new SolidFill(fill);
          }
          if (lineColor) {
            series2.lineColor = lineColor;
          }
          return series2;
        },
        axes.x,
        axes.y,
      );
    },
  });
}

function pieType(id: 'pie' | 'donut', name: string, hole: number): ChartTypeInfo {
  return type({
    id,
    name,
    category: 'twoD',
    shape: 'slices',
    defaultSample: 'tenSources',
    ownsAxes: true,
    parameters: [
      { name: 'innerRadius', label: 'Hole', kind: 'number', default: hole, minimum: 0, maximum: 0.95 },
      {
        name: 'labels',
        label: 'Labels',
        kind: 'choice',
        default: 'NameAndPercent',
        choices: ['None', 'Name', 'Percent', 'Value', 'NameAndPercent'],
      },
      { name: 'exploded', label: 'Slice pulled out', kind: 'integer', default: -1, minimum: -1, maximum: 100 },
      { name: 'explodeDistance', label: 'Pulled out by', kind: 'number', default: 0.1, minimum: 0, maximum: 0.5 },
      { name: 'gap', label: 'Gap', kind: 'number', default: 1.5, minimum: 0, maximum: 10 },
    ],
    apply(chart, series, data) {
      const values = series.parameters;
      const slices = data as { values: number[]; names: string[] };
      pie(chart, slices.values, slices.names, (p) => {
        p.innerRadius = numberOf(values, 'innerRadius', hole);
        p.labels = camel(textOf(values, 'labels', 'NameAndPercent')) as PieLabels;
        p.explodedIndex = numberOf(values, 'exploded', -1);
        p.explodeDistance = numberOf(values, 'explodeDistance', 0.1);
        p.gap = numberOf(values, 'gap', 1.5);
      });
    },
  });
}

const modifier = (
  id: string,
  name: string,
  create: (values: SpecValues) => ModifierInfo['create'] extends (v: SpecValues) => infer R ? R : never,
  parameters: readonly ParameterInfo[] = [],
): ModifierInfo => ({
  id,
  name,
  parameters,
  create,
});

const modifiers: readonly ModifierInfo[] = [
  modifier('zoompan', 'Zoom and pan', () => new ZoomPanModifier()),
  modifier('rubberband', 'Zoom into a rectangle', () => new RubberBandZoomModifier()),
  modifier(
    'crosshair',
    'Crosshair',
    (values) => {
      const crosshair = new CrosshairModifier();
      crosshair.snapToData = flagOf(values, 'snap');
      crosshair.showsValues = flagOf(values, 'values');
      return crosshair;
    },
    [
      { name: 'snap', label: 'Snap to the data', kind: 'flag', default: false },
      { name: 'values', label: 'Values of all series', kind: 'flag', default: false },
    ],
  ),
  modifier('tooltip', 'Tooltip', () => new TooltipModifier()),
  modifier('rollover', 'Rollover', () => new RolloverModifier()),
  modifier('axisdrag', 'Drag the axes', () => new AxisDragModifier()),
  modifier('measure', 'Measuring cursors', () => new MeasureCursorModifier()),
  modifier('keyboard', 'Keyboard', () => new KeyboardNavigationModifier()),
  modifier('legend', 'Legend', () => new LegendModifier()),
  modifier(
    'selection',
    'Select points',
    (values) => {
      const selection = new SelectionModifier();
      if (flagOf(values, 'lasso')) {
        selection.mode = 'lasso';
      }
      return selection;
    },
    [{ name: 'lasso', label: 'Lasso', kind: 'flag', default: false }],
  ),
];

/** The core module: the 2D types, the interactions and their samples. */
export const coreModule: ChartModule = {
  types: [
    line,
    scatter,
    bubbles,
    area,
    stackedArea,
    band,
    bars,
    histogram,
    distribution('boxplot', 'Box plot'),
    distribution('violin', 'Violin'),
    pieType('pie', 'Pie', 0),
    pieType('donut', 'Donut', 0.55),
    heatmap,
  ],
  samples: [...curveSamples, ...coreSamples],
  modifiers,
};

/** @internal The colormaps of the configurator by name. */
export function colormapOf(name: string): Colormap {
  return Colormap.builtIn(name);
}
