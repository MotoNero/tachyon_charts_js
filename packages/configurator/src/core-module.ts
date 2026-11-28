// The types, interactions and samples of the core, as CoreModule and CoreTypes of the .NET version. Each type writes
// the code of its series; the preview runs that code.
import { parseColor, type ChartModule, type ChartTypeInfo, type ModifierInfo, type ParameterInfo } from './catalog';
import { camel } from './build';
import { num, rgba, str } from './code';
import { colorCode, madeWith, seriesCode } from './series-code';
import { scienceTypes } from './science-types';
import { scienceSamples } from './samples-science';
import { coreSamples } from './samples-core';
import { curveSamples } from './samples-curves';
import { flagOf, numberOf, textOf, type SeriesSpec } from './spec';

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

function builderStart(series: SeriesSpec, axes: { x: string; y: string }): string {
  return `s.name(${str(series.name)}).xAxis(${str(axes.x)}).yAxis(${str(axes.y)})`;
}

const line: ChartTypeInfo = {
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
  code(_writer, series, data, axes) {
    const values = series.parameters;
    let code = `${builderStart(series, axes)}.thickness(${num(numberOf(values, 'thickness', 1.5))})`;
    const stroke = colorCode(values, 'color');
    if (stroke) {
      code += `.stroke(${stroke})`;
    }
    const style = textOf(values, 'style', 'straight');
    code += style === 'step' ? '.step()' : style === 'spline' ? '.spline()' : '';
    const pattern = dashes[textOf(values, 'dash', 'Solid')] ?? [];
    if (pattern.length > 0) {
      code += `.dash(${pattern.map(num).join(', ')})`;
    }
    if (numberOf(values, 'glow', 0) > 0) {
      code += `.glow(${num(numberOf(values, 'glow', 0))}, ${num(numberOf(values, 'glowIntensity', 0.8))})`;
    }
    code += flagOf(values, 'lastValue') ? '.lastValue()' : '';
    code += flagOf(values, 'values') ? '.values()' : '';
    return `c.addLine(${data}, (s) => ${code});`;
  },
};

const scatter: ChartTypeInfo = {
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
  code(_writer, series, data, axes) {
    const values = series.parameters;
    let code = `${builderStart(series, axes)}.size(${num(numberOf(values, 'size', 4))})`;
    code += `.marker(${str(camel(textOf(values, 'marker', 'Circle')))})`;
    const fill = colorCode(values, 'color');
    if (fill) {
      code += `.fill(${fill})`;
    }
    const thickness = numberOf(values, 'border', 1);
    const border = colorCode(values, 'borderColor');
    if (border !== undefined || thickness !== 1) {
      code += `.border(${border ?? rgba({ r: 20, g: 50, b: 70, a: 255 })}, ${num(thickness)})`;
    }
    return `c.addScatter(${data}, (s) => ${code});`;
  },
};

const bubbles: ChartTypeInfo = {
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
  code(_writer, series, data, axes) {
    const values = series.parameters;
    let code = `${builderStart(series, axes)}.marker(${str(camel(textOf(values, 'marker', 'Circle')))}).sizes(${data}.sizes)`;
    // Only the colored grid has a color per bubble.
    if (series.data.sample === 'colorGrid') {
      code += `.colors(${data}.colors).border(${rgba({ r: 0, g: 0, b: 0, a: 0 })}, 0)`;
    }
    const fill = colorCode(values, 'color');
    if (fill) {
      code += `.fill(${fill})`;
    }
    return `c.addScatter(${data}.points, (s) => ${code});`;
  },
};

const area: ChartTypeInfo = {
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
  code(writer, series, data, axes) {
    const values = series.parameters;
    const assignments = [`baseline = ${num(numberOf(values, 'baseline', 0))}`];
    if (flagOf(values, 'values')) {
      assignments.push('showsValues = true');
    }
    const fill = colorCode(values, 'color');
    if (fill) {
      assignments.push(`fill = new ${writer.use('SolidFill')}(${fill})`);
    }
    return seriesCode(series, `new ${writer.use('AreaSeries')}(${data}, x, y)`, assignments, axes);
  },
};

