// The finance and science types, as FinanceTypes and ScienceTypes of the .NET version, and the measurement types of
// CoreTypes (error bars, stems). Each type writes the code of its series; the preview runs that code.
import { parseColor, type ChartTypeInfo, type ParameterInfo, type SeriesAxes } from './catalog';
import { camel } from './build';
import { num, rgba, str, type CodeWriter } from './code';
import { colorCode, seriesCode } from './series-code';
import { flagOf, numberOf, textOf, type SeriesSpec, type SpecValues } from './spec';

const colormaps = ['Viridis', 'Inferno', 'Magma', 'Plasma', 'Turbo', 'Grayscale'];
const colormap = (standard: string): ParameterInfo => ({
  name: 'colormap',
  label: 'Colormap',
  kind: 'choice',
  default: standard,
  choices: colormaps,
});
const color: ParameterInfo = {
  name: 'color',
  label: 'Color',
  kind: 'color',
  default: '',
  description: 'Empty for the color of the theme.',
};
const thickness = (standard: number): ParameterInfo => ({
  name: 'thickness',
  label: 'Thickness',
  kind: 'number',
  default: standard,
  minimum: 0.5,
  maximum: 10,
});
const valuesParameter: ParameterInfo = {
  name: 'values',
  label: 'Show values',
  kind: 'flag',
  default: false,
  description: 'Labels with the values at the points; labels that would cover others are left out.',
};
const missingColor: ParameterInfo = {
  name: 'missingColor',
  label: 'Color of missing values',
  kind: 'color',
  default: '',
  description: 'Empty to leave them clear.',
};
const logColors: ParameterInfo = {
  name: 'logColors',
  label: 'Colors on a logarithmic scale',
  kind: 'flag',
  default: false,
};

const names = (text: string): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

// The statements that set up a color axis inside the function of a series: its scale and the color of gaps.
function colorScale(writer: CodeWriter, values: SpecValues, id: string): string[] {
  const lines = [`const colors = ${writer.as(`axis(${str(id)})`, writer.useType('ColorAxis'))};`];
  if (flagOf(values, 'logColors')) {
    lines.push('colors.isLogarithmic = true;');
  }
  const missing = colorCode(values, 'missingColor');
  if (missing) {
    lines.push(`colors.missingColor = ${missing};`);
  }
  return lines;
}

const colorAxisCode = (values: SpecValues, standard: string, id: string, range = ''): string =>
  `c.yAxis((a) => a.color(${str(textOf(values, 'colormap', standard))}, ${str(id)})${range});`;

/** Assignments of the series that every mark type shares: color and thickness. */
function markAssignments(values: SpecValues, standardThickness: number): string[] {
  const assignments = [`thickness = ${num(numberOf(values, 'thickness', standardThickness))}`];
  const chosen = colorCode(values, 'color');
  if (chosen) {
    assignments.push(`color = ${chosen}`);
  }
  return assignments;
}

const candleKinds = ['Candles', 'Ohlc'];

function drawingsCode(writer: CodeWriter, data: string, examples: boolean, patterns: boolean): string {
  const drawing = writer.use('Drawing');
  const colored = (kind: string, points: string, rgb: [number, number, number]): string =>
    `layer.add(Object.assign(new ${drawing}(${str(kind)}, ${points}), { color: ${rgba({ r: rgb[0], g: rgb[1], b: rgb[2], a: 255 })} }));`;
  const lines = [
    `const at = (day = 0, high = false) => {`,
    `  const candle = ${data}.at(day);`,
    '  return { x: candle.time, y: high ? candle.high : candle.low };',
    '};',
  ];
  if (examples) {
    lines.push(
      `if (${data}.count >= 156) {`,
      `  layer.add(new ${drawing}('fibonacciRetracement', [at(10, false), at(45, true)]));`,
      `  ${colored('trendChannel', '[at(60, false), at(95, false), at(75, true)]', [76, 201, 240])}`,
      `  ${colored('pitchfork', '[at(100, false), at(112, true), at(122, false)]', [6, 214, 160])}`,
      `  ${colored('xabcd', '[at(125, true), at(132, false), at(139, true), at(146, false), at(155, true)]', [247, 37, 133])}`,
      '}',
    );
  }
  if (patterns) {
    lines.push(
      `if (${data}.count >= 157) {`,
      `  ${colored('elliottWave', '[2, 10, 16, 28, 34, 44].map((day, i) => at(day, i % 2 !== 0))', [76, 201, 240])}`,
      `  layer.add(new ${drawing}('fibonacciExtension', [at(50, false), at(62, true), at(70, false)]));`,
      `  ${colored('headAndShoulders', '[85, 92, 98, 106, 114, 121, 128].map((day, i) => at(day, i % 2 !== 0))', [247, 37, 133])}`,
      `  ${colored('brush', `Array.from({ length: 22 }, (_, k) => ({ x: ${data}.at(135 + k).time, y: ${data}.at(135 + k).high + 1.5 + Math.sin((135 + k) * 0.6) }))`, [6, 214, 160])}`,
      '}',
    );
  }
  return `${writer.use('drawings')}(c, (layer) => {\n${lines.map((line) => `  ${line}`).join('\n')}\n});`;
}

const candles: ChartTypeInfo = {
  id: 'candles',
  name: 'Candles',
  category: 'twoD',
  shape: 'candles',
  defaultSample: 'prices',
  usesTime: true,
  parameters: [
    { name: 'style', label: 'Style', kind: 'choice', default: 'Candles', choices: candleKinds },
    { name: 'volume', label: 'Volume below', kind: 'flag', default: true },
    {
      name: 'profile',
      label: 'Market profile',
      kind: 'flag',
      default: false,
      description: 'The volume per price level of the visible days, at the right.',
    },
    { name: 'levels', label: 'Price levels of the profile', kind: 'integer', default: 40, minimum: 2, maximum: 1000 },
    {
      name: 'drawings',
      label: 'Drawing tools',
      kind: 'flag',
      default: false,
      description: 'Trend lines, channels and more, drawn with the mouse.',
    },
    {
      name: 'examples',
      label: 'Example drawings',
      kind: 'flag',
      default: false,
      description:
        'A Fibonacci retracement, a channel, a pitchfork and an XABCD pattern on the prices, to start from; with 156 days or more.',
    },
    {
      name: 'patterns',
      label: 'Example patterns',
      kind: 'flag',
      default: false,
      description:
        'An Elliott wave, a Fibonacci extension, a head and shoulders and a brush stroke on the prices; with 157 days or more.',
    },
    {
      name: 'rising',
      label: 'Rising color',
      kind: 'color',
      default: '',
      description: 'Empty for the color of the theme.',
    },
    {
      name: 'falling',
      label: 'Falling color',
      kind: 'color',
      default: '',
      description: 'Empty for the color of the theme.',
    },
    { name: 'hollow', label: 'Rising hollow', kind: 'flag', default: false },
    {
      name: 'volumeShare',
      label: 'Height of the volume',
      kind: 'number',
      default: 0.3,
      minimum: 0.05,
      maximum: 0.9,
      description: 'The share of the chart the volume takes below.',
    },
  ],
  code(writer, series, data, axes) {
    const values = series.parameters;
    const look = [`s.name = ${str(series.name)};`, `s.style = ${str(camel(textOf(values, 'style', 'Candles')))};`];
    for (const side of ['rising', 'falling'] as const) {
      const chosen = colorCode(values, side);
      if (chosen) {
        look.push(`s.${side} = { body: ${chosen}, line: ${chosen} };`);
      }
    }
    if (flagOf(values, 'hollow')) {
      look.push('s.rising = { ...s.rising, isHollow: true };');
    }
    const lines = [
      `${writer.use('candles')}(\n  c,\n  ${data},\n  (s) => {\n${look.map((line) => `    ${line}`).join('\n')}\n  },\n  ${str(axes.y)},\n);`,
    ];
    if (flagOf(values, 'volume', true)) {
      lines.push(
        `c.yAxis((a) => a.numeric('volume').title('Volume').autoRange().pane(1, ${num(numberOf(values, 'volumeShare', 0.3))}));`,
        `${writer.use('volume')}(c, ${data}, 'volume');`,
      );
    }
    if (flagOf(values, 'profile')) {
      const levels = Math.trunc(numberOf(values, 'levels', 40));
      lines.push(
        `${writer.use('volumeProfile')}(c, ${data}, (p) => {\n  p.levels = ${String(levels)};\n}, ${str(axes.y)});`,
      );
    }
    const examples = flagOf(values, 'examples');
    const patterns = flagOf(values, 'patterns');
    if (examples || patterns) {
      lines.push(drawingsCode(writer, data, examples, patterns));
    } else if (flagOf(values, 'drawings')) {
      lines.push(`${writer.use('drawings')}(c);`);
    }
    return lines.join('\n');
  },
};