const bars: ChartTypeInfo = {
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
  code(writer, series, data, axes) {
    const values = series.parameters;
    const assignments = [
      `layout = ${str(camel(textOf(values, 'layout', 'Grouped')))}`,
      `barWidth = ${num(numberOf(values, 'width', 0.8))}`,
    ];
    if (flagOf(values, 'horizontal')) {
      assignments.push('isHorizontal = true');
    }
    if (numberOf(values, 'corners', 0) !== 0) {
      assignments.push(`cornerRadius = ${num(numberOf(values, 'corners', 0))}`);
    }
    const shadow =
      colorCode(values, 'shadowColor') ?? (flagOf(values, 'shadow') ? rgba({ r: 0, g: 0, b: 0, a: 110 }) : undefined);
    if (shadow) {
      assignments.push(`shadowColor = ${shadow}`);
    }
    const from = colorCode(values, 'gradientFrom');
    const to = colorCode(values, 'gradientTo');
    if (from && to) {
      assignments.push(`fills = ${data}.map(() => new ${writer.use('PositionGradientFill')}(${from}, ${to}))`);
    }
    if (flagOf(values, 'values')) {
      assignments.push('showsValues = true');
    }
    return seriesCode(series, `new ${writer.use('BarSeries')}(${data}, x, y)`, assignments, axes);
  },
};

const heatmap: ChartTypeInfo = {
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
  code(writer, series, data, axes, index) {
    const values = series.parameters;
    const id = `values${String(index + 1)}`;
    const size = num(numberOf(values, 'size', 10));
    const before = [`const colors = ${writer.as(`axis(${str(id)})`, writer.useType('ColorAxis'))};`];
    if (flagOf(values, 'logColors')) {
      before.push('colors.isLogarithmic = true;');
    }
    const missing = colorCode(values, 'missingColor');
    if (missing) {
      before.push(`colors.missingColor = ${missing};`);
    }
    const assignments = [
      'xStart = 0',
      `xStep = ${size} / ${data}.width`,
      'yStart = 0',
      `yStep = ${size} / ${data}.height`,
    ];
    if (flagOf(values, 'interpolated')) {
      assignments.push('isInterpolated = true');
    }
    if (flagOf(values, 'values')) {
      assignments.push('showsValues = true');
    }
    const make = `new ${writer.use('HeatmapSeries')}(${data}, x, y, colors)`;
    return [
      `c.yAxis((a) => a.color(${str(textOf(values, 'colormap', 'Viridis'))}, ${str(id)}));`,
      seriesCode(series, make, assignments, axes, before),
    ].join('\n');
  },
};

const stackedArea: ChartTypeInfo = {
  id: 'stackedarea',
  name: 'Stacked area',
  category: 'twoD',
  shape: 'layers',
  defaultSample: 'threeLayers',
  parameters: [
    { name: 'percent', label: 'Share in percent', kind: 'flag', default: false },
    { name: 'colors', label: 'Colors of the layers', kind: 'text', default: '' },
  ],
  code(writer, series, data, axes) {
    const values = series.parameters;
    const assignments: string[] = [];
    if (flagOf(values, 'percent')) {
      assignments.push('isPercent = true');
    }
    const fills = textOf(values, 'colors')
      .split(',')
      .map((part) => parseColor(part.trim()))
      .filter((fill) => fill !== undefined);
    if (fills.length > 0) {
      const solid = writer.use('SolidFill');
      assignments.push(`fills = [${fills.map((fill) => `new ${solid}(${rgba(fill)})`).join(', ')}]`);
    }
    return seriesCode(series, `new ${writer.use('StackedAreaSeries')}(${data}, x, y)`, assignments, axes);
  },
};

const band: ChartTypeInfo = {
  id: 'band',
  name: 'Band',
  category: 'twoD',
  shape: 'band',
  defaultSample: 'band',
  parameters: [
    { name: 'firstAbove', label: 'Color where the first is above', kind: 'color', default: '' },
    { name: 'secondAbove', label: 'Color where the second is above', kind: 'color', default: '' },
  ],
  code(writer, series, data, axes) {
    const values = series.parameters;
    const assignments: string[] = [];
    for (const [parameter, property] of [
      ['firstAbove', 'firstAboveFill'],
      ['secondAbove', 'secondAboveFill'],
    ] as const) {
      const fill = colorCode(values, parameter);
      if (fill) {
        assignments.push(`${property} = new ${writer.use('SolidFill')}(${fill})`);
      }
    }
    return seriesCode(
      series,
      `new ${writer.use('BandSeries')}(${data}.first, ${data}.second, x, y)`,
      assignments,
      axes,
    );
  },
};