const gantt: ChartTypeInfo = {
  id: 'gantt',
  name: 'Gantt',
  category: 'twoD',
  shape: 'gantt',
  defaultSample: 'plan',
  ownsAxes: true,
  takesInteractions: true,
  parameters: [
    { name: 'barHeight', label: 'Height of the bars', kind: 'number', default: 0.6, minimum: 0.05, maximum: 1 },
    {
      name: 'collapsed',
      label: 'Collapsed groups',
      kind: 'text',
      default: '',
      description: 'Names of groups that start collapsed, separated by commas.',
    },
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const lines = names(textOf(values, 'collapsed')).map((group) => `${data}.setCollapsed(${str(group)}, true);`);
    lines.push(
      "c.xAxis((a) => a.dateTime('time').autoRange());",
      `${writer.use('gantt')}(c, ${data}, (g) => {\n  g.name = ${str(series.name)};\n  g.barHeight = ${num(numberOf(values, 'barHeight', 0.6))};\n});`,
    );
    return lines.join('\n');
  },
};

const unevenHeatmap: ChartTypeInfo = {
  id: 'unevenheatmap',
  name: 'Uneven heatmap',
  category: 'twoD',
  shape: 'unevenGrid',
  defaultSample: 'decades',
  parameters: [colormap('Turbo'), missingColor, logColors, valuesParameter],
  code(writer, series, data, axes, index) {
    const values = series.parameters;
    const id = `values${String(index + 1)}`;
    const assignments = [`xEdges = ${data}.xEdges`, `yEdges = ${data}.yEdges`];
    if (flagOf(values, 'values')) {
      assignments.push('showsValues = true');
    }
    const make = `new ${writer.use('HeatmapSeries')}(${data}.data, x, y, colors)`;
    return [
      colorAxisCode(values, 'Turbo', id),
      seriesCode(series, make, assignments, axes, colorScale(writer, values, id)),
    ].join('\n');
  },
};

const maskedHeatmap: ChartTypeInfo = {
  id: 'maskedheatmap',
  name: 'Heatmap in an area',
  category: 'twoD',
  shape: 'maskedGrid',
  defaultSample: 'hillsInRegion',
  parameters: [
    colormap('Turbo'),
    { name: 'outline', label: 'Outline of the area', kind: 'flag', default: true },
    valuesParameter,
  ],
  code(writer, series, data, axes, index) {
    const values = series.parameters;
    const id = `values${String(index + 1)}`;
    const assignments = [
      'xStart = 0',
      `xStep = 10 / ${data}.data.width`,
      'yStart = 0',
      `yStep = 10 / ${data}.data.height`,
      `mask = [${data}.region]`,
    ];
    if (flagOf(values, 'values')) {
      assignments.push('showsValues = true');
    }
    const colors = `const colors = ${writer.as(`axis(${str(id)})`, writer.useType('ColorAxis'))};`;
    const lines = [
      colorAxisCode(values, 'Turbo', id),
      seriesCode(series, `new ${writer.use('HeatmapSeries')}(${data}.data, x, y, colors)`, assignments, axes, [colors]),
    ];
    if (flagOf(values, 'outline', true)) {
      lines.push(`${writer.use('polygons')}(c, [${data}.region], (s) => {\n  s.fillAlpha = 0;\n});`);
    }
    return lines.join('\n');
  },
};

const contour: ChartTypeInfo = {
  id: 'contour',
  name: 'Contour',
  category: 'twoD',
  shape: 'grid',
  defaultSample: 'hills',
  parameters: [
    colormap('Viridis'),
    { name: 'from', label: 'First level', kind: 'number', default: 0 },
    { name: 'to', label: 'Last level', kind: 'number', default: 1 },
    { name: 'levels', label: 'Number of levels', kind: 'integer', default: 11, minimum: 2, maximum: 100 },
    { name: 'filled', label: 'Filled', kind: 'flag', default: true },
    { name: 'lines', label: 'Lines', kind: 'flag', default: true },
    { name: 'labels', label: 'Labels on the lines', kind: 'flag', default: true },
    {
      name: 'size',
      label: 'Extent',
      kind: 'number',
      default: 10,
      minimum: 1e-9,
      description: 'The grid covers 0 to this value on both axes.',
    },
  ],
  code(writer, series, data, axes, index) {
    const values = series.parameters;
    const id = `values${String(index + 1)}`;
    const from = numberOf(values, 'from', 0);
    const to = numberOf(values, 'to', 1);
    const count = Math.max(2, Math.trunc(numberOf(values, 'levels', 11)));
    const levels = Array.from({ length: count }, (_, i) => from + (i * (to - from)) / (count - 1));
    const size = num(numberOf(values, 'size', 10));
    const assignments = [
      `xStep = ${size} / ${data}.width`,
      `yStep = ${size} / ${data}.height`,
      `levels = [${levels.map(num).join(', ')}]`,
    ];
    if (flagOf(values, 'filled', true)) {
      assignments.push('isFilled = true');
    }
    if (!flagOf(values, 'lines', true)) {
      assignments.push('showsLines = false');
    }
    if (flagOf(values, 'labels', true)) {
      assignments.push('showsLabels = true');
    }
    const colors = `const colors = ${writer.as(`axis(${str(id)})`, writer.useType('ColorAxis'))};`;
    return [
      colorAxisCode(values, 'Viridis', id),
      seriesCode(series, `new ${writer.use('ContourSeries')}(${data}, x, y, colors)`, assignments, axes, [colors]),
    ].join('\n');
  },
};

function rangeCode(values: SpecValues): string {
  const parts = textOf(values, 'colorRange')
    .split('..')
    .map((part) => part.trim());
  const from = Number(parts[0]);
  const to = Number(parts[1]);
  return parts.length === 2 && parts[0] !== '' && Number.isFinite(from) && Number.isFinite(to) && to > from
    ? `.range(${num(from)}, ${num(to)})`
    : '';
}

const spectrogram: ChartTypeInfo = {
  id: 'spectrogram',
  name: 'Spectrogram',
  category: 'twoD',
  shape: 'spectrogram',
  defaultSample: 'steadyTone',
  parameters: [
    colormap('Plasma'),
    {
      name: 'colorRange',
      label: 'Range of the colors',
      kind: 'text',
      default: '',
      description: 'From..to, for example -0.1..1.1; empty to follow the values.',
    },
    missingColor,
  ],
  code(writer, series, data, axes, index) {
    const values = series.parameters;
    const id = `values${String(index + 1)}`;
    const make = `new ${writer.use('SpectrogramSeries')}(${data}, x, y, colors)`;
    return [
      colorAxisCode(values, 'Plasma', id, rangeCode(values)),
      seriesCode(series, make, [], axes, colorScale(writer, values, id)),
    ].join('\n');
  },
};

const polarParts = ['Line', 'Area', 'Markers', 'Area, Line', 'Line, Markers', 'Area, Line, Markers'];

function polarCode(
  writer: CodeWriter,
  series: SeriesSpec,
  make: string,
  assignments: string[],
  radius: number,
  spokes: string,
): string {
  const all = [...(series.name.length > 0 ? [`name = ${str(series.name)}`] : []), ...assignments];
  return [
    `${writer.use('polar')}(c, ${num(radius)}, ${spokes}, (x, y) => {`,
    `  const series = ${make};`,
    ...all.map((line) => `  series.${line};`),
    '  return series;',
    '});',
  ].join('\n');
}