const histogram: ChartTypeInfo = {
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
  code(writer, series, data, axes) {
    const values = series.parameters;
    const rule = str(camel(textOf(values, 'rule', 'Sturges')));
    const counted = `${writer.use('computeHistogram')}(${data}, ${rule}, ${num(numberOf(values, 'parameter', 30))})`;
    return seriesCode(
      series,
      `${writer.use('BarSeries')}.fromHistogram(${counted}, x, y)`,
      [`barWidth = ${num(numberOf(values, 'width', 1))}`],
      axes,
    );
  },
};

function distribution(id: 'boxplot' | 'violin', name: string): ChartTypeInfo {
  return {
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
    code(writer, series, data, axes) {
      const values = series.parameters;
      const assignments = [`width = ${num(numberOf(values, 'width', 0.6))}`];
      const fill = colorCode(values, 'color');
      if (fill) {
        assignments.push(`fill = new ${writer.use('SolidFill')}(${fill})`);
      }
      const lineColor = colorCode(values, 'lineColor');
      if (lineColor) {
        assignments.push(`lineColor = ${lineColor}`);
      }
      const className = writer.use(id === 'boxplot' ? 'BoxPlotSeries' : 'ViolinSeries');
      return seriesCode(series, `new ${className}(${data}, x, y)`, assignments, axes);
    },
  };
}

function pieType(id: 'pie' | 'donut', name: string, hole: number): ChartTypeInfo {
  return {
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
    code(writer, series, data) {
      const values = series.parameters;
      const assignments = [
        `p.innerRadius = ${num(numberOf(values, 'innerRadius', hole))};`,
        `p.labels = ${str(camel(textOf(values, 'labels', 'NameAndPercent')))};`,
        `p.explodedIndex = ${num(numberOf(values, 'exploded', -1))};`,
        `p.explodeDistance = ${num(numberOf(values, 'explodeDistance', 0.1))};`,
        `p.gap = ${num(numberOf(values, 'gap', 1.5))};`,
      ];
      return `${writer.use('pie')}(c, ${data}.values, ${data}.names, (p) => {\n${assignments.map((item) => `  ${item}`).join('\n')}\n});`;
    },
  };
}

const plainModifier = (id: string, name: string, className: string): ModifierInfo => ({
  id,
  name,
  parameters: [],
  code: (writer) => `new ${writer.use(className)}()`,
});

const modifiers: readonly ModifierInfo[] = [
  plainModifier('zoompan', 'Zoom and pan', 'ZoomPanModifier'),
  plainModifier('rubberband', 'Zoom into a rectangle', 'RubberBandZoomModifier'),
  {
    id: 'crosshair',
    name: 'Crosshair',
    parameters: [
      { name: 'snap', label: 'Snap to the data', kind: 'flag', default: false },
      { name: 'values', label: 'Values of all series', kind: 'flag', default: false },
    ],
    code(writer, values) {
      const settings = [
        ...(flagOf(values, 'snap') ? ['snapToData = true'] : []),
        ...(flagOf(values, 'values') ? ['showsValues = true'] : []),
      ];
      return madeWith(`new ${writer.use('CrosshairModifier')}()`, 'crosshair', settings);
    },
  },
  plainModifier('tooltip', 'Tooltip', 'TooltipModifier'),
  plainModifier('rollover', 'Rollover', 'RolloverModifier'),
  plainModifier('axisdrag', 'Drag the axes', 'AxisDragModifier'),
  plainModifier('measure', 'Measuring cursors', 'MeasureCursorModifier'),
  plainModifier('keyboard', 'Keyboard', 'KeyboardNavigationModifier'),
  plainModifier('legend', 'Legend', 'LegendModifier'),
  {
    id: 'selection',
    name: 'Select points',
    parameters: [{ name: 'lasso', label: 'Lasso', kind: 'flag', default: false }],
    code(writer, values) {
      return madeWith(
        `new ${writer.use('SelectionModifier')}()`,
        'selection',
        flagOf(values, 'lasso') ? ["mode = 'lasso'"] : [],
      );
    },
  },
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
    ...scienceTypes,
  ],
  samples: [...curveSamples, ...coreSamples, ...scienceSamples],
  modifiers,
};