const polarType: ChartTypeInfo = {
  id: 'polar',
  name: 'Polar',
  category: 'twoD',
  shape: 'polar',
  defaultSample: 'lobe',
  ownsAxes: true,
  parameters: [
    { name: 'radius', label: 'Outer ring', kind: 'number', default: 10, minimum: 1e-9 },
    {
      name: 'spokes',
      label: 'Spokes',
      kind: 'integer',
      default: 12,
      minimum: 3,
      maximum: 72,
      description: 'Lines from the middle, evenly around, named by their angle.',
    },
    { name: 'parts', label: 'Show', kind: 'choice', default: 'Line', choices: polarParts },
    { name: 'closed', label: 'Closed', kind: 'flag', default: false },
    thickness(1.5),
    { ...color, description: 'Empty for the color of the type.' },
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const count = Math.min(Math.max(Math.trunc(numberOf(values, 'spokes', 12)), 3), 72);
    const spokes = Array.from({ length: count }, (_, i) => `${String(Math.round(((i * 360) / count) * 10) / 10)}°`);
    const parts = names(textOf(values, 'parts', 'Line')).map((part) => `${part.toLowerCase()}: true`);
    const assignments = [`parts = { ${parts.join(', ')} }`];
    if (flagOf(values, 'closed')) {
      assignments.push('isClosed = true');
    }
    assignments.push(...markAssignments(values, 1.5));
    const make = `new ${writer.use('PolarSeries')}(${data}.angles, ${data}.values, x, y)`;
    return polarCode(
      writer,
      series,
      make,
      assignments,
      numberOf(values, 'radius', 10),
      `[${spokes.map(str).join(', ')}]`,
    );
  },
};

const radar: ChartTypeInfo = {
  id: 'radar',
  name: 'Radar',
  category: 'twoD',
  shape: 'slices',
  defaultSample: 'scores',
  ownsAxes: true,
  parameters: [
    { name: 'radius', label: 'Outer ring', kind: 'number', default: 40, minimum: 1e-9 },
    thickness(1.5),
    { ...color, description: 'Empty for the color of the type.' },
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const make = `${writer.use('PolarSeries')}.radar(${data}.values, x, y)`;
    return polarCode(
      writer,
      series,
      make,
      markAssignments(values, 1.5),
      numberOf(values, 'radius', 40),
      `${data}.names`,
    );
  },
};

const ternaryType: ChartTypeInfo = {
  id: 'ternary',
  name: 'Ternary',
  category: 'twoD',
  shape: 'ternary',
  defaultSample: 'randomMixture',
  ownsAxes: true,
  parameters: [
    { name: 'top', label: 'Top corner', kind: 'text', default: 'A' },
    { name: 'left', label: 'Left corner', kind: 'text', default: 'B' },
    { name: 'right', label: 'Right corner', kind: 'text', default: 'C' },
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const corners = [textOf(values, 'top', 'A'), textOf(values, 'left', 'B'), textOf(values, 'right', 'C')];
    return `${writer.use('ternary')}(c, ${data}.a, ${data}.b, ${data}.c, [${corners.map(str).join(', ')}]);`;
  },
};

const smithType: ChartTypeInfo = {
  id: 'smith',
  name: 'Smith chart',
  category: 'twoD',
  shape: 'smith',
  defaultSample: 'seriesCircuit',
  ownsAxes: true,
  parameters: [
    {
      name: 'marker',
      label: 'Marker at point',
      kind: 'integer',
      default: 100,
      minimum: -1,
      maximum: 10_000_000,
      description: '-1 for none.',
    },
    { name: 'reference', label: 'Reference impedance in Ω', kind: 'number', default: 50, minimum: 1e-9 },
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const marker = Math.trunc(numberOf(values, 'marker', 100));
    return `${writer.use('smith')}(c, ${data}.resistance, ${data}.reactance, Math.min(${String(marker)}, ${data}.resistance.length - 1), ${num(numberOf(values, 'reference', 50))});`;
  },
};

const parallel: ChartTypeInfo = {
  id: 'parallel',
  name: 'Parallel coordinates',
  category: 'twoD',
  shape: 'groups',
  defaultSample: 'sixColumns',
  ownsAxes: true,
  parameters: [
    {
      name: 'names',
      label: 'Names of the columns',
      kind: 'text',
      default: 'Speed, Price, Quality, Service, Range',
      description: 'One per column, separated by commas.',
    },
    { ...color, description: 'Empty for the color of the type.' },
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const list = `[${names(textOf(values, 'names')).map(str).join(', ')}]`;
    const chosen = parseColor(textOf(values, 'color'));
    return `${writer.use('parallelCoordinates')}(c, ${data}, ${list}${chosen ? `, ${rgba(chosen)}` : ''});`;
  },
};

const polygonType: ChartTypeInfo = {
  id: 'polygons',
  name: 'Polygons',
  category: 'twoD',
  shape: 'polygons',
  defaultSample: 'holedShapes',
  parameters: [
    thickness(1.5),
    { name: 'fill', label: 'Fill opacity', kind: 'integer', default: 160, minimum: 0, maximum: 255 },
  ],
  code(writer, series, data, axes) {
    const values = series.parameters;
    const assignments = [
      `thickness = ${num(numberOf(values, 'thickness', 1.5))}`,
      `fillAlpha = ${String(Math.trunc(numberOf(values, 'fill', 160)))}`,
    ];
    return seriesCode(series, `new ${writer.use('PolygonSeries')}(${data}, x, y)`, assignments, axes);
  },
};

const errorBars: ChartTypeInfo = {
  id: 'errorbars',
  name: 'Error bars',
  category: 'twoD',
  shape: 'errors',
  defaultSample: 'fiveErrors',
  parameters: [
    { name: 'capWidth', label: 'Width of the caps', kind: 'number', default: 8, minimum: 0, maximum: 40 },
    { name: 'pointSize', label: 'Size of the points', kind: 'number', default: 5, minimum: 0, maximum: 30 },
    thickness(1),
    color,
    valuesParameter,
  ],
  code(writer, series, data, axes: SeriesAxes) {
    const values = series.parameters;
    const assignments = [
      `capWidth = ${num(numberOf(values, 'capWidth', 8))}`,
      `pointSize = ${num(numberOf(values, 'pointSize', 5))}`,
      ...markAssignments(values, 1),
    ];
    if (flagOf(values, 'values')) {
      assignments.push('showsValues = true');
    }
    const make = `new ${writer.use('ErrorBarSeries')}(${data}.values, ${data}.lower, ${data}.upper, x, y)`;
    return seriesCode(series, make, assignments, axes);
  },
};

const stems: ChartTypeInfo = {
  id: 'stems',
  name: 'Stems',
  category: 'twoD',
  shape: 'points',
  defaultSample: 'fadingPulses',
  parameters: [
    { name: 'baseline', label: 'Baseline', kind: 'number', default: 0 },
    { name: 'headSize', label: 'Size of the heads', kind: 'number', default: 6, minimum: 0, maximum: 30 },
    thickness(1),
    color,
    valuesParameter,
  ],
  code(writer, series, data, axes) {
    const values = series.parameters;
    const assignments = [
      `baseline = ${num(numberOf(values, 'baseline', 0))}`,
      `headSize = ${num(numberOf(values, 'headSize', 6))}`,
      ...markAssignments(values, 1),
    ];
    if (flagOf(values, 'values')) {
      assignments.push('showsValues = true');
    }
    return seriesCode(series, `new ${writer.use('StemSeries')}(${data}, x, y)`, assignments, axes);
  },
};

/** The finance, science and measurement types. */
export const scienceTypes: readonly ChartTypeInfo[] = [
  candles,
  gantt,
  errorBars,
  stems,
  unevenHeatmap,
  maskedHeatmap,
  contour,
  spectrogram,
  polarType,
  radar,
  ternaryType,
  smithType,
  parallel,
  polygonType,
];
