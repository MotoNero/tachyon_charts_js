// The 3D charts of the configurator, as ThreeDModule of the .NET version: one scene per chart with its camera, the
// ranges and titles of the box and cut planes; the series of the 3D types go into it.
import type { ChartModule, ChartTypeInfo, ParameterInfo, SampleInfo, SceneSetup, SeriesAxes } from './catalog';
import { camel } from './build';
import { num, rgba, str, type CodeWriter } from './code';
import { spectrumSettings, spectrumSetup } from './instrument-types';
import { samples3D } from './samples-3d';
import { modelSamples3D } from './samples-models-3d';
import { colorCode } from './series-code';
import { flagOf, numberOf, textOf, type SeriesSpec, type SpecValues } from './spec';

const threeD = '@tachyon-charts/3d';
const colormaps = ['Viridis', 'Inferno', 'Magma', 'Plasma', 'Turbo', 'Grayscale'];
const red = { r: 255, g: 70, b: 70, a: 255 };

const colormap = (standard: string): ParameterInfo => ({
  name: 'colormap',
  label: 'Colormap',
  kind: 'choice',
  default: standard,
  choices: colormaps,
});
const lit: ParameterInfo = { name: 'lit', label: 'Light', kind: 'flag', default: true };
const opacity: ParameterInfo = {
  name: 'opacity',
  label: 'Opacity',
  kind: 'number',
  default: 1,
  minimum: 0.05,
  maximum: 1,
};
const color: ParameterInfo = {
  name: 'color',
  label: 'Color',
  kind: 'color',
  default: '',
  description: 'Empty for the color of the type.',
};
const extent: ParameterInfo = {
  name: 'size',
  label: 'Extent',
  kind: 'number',
  default: 10,
  minimum: 1e-6,
  description: 'The grid covers 0 to this value across and along.',
};
const heights = (from: number, to: number): ParameterInfo[] => [
  { name: 'zFrom', label: 'Z from', kind: 'number', default: from },
  { name: 'zTo', label: 'Z to', kind: 'number', default: to },
];

// The boxes the finished samples fill, as the pages show them.
const boxes: Readonly<Record<string, readonly [number, number, number, number, number, number]>> = {
  threeClouds: [-1, 1, -1, 1, -1, 1],
  particlePath: [-25, 25, -30, 30, 0, 55],
  wells: [0, 10, 0, 10, 0, 8],
  spiralBubbles: [-1.2, 1.2, -1.2, 1.2, -1.2, 1.2],
  spiralPath: [-1, 1, -1, 1, -1, 1],
  greenSpiral: [-1, 1, -1, 1, -1, 1],
  landscape: [-1, 1, -1, 1, -1, 1],
  particlePathLive: [-25, 25, -30, 30, 0, 55],
  sweepLive: [-1, 1, -1, 1, -1, 1],
  pipeSensors: [-1.25, 126.25, -63.75, 63.75, -26.25, 101.25],
};

function span(values: SpecValues): [number, number] {
  const start = numberOf(values, 'start', 0);
  return [start, start + numberOf(values, 'size', 10)];
}

function spanCode(writer: CodeWriter, values: SpecValues): string {
  const [from, to] = span(values);
  return `new ${writer.use('DoubleRange')}(${num(from)}, ${num(to)})`;
}

// The box of a series that has the scene to itself: from its sample, or the extent and heights of its parameters.
function boxCode(series: SeriesSpec, axes: SeriesAxes, height: [number, number] | undefined): string[] {
  if (axes.inSharedBox === true) {
    return [];
  }
  const box = series.data.kind === 'sample' ? boxes[series.data.sample] : undefined;
  if (box) {
    return [
      `s.xAxis(${num(box[0])}, ${num(box[1])}, 'x').yAxis(${num(box[2])}, ${num(box[3])}, 'y').zAxis(${num(box[4])}, ${num(box[5])}, 'z');`,
    ];
  }
  if (!height) {
    return [];
  }
  const values = series.parameters;
  const [from, to] = span(values);
  return [
    `s.xAxis(${num(from)}, ${num(to)}, 'x').yAxis(${num(from)}, ${num(to)}, 'y').zAxis(${num(numberOf(values, 'zFrom', height[0]))}, ${num(numberOf(values, 'zTo', height[1]))}, 'z');`,
  ];
}

// The options of an object: only those that differ from its defaults, so that the code stays short.
function options(parts: readonly (string | undefined)[]): string {
  const given = parts.filter((part) => part !== undefined);
  return given.length === 0 ? '' : `, { ${given.join(', ')} }`;
}

function colormapOption(
  writer: CodeWriter,
  values: SpecValues,
  standard: string,
  name = 'colormap',
): string | undefined {
  const chosen = textOf(values, 'colormap', standard);
  return chosen === 'Viridis' && name === 'colormap'
    ? undefined
    : `${name}: ${writer.use('Colormap')}.builtIn(${str(chosen)})`;
}

function materialOption(values: SpecValues, gloss?: number): string | undefined {
  const parts: string[] = [];
  if (!flagOf(values, 'lit', true)) {
    parts.push('isLit: false');
  }
  if (numberOf(values, 'opacity', 1) !== 1) {
    parts.push(`opacity: ${num(numberOf(values, 'opacity', 1))}`);
  }
  if (gloss !== undefined && numberOf(values, 'gloss', gloss) !== gloss) {
    parts.push(`gloss: ${num(numberOf(values, 'gloss', gloss))}`);
  }
  return parts.length === 0 ? undefined : `material: { ${parts.join(', ')} }`;
}

const colorOption = (values: SpecValues): string | undefined => {
  const chosen = colorCode(values, 'color');
  return chosen ? `color: ${chosen}` : undefined;
};

function sceneType(
  info: Omit<ChartTypeInfo, 'code' | 'category' | 'ownsAxes' | 'inScene'> & {
    readonly height?: [number, number];
    readonly add: (writer: CodeWriter, series: SeriesSpec, data: string) => string;
  },
): ChartTypeInfo {
  const { height, add, ...rest } = info;
  return {
    ...rest,
    category: 'threeD',
    ownsAxes: true,
    inScene: true,
    parameters: height ? [...info.parameters, ...heights(height[0], height[1])] : info.parameters,
    code: (writer, series, data, axes) => [...boxCode(series, axes, height), add(writer, series, data)].join('\n'),
  };
}

const surface = sceneType({
  id: 'surface3d',
  name: 'Surface 3D',
  shape: 'grid',
  defaultSample: 'hills',
  height: [-1, 1],
  parameters: [
    colormap('Viridis'),
    lit,
    opacity,
    extent,
    {
      name: 'heightLines',
      label: 'Height lines',
      kind: 'integer',
      default: 0,
      minimum: 0,
      maximum: 50,
      description: 'Lines of equal height, evenly over the Z range; 0 for none.',
    },
    {
      name: 'onWalls',
      label: 'Height lines on the walls',
      kind: 'flag',
      default: false,
      description: 'The cuts through the surface also show on the walls of the box.',
    },
    {
      name: 'limit',
      label: 'Limit plane',
      kind: 'flag',
      default: false,
      description: 'A red plane at a limit; where the surface crosses it is easy to see.',
    },
    { name: 'limitValue', label: 'Limit at', kind: 'number', default: 0.5 },
    {
      name: 'limitLine',
      label: 'Line at the limit',
      kind: 'flag',
      default: false,
      description: 'A red line on the surface where it crosses the limit, instead of height lines.',
    },
  ],
  add(writer, series, data) {
    const values = series.parameters;
    const limit = num(numberOf(values, 'limitValue', 0.5));
    let contours: string | undefined;
    if (flagOf(values, 'limitLine')) {
      contours = `contours: { levels: [${limit}], color: ${rgba(red)}, width: 2.5, onFloor: false }`;
    } else if (numberOf(values, 'heightLines', 0) > 0) {
      const range = `new ${writer.use('DoubleRange')}(${num(numberOf(values, 'zFrom', -1))}, ${num(numberOf(values, 'zTo', 1))})`;
      const even = `${writer.use('evenContours', threeD)}(${range}, ${String(Math.trunc(numberOf(values, 'heightLines', 0)))})`;
      contours = flagOf(values, 'onWalls') ? `contours: { ...${even}, onWalls: true }` : `contours: ${even}`;
    }
    const range = spanCode(writer, values);
    const result = [
      `s.addSurface(new ${writer.use('Surface3D', threeD)}(${data}, ${range}, ${range}${options([colormapOption(writer, values, 'Viridis'), materialOption(values), contours])}));`,
    ];
    if (flagOf(values, 'limit')) {
      result.push(`s.addMesh(${writer.use('Shapes3D', threeD)}.limit(${range}, ${range}, ${limit}, ${rgba(red)}));`);
    }
    return result.join('\n');
  },
});

const columns = sceneType({
  id: 'columns3d',
  name: 'Columns 3D',
  shape: 'grid',
  defaultSample: 'rasterHills',
  height: [0, 1],
  parameters: [
    colormap('Viridis'),
    { name: 'width', label: 'Width', kind: 'number', default: 0.8, minimum: 0.05, maximum: 1 },
    lit,
    opacity,
    {
      name: 'gloss',
      label: 'Gloss',
      kind: 'number',
      default: 0.18,
      minimum: 0,
      maximum: 1,
      description: 'The strength of the highlights.',
    },
    extent,
    {
      name: 'start',
      label: 'Start',
      kind: 'number',
      default: 0,
      description: 'Where the grid starts across and along; it ends at the start plus the extent.',
    },
    { name: 'baseline', label: 'Base of the columns', kind: 'number', default: 0 },
  ],
  add(writer, series, data) {
    const values = series.parameters;
    const range = spanCode(writer, values);
    const parts = [
      colormapOption(writer, values, 'Viridis'),
      numberOf(values, 'width', 0.8) === 0.8 ? undefined : `width: ${num(numberOf(values, 'width', 0.8))}`,
      materialOption(values, 0.18),
      numberOf(values, 'baseline', 0) === 0 ? undefined : `baseline: ${num(numberOf(values, 'baseline', 0))}`,
    ];
    return `s.addBars(new ${writer.use('Bars3D', threeD)}(${data}, ${range}, ${range}${options(parts)}));`;
  },
});

// Live points: a particle that keeps moving, or a sweep that keeps scanning a surface; each returns what stops it.
function liveCode(writer: CodeWriter, series: SeriesSpec, data: string): string[] {
  const sample = series.data.kind === 'sample' ? series.data.sample : '';
  const points = writer.useType('Points3D', threeD);
  if (sample === 'particlePathLive') {
    const start = writer.helper(
      'startPath',
      [
        '// Moves the particle on by 200 steps every 30 ms; the ring keeps the newest points.',
        `function startPath(${writer.parameter('points', points)})${writer.type('() => void')} {`,
        `  const viridis = ${writer.use('Colormap')}.builtIn('Viridis');`,
        '  let [x, y, z] = [1, 1, 20];',
        '  const timer = setInterval(() => {',
        '    for (let i = 0; i < 200; i++) {',
        '      [x, y, z] = [x + 0.02 * (y - x), y + 0.002 * (x * (28 - z) - y), z + 0.002 * (x * y - (8 / 3) * z)];',
        '      points.append(x, y, z, viridis.sample((points.total % points.capacity) / points.capacity));',
        '    }',
        '  }, 30);',
        '  return () => {',
        '    clearInterval(timer);',
        '  };',
        '}',
      ].join('\n'),
    );
    return [`${writer.running()}.push(${start}(${data}));`];
  }
  if (sample === 'sweepLive') {
    const start = writer.helper(
      'startSweep',
      [
        '// Scans a surface in strips of 30 000 points every 30 ms, across and back again; the ring keeps the newest.',
        `function startSweep(${writer.parameter('points', points)})${writer.type('() => void')} {`,
        `  const viridis = ${writer.use('Colormap')}.builtIn('Viridis');`,
        `  const random = new ${writer.use('SeededRandom')}(2);`,
        '  const timer = setInterval(() => {',
        '    const sweep = (points.total / points.capacity) % 1;',
        '    for (let i = 0; i < 30_000; i++) {',
        '      const a = sweep * 2 - 1 + random.nextDouble() * 0.02;',
        '      const b = random.nextDouble() * 2 - 1;',
        '      const z = 0.5 * Math.sin(a * 4) * Math.cos(b * 3);',
        '      points.append(a, b, z, viridis.sample(z + 0.5));',
        '    }',
        '  }, 30);',
        '  return () => {',
        '    clearInterval(timer);',
        '  };',
        '}',
      ].join('\n'),
    );
    return [`${writer.running()}.push(${start}(${data}));`];
  }
  return [];
}

const line = sceneType({
  id: 'line3d',
  name: 'Line 3D',
  shape: 'points3D',
  defaultSample: 'spiralPath',
  height: [-1, 1],
  parameters: [color, { name: 'width', label: 'Width', kind: 'number', default: 1.5, minimum: 0.5, maximum: 10 }],
  add(writer, series, data) {
    const values = series.parameters;
    const width = numberOf(values, 'width', 1.5);
    const parts = [colorOption(values), width === 1.5 ? undefined : `width: ${num(width)}`];
    return [
      ...liveCode(writer, series, data),
      `s.addLine(new ${writer.use('Line3D', threeD)}(${data}${options(parts)}));`,
    ].join('\n');
  },
});

const scatter = sceneType({
  id: 'scatter3d',
  name: 'Scatter 3D',
  shape: 'points3D',
  defaultSample: 'scattered',
  height: [-1, 1],
  parameters: [color, { name: 'size', label: 'Size', kind: 'number', default: 3, minimum: 1, maximum: 30 }],
  add(writer, series, data) {
    const values = series.parameters;
    const size = numberOf(values, 'size', 3);
    const parts = [colorOption(values), size === 3 ? undefined : `size: ${num(size)}`];
    return [
      ...liveCode(writer, series, data),
      `s.addScatter(new ${writer.use('Scatter3D', threeD)}(${data}${options(parts)}));`,
    ].join('\n');
  },
});

const bubbles = sceneType({
  id: 'bubbles3d',
  name: 'Bubbles 3D',
  shape: 'bubbles3D',
  defaultSample: 'wells',
  height: [-1, 1],
  parameters: [
    color,
    {
      name: 'sizeUnit',
      label: 'Size in',
      kind: 'choice',
      default: 'Data',
      choices: ['Data', 'Screen'],
      description:
        'Data: the diameters are in the units of the axes; Screen: in screen points, the same at every distance.',
    },
  ],
  add(writer, series, data) {
    const values = series.parameters;
    const unit = textOf(values, 'sizeUnit', 'Data');
    const parts = [
      `colors: ${data}.colors`,
      `values: ${data}.values`,
      colorOption(values),
      unit === 'Data' ? undefined : `sizeUnit: ${str(camel(unit))}`,
    ];
    return `s.addBubbles(new ${writer.use('Bubbles3D', threeD)}(${data}.x, ${data}.y, ${data}.z, ${data}.diameters${options(parts)}));`;
  },
});

const cloud = sceneType({
  id: 'cloud3d',
  name: 'Point cloud',
  shape: 'cloud',
  defaultSample: 'landscape',
  height: [-1, 1],
  parameters: [
    color,
    { name: 'pointSize', label: 'Point size', kind: 'number', default: 2.5, minimum: 1, maximum: 20 },
  ],
  add(writer, series, data) {
    const values = series.parameters;
    const size = numberOf(values, 'pointSize', 2.5);
    const parts = [colorOption(values), size === 2.5 ? undefined : `pointSize: ${num(size)}`];
    return `s.addCloud(new ${writer.use('PointCloud3D', threeD)}(${data}${options(parts)}));`;
  },
});

const map = sceneType({
  id: 'map3d',
  name: 'Map from measurements',
  shape: 'xyz',
  defaultSample: 'engineMap',
  height: [-1, 1],
  parameters: [colormap('Viridis'), { name: 'points', label: 'Show the points', kind: 'flag', default: true }, lit],
  add(writer, series, data) {
    const values = series.parameters;
    const parts = [
      colormapOption(writer, values, 'Viridis'),
      flagOf(values, 'points', true) ? undefined : 'showsPoints: false',
      materialOption(values),
    ];
    return `s.addMap(new ${writer.use('MeasuredMap3D', threeD)}(${data}.x, ${data}.y, ${data}.z${options(parts)}));`;
  },
});

function tissueHelper(writer: CodeWriter): string {
  const transfer = writer.use('TransferFunction3D', threeD);
  return writer.helper(
    'tissue',
    [
      '// Clear around a body, faint tissue, a solid shell and spots: the colors and opacities along the values.',
      `function tissue()${writer.type(transfer)} {`,
      `  return new ${transfer}([`,
      '    { share: 0, color: { r: 30, g: 60, b: 140, a: 255 }, opacity: 0 },',
      '    { share: 0.12, color: { r: 30, g: 60, b: 140, a: 255 }, opacity: 0 },',
      '    { share: 0.3, color: { r: 70, g: 150, b: 190, a: 255 }, opacity: 0.003 },',
      '    { share: 0.6, color: { r: 70, g: 150, b: 190, a: 255 }, opacity: 0.006 },',
      '    { share: 0.76, color: { r: 240, g: 190, b: 120, a: 255 }, opacity: 0.03 },',
      '    { share: 0.86, color: { r: 255, g: 90, b: 60, a: 255 }, opacity: 0.5 },',
      '    { share: 1, color: { r: 255, g: 90, b: 60, a: 255 }, opacity: 0.9 },',
      '  ]);',
      '}',
    ].join('\n'),
  );
}

const volume = sceneType({
  id: 'volume3d',
  name: 'Volume',
  shape: 'volume',
  defaultSample: 'layeredBody',
  height: [0, 10],
  parameters: [
    { name: 'mode', label: 'Show', kind: 'choice', default: 'Transfer', choices: ['Transfer', 'Maximum', 'Surface'] },
    colormap('Viridis'),
    {
      name: 'transfer',
      label: 'Transfer',
      kind: 'choice',
      default: 'Colormap',
      choices: ['Colormap', 'Tissue and spots'],
      description:
        'How values turn into color and opacity when looking through: the colormap, or clear around a body, faint tissue and solid shell and spots.',
    },
    {
      name: 'slices',
      label: 'Slices',
      kind: 'flag',
      default: true,
      description: 'Three planes through the middle that show the values on them.',
    },
    {
      name: 'sliceThreshold',
      label: 'Slices leave out below',
      kind: 'number',
      default: 0,
      minimum: 0,
      maximum: 1,
      description: 'The share of the value range below which a slice stays clear.',
    },
    {
      name: 'isoAt',
      label: 'Surface at',
      kind: 'number',
      default: 0.5,
      minimum: 0,
      maximum: 1,
      description: 'For the surface of equal value: where between the lowest and the highest value it lies.',
    },
    extent,
    {
      name: 'start',
      label: 'Start',
      kind: 'number',
      default: 0,
      description: 'Where the volume starts along each axis; it ends at the start plus the extent.',
    },
  ],
  add(writer, series, data) {
    const values = series.parameters;
    const range = spanCode(writer, values);
    const mode = textOf(values, 'mode', 'Transfer');
    const parts = [
      mode === 'Transfer' ? undefined : `mode: ${str(camel(mode))}`,
      colormapOption(writer, values, 'Viridis'),
      textOf(values, 'transfer', 'Colormap') === 'Colormap' ? undefined : `transfer: ${tissueHelper(writer)}()`,
      flagOf(values, 'slices', true) ? undefined : 'showsSlices: false',
      numberOf(values, 'sliceThreshold', 0) === 0
        ? undefined
        : `sliceThreshold: ${num(numberOf(values, 'sliceThreshold', 0))}`,
    ];
    const make = `new ${writer.use('Volume3D', threeD)}(${data}, ${range}, ${range}, ${range}${options(parts)})`;
    const isoAt = numberOf(values, 'isoAt', 0.5);
    if (isoAt === 0.5) {
      return `s.addVolume(${make});`;
    }
    return [
      `const volume = ${make};`,
      `volume.isoValue = ${data}.valueRange.min + ${num(isoAt)} * (${data}.valueRange.max - ${data}.valueRange.min);`,
      's.addVolume(volume);',
    ].join('\n');
  },
});

const antenna = sceneType({
  id: 'antenna3d',
  name: 'Antenna pattern',
  shape: 'pattern',
  defaultSample: 'mainLobe',
  parameters: [
    colormap('Viridis'),
    { name: 'range', label: 'Dynamic range in dB', kind: 'number', default: 40, minimum: 3, maximum: 120 },
    lit,
  ],
  add(writer, series, data) {
    const values = series.parameters;
    const range = numberOf(values, 'range', 40);
    const parts = [
      colormapOption(writer, values, 'Viridis'),
      range === 40 ? undefined : `dynamicRange: ${num(range)}`,
      materialOption(values),
    ];
    return `s.addAntenna(new ${writer.use('AntennaPattern3D', threeD)}(${data}.azimuths, ${data}.elevations, ${data}.gains${options(parts)}));`;
  },
});

function pie3D(id: string, name: string, hole: number): ChartTypeInfo {
  return sceneType({
    id,
    name,
    shape: 'slices',
    defaultSample: 'tenSources',
    parameters: [
      {
        name: 'labels',
        label: 'Labels',
        kind: 'choice',
        default: 'NameAndPercent',
        choices: ['None', 'Name', 'Percent', 'Value', 'NameAndPercent'],
      },
      {
        name: 'innerRadius',
        label: 'Hole',
        kind: 'number',
        default: hole,
        minimum: 0,
        maximum: 0.9,
        description: 'The radius of the hole as a share of the radius; above 0 for a donut.',
      },
      { name: 'height', label: 'Height', kind: 'number', default: 0.3, minimum: 0.02, maximum: 1 },
      { name: 'explodeDistance', label: 'Pulled out by', kind: 'number', default: 0.15, minimum: 0, maximum: 0.5 },
      {
        name: 'exploded',
        label: 'Piece pulled out',
        kind: 'integer',
        default: -1,
        minimum: -1,
        maximum: 100,
        description: 'The number of the piece from 0; -1 for none.',
      },
    ],
    add(writer, series, data) {
      const values = series.parameters;
      const labels = textOf(values, 'labels', 'NameAndPercent');
      const parts = [
        `names: ${data}.names`,
        labels === 'NameAndPercent' ? undefined : `labels: ${str(camel(labels))}`,
        numberOf(values, 'innerRadius', hole) === 0
          ? undefined
          : `innerRadius: ${num(numberOf(values, 'innerRadius', hole))}`,
        numberOf(values, 'height', 0.3) === 0.3 ? undefined : `height: ${num(numberOf(values, 'height', 0.3))}`,
        numberOf(values, 'explodeDistance', 0.15) === 0.15
          ? undefined
          : `explodeDistance: ${num(numberOf(values, 'explodeDistance', 0.15))}`,
        numberOf(values, 'exploded', -1) < 0
          ? undefined
          : `explodedIndex: ${String(Math.trunc(numberOf(values, 'exploded', -1)))}`,
      ];
      return `s.addPie(new ${writer.use('Pie3D', threeD)}(${data}.values${options(parts)}));`;
    },
  });
}

const box = sceneType({
  id: 'box3d',
  name: 'Axis box only',
  shape: 'points3D',
  defaultSample: 'scattered',
  parameters: [],
  noData: true,
  add: () => '',
});

function cubeHelper(writer: CodeWriter): string {
  const data = writer.useType('ModelFileData', threeD);
  return writer.helper(
    'cube',
    [
      '// A cube around a model, so that all axes share one scale and the model keeps its shape.',
      `function cube(${writer.parameter('model', data)}) {`,
      '  const low = model.lowest;',
      '  const high = model.highest;',
      '  const half = Math.max(high.x - low.x, high.y - low.y, high.z - low.z) / 2;',
      `  const middle = new ${writer.use('Point3D', threeD)}((low.x + high.x) / 2, (low.y + high.y) / 2, (low.z + high.z) / 2);`,
      '  return { from: middle.minus(new Point3D(half, half, half)), to: middle.plus(new Point3D(half, half, half)) };',
      '}',
    ].join('\n'),
  );
}

function valueRangeHelper(writer: CodeWriter): string {
  const range = writer.use('DoubleRange');
  return writer.helper(
    'valueRange',
    [
      '// From the lowest to the highest value; one value alone gets a little room around it.',
      `function valueRange(${writer.parameter('values', 'readonly number[]')})${writer.type(range)} {`,
      '  let low = Number.POSITIVE_INFINITY;',
      '  let high = Number.NEGATIVE_INFINITY;',
      '  for (const value of values) {',
      '    if (Number.isFinite(value)) {',
      '      low = Math.min(low, value);',
      '      high = Math.max(high, value);',
      '    }',
      '  }',
      '  if (low > high) {',
      '    [low, high] = [0, 1];',
      '  }',
      `  return high > low ? new ${range}(low, high) : new ${range}(low - 0.5, high + 0.5);`,
      '}',
    ].join('\n'),
  );
}

const modelColors = 'Model colors';

const model3D: ChartTypeInfo = {
  id: 'model3d',
  name: 'Model 3D',
  category: 'threeD',
  shape: 'model',
  defaultSample: 'hillMesh',
  ownsAxes: true,
  inScene: true,
  parameters: [
    color,
    lit,
    opacity,
    {
      name: 'gloss',
      label: 'Gloss',
      kind: 'number',
      default: 0.18,
      minimum: 0,
      maximum: 1,
      description: 'The strength of the highlights.',
    },
    { name: 'sharpness', label: 'Sharpness of the highlights', kind: 'number', default: 64, minimum: 1, maximum: 256 },
    {
      name: 'colorBy',
      label: 'Color by',
      kind: 'choice',
      default: modelColors,
      choices: [modelColors, 'Height', 'Values'],
      description:
        'The colors of the model, or its height or the values its data bring through the colormap; then the color scale shows beside the box. Data without values color by height.',
    },
    colormap('Viridis'),
    {
      name: 'colorsFollow',
      label: 'Colors follow the values',
      kind: 'flag',
      default: true,
      description: 'The colormap spans from the lowest to the highest value of the model; off for the range below.',
    },
    {
      name: 'scaleFrom',
      label: 'Colors from',
      kind: 'number',
      default: 0,
      description: 'The value at the start of the colormap.',
    },
    {
      name: 'scaleTo',
      label: 'Colors to',
      kind: 'number',
      default: 1,
      description: 'The value at the end of the colormap.',
    },
    {
      name: 'scaleTitle',
      label: 'Title of the scale',
      kind: 'text',
      default: '',
      description: 'The name or unit of the values, such as °C.',
    },
  ],
  code(writer, series, data, axes) {
    const values = series.parameters;
    const carries = series.data.kind === 'sample' && series.data.sample === 'pipeBend';
    const model = carries ? `${data}.model` : data;
    const result: string[] = [];
    if (axes.inSharedBox !== true) {
      result.push(
        `const box = ${cubeHelper(writer)}(${model});`,
        "s.xAxis(box.from.x, box.to.x, 'x').yAxis(box.from.y, box.to.y, 'y').zAxis(box.from.z, box.to.z, 'z');",
      );
    }
    const material: string[] = [];
    if (!flagOf(values, 'lit', true)) {
      material.push('isLit: false');
    }
    if (numberOf(values, 'opacity', 1) !== 1) {
      material.push(`opacity: ${num(numberOf(values, 'opacity', 1))}`);
    }
    if (numberOf(values, 'gloss', 0.18) !== 0.18) {
      material.push(`gloss: ${num(numberOf(values, 'gloss', 0.18))}`);
    }
    if (numberOf(values, 'sharpness', 64) !== 64) {
      material.push(`sharpness: ${num(numberOf(values, 'sharpness', 64))}`);
    }
    const look = `{ ${material.join(', ')} }`;
    const colorBy = textOf(values, 'colorBy', modelColors);
    if (colorBy === modelColors) {
      const parts = [colorOption(values), material.length > 0 ? `material: ${look}` : undefined].filter(
        (part) => part !== undefined,
      );
      result.push(`s.addMesh(${model}.toMesh(${parts.length > 0 ? `{ ${parts.join(', ')} }` : ''}));`);
      return result.join('\n');
    }
    const perPoint = colorBy === 'Values' && carries ? `${data}.values` : `${model}.positions.map((place) => place.z)`;
    const range = flagOf(values, 'colorsFollow', true)
      ? `${valueRangeHelper(writer)}(${perPoint})`
      : `new ${writer.use('DoubleRange')}(${num(numberOf(values, 'scaleFrom', 0))}, ${num(numberOf(values, 'scaleTo', 1))})`;
    const scaleTitle = textOf(values, 'scaleTitle');
    const title = scaleTitle.length > 0 ? str(scaleTitle) : colorBy === 'Height' ? "'Height'" : 'undefined';
    result.push(
      `s.addMesh(${model}.toValueMesh(${perPoint}, ${writer.use('Colormap')}.builtIn(${str(textOf(values, 'colormap', 'Viridis'))}), ${range}, ${look}, ${title}));`,
    );
    return result.join('\n');
  },
};

const cutBelow = 'Cut below the surface';
const cutAbove = 'Cut above the surface';

const surfaceCut: ChartTypeInfo = {
  id: 'surfaceCut3d',
  name: 'Surface with its cut',
  category: 'threeD',
  shape: 'grid',
  defaultSample: 'hillAcross',
  ownsAxes: true,
  parameters: [
    {
      name: 'layout',
      label: 'Arrangement',
      kind: 'choice',
      default: cutBelow,
      choices: [cutBelow, cutAbove, 'Side by side'],
    },
    {
      name: 'at',
      label: 'Plane at',
      kind: 'number',
      default: 0.25,
      minimum: -1,
      maximum: 1,
      description: 'Where the plane crosses Y, from -1 to 1 across the box. Dragging its outline moves it.',
    },
    colormap('Viridis'),
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const unit = `new ${writer.use('DoubleRange')}(-1, 1)`;
    const chosen = colormapOption(writer, values, 'Viridis');
    return [
      '// The surface over -1 to 1, the plane across Y that shows where it cuts without hiding anything, and the curve',
      '// of the cut, which the 2D chart shows.',
      `const surface = new ${writer.use('Surface3D', threeD)}(${data}, ${unit}, ${unit}${chosen ? `, { ${chosen} }` : ''});`,
      `const plane = new ${writer.use('ClipPlane3D', threeD)}(new ${writer.use('Point3D', threeD)}(0, 1, 0), ${num(numberOf(values, 'at', 0.25))}, { hides: false });`,
      `const cut = new ${writer.use('CutCurveFeed', threeD)}(plane, surface);`,
    ].join('\n');
  },
  views(writer) {
    const surfaceView = {
      name: 'Surface',
      code: `${writer.use('scene3D', threeD)}(c, (s) => s.title('Cut through a surface').xAxis(-1, 1, 'x').yAxis(-1, 1, 'y').zAxis(-1, 1, 'z').addSurface(surface).addPlane(plane).addCut(cut).group('cut-3d'));`,
    };
    const cutView = {
      name: 'Cut',
      code: [
        "c.title('Height at the plane');",
        "c.xAxis((a) => a.numeric('x').range(-1, 1).title('x'));",
        "c.yAxis((a) => a.numeric('z').range(-1, 1).title('z'));",
        'c.addLine(cut.data, (line) => line.thickness(2));',
        "c.group('cut-3d');",
        `c.addModifier(() => new ${writer.use('ZoomPanModifier')}());`,
        `c.addModifier(() => new ${writer.use('CrosshairModifier')}());`,
      ].join('\n'),
    };
    return [surfaceView, cutView];
  },
  columns: (series) => (textOf(series.parameters, 'layout', cutBelow) === 'Side by side' ? 2 : 1),
};

const waterfallAbove = 'Waterfall above the spectrum';

const spectrumWaterfall: ChartTypeInfo = {
  id: 'spectrumWaterfall',
  name: 'Spectrum with 3D waterfall',
  category: 'instrument',
  shape: 'spectrum',
  defaultSample: 'noisyCarriers',
  ownsAxes: true,
  parameters: [
    {
      name: 'layout',
      label: 'Arrangement',
      kind: 'choice',
      default: 'Side by side',
      choices: ['Side by side', 'One above the other', waterfallAbove],
    },
    ...spectrumSettings,
    colormap('Inferno'),
    { name: 'style', label: 'Style', kind: 'choice', default: 'Surface', choices: ['Surface', 'Lines'] },
    {
      name: 'live',
      label: 'Live spectra',
      kind: 'flag',
      default: false,
      description: 'New spectra keep coming, as from a measurement, and run back in the waterfall.',
    },
    { name: 'rate', label: 'Spectra per second', kind: 'number', default: 20, minimum: 1, maximum: 200 },
  ],
  code(writer, series, data) {
    return spectrumSetup(writer, series, data, 20).join('\n');
  },
  views(writer, series, data) {
    const values = series.parameters;
    const spectrumView = { name: 'Spectrum', code: `${writer.use('spectrum')}(c, ${data});` };
    const range = writer.use('DoubleRange');
    const style = textOf(values, 'style', 'Surface');
    const waterfallView = {
      name: 'Waterfall',
      code: [
        '// Frequencies across, the spectra so far into the depth, the levels of the spectrum up.',
        `const frequency = new ${writer.use('NumericAxis')}('x3d', 'bottom');`,
        `frequency.visibleRange = new ${range}(${data}.start, ${data}.stop);`,
        "frequency.title = 'Frequency';",
        "frequency.labelFormat = { useSiPrefixes: true, unit: 'Hz' };",
        `const lowest = ${data}.referenceLevel - 10 * ${data}.perDivision;`,
        `${writer.use('scene3D', threeD)}(c, (s) =>`,
        "  s.title('Waterfall')",
        '    .xAxis(frequency)',
        "    .yAxis(0, 400, 'Spectra ago')",
        `    .zAxis(lowest, ${data}.referenceLevel, 'dBm')`,
        `    .addWaterfall(${writer.use('Waterfall3D', threeD)}.from(${data}, new ${range}(0, 400), { colormap: ${writer.use('Colormap')}.builtIn(${str(textOf(values, 'colormap', 'Inferno'))}), colorRange: new ${range}(lowest, ${data}.referenceLevel)${style === 'Surface' ? '' : `, style: ${str(camel(style))}`} })),`,
        ');',
      ].join('\n'),
    };
    return textOf(values, 'layout', 'Side by side') === waterfallAbove
      ? [waterfallView, spectrumView]
      : [spectrumView, waterfallView];
  },
  columns: (series) => (textOf(series.parameters, 'layout', 'Side by side') === 'Side by side' ? 2 : 1),
};

const liveSamples: readonly SampleInfo[] = [
  {
    id: 'particlePathLive',
    name: 'Path of a particle, live',
    shape: 'points3D',
    defaultCount: 100_000,
    minimumCount: 1,
    body: '// A ring for the newest points; the particle moves on while the chart runs.\nreturn new Points3D(count);',
    returns: 'Points3D',
    uses: [`${threeD}#Points3D`],
  },
  {
    id: 'sweepLive',
    name: 'A surface scanned live',
    shape: 'points3D',
    defaultCount: 5_000_000,
    minimumCount: 1,
    body: '// A ring for the newest points; the scan goes on while the chart runs.\nreturn new Points3D(count);',
    returns: 'Points3D',
    uses: [`${threeD}#Points3D`],
  },
  {
    id: 'hillAcross',
    name: 'A hilly surface over -1 to 1',
    shape: 'grid',
    defaultCount: 256,
    minimumCount: 2,
    body: [
      'const values = new Float32Array(count * count);',
      'for (let i = 0; i < values.length; i++) {',
      '  const x = (2 * (i % count)) / (count - 1) - 1;',
      '  const y = (2 * Math.trunc(i / count)) / (count - 1) - 1;',
      '  values[i] = 0.7 * Math.sin(x * 3) * Math.cos(y * 2.5);',
      '}',
      'const data = new HeatmapData(count, count);',
      'data.setValues(values);',
      'return data;',
    ].join('\n'),
    returns: 'HeatmapData',
    uses: ['HeatmapData'],
  },
];

// The ranges and titles of the box, the cut plane and further planes of the scene.
function rangeOf(values: SpecValues, axis: string): [number, number] | undefined {
  const ends = textOf(values, `${axis}Range`).split('..');
  const from = Number(ends[0]);
  const to = Number(ends[1]);
  return ends.length === 2 && ends[0]?.trim() !== '' && Number.isFinite(from) && Number.isFinite(to) && from < to
    ? [from, to]
    : undefined;
}

interface Plane {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly offset: number;
  readonly slice: boolean;
}

function planesOf(values: SpecValues): Plane[] {
  const planes: Plane[] = [];
  for (const entry of textOf(values, 'planes')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)) {
    const [direction = '', rest = ''] = entry.split('@').map((part) => part.trim());
    const [x, y, z] = direction.split(/\s+/u).map(Number);
    const [offset, kind] = rest.split(/\s+/u);
    const at = Number(offset);
    if (
      x !== undefined &&
      y !== undefined &&
      z !== undefined &&
      Number.isFinite(x + y + z) &&
      Number.isFinite(at) &&
      (x !== 0 || y !== 0 || z !== 0)
    ) {
      planes.push({ x, y, z, offset: at, slice: kind?.toLowerCase() === 'slice' });
    }
  }
  return planes;
}

const axisParameters = (axis: string): ParameterInfo[] => [
  {
    name: `${axis}Range`,
    label: `${axis.toUpperCase()} axis from..to`,
    kind: 'text',
    default: '',
    description: 'Such as -25..25; empty for the range of the data.',
  },
  {
    name: `${axis}Title`,
    label: `${axis.toUpperCase()} axis title`,
    kind: 'text',
    default: '',
    description: 'Shows with a range; empty keeps the title of the data.',
  },
];

const scene: SceneSetup = {
  parameters: [
    {
      name: 'projection',
      label: 'Camera',
      kind: 'choice',
      default: 'Perspective',
      choices: ['Perspective', 'Orthographic'],
    },
    {
      name: 'cut',
      label: 'Cut plane',
      kind: 'choice',
      default: 'None',
      choices: ['None', 'X', 'Y', 'Z'],
      description: 'A plane across an axis that hides what lies beyond it.',
    },
    {
      name: 'cutAt',
      label: 'Cut at',
      kind: 'number',
      default: 5,
      description:
        'Where the plane crosses its axis, in the units of the axis; outside its range the plane cuts through the middle.',
    },
    {
      name: 'planes',
      label: 'Further planes',
      kind: 'text',
      default: '',
      description:
        'In box coordinates, where every axis spans -1 to 1: the direction to the side that stays, @ and the distance from the middle, such as -1 0 0 @ -0.35; add slice for a plane that only shows its cut. Separated by semicolons.',
    },
    ...axisParameters('x'),
    ...axisParameters('y'),
    ...axisParameters('z'),
  ],
  host: { name: 'scene3D', from: threeD },
  start(_writer, spec) {
    const values = spec.scene;
    const result: string[] = [];
    if (textOf(values, 'projection', 'Perspective') === 'Orthographic') {
      result.push("s.projection('orthographic');");
    }
    if (spec.group !== undefined && spec.group.length > 0) {
      result.push(`s.group(${str(spec.group)});`);
    }
    return result;
  },
  end(writer, spec) {
    const values = spec.scene;
    const result: string[] = [];
    for (const axis of ['x', 'y', 'z']) {
      const range = rangeOf(values, axis);
      if (range) {
        const title = textOf(values, `${axis}Title`);
        const named = title.length > 0 ? str(title) : `s.scene.${axis}Axis.title ?? ''`;
        result.push(`s.${axis}Axis(${num(range[0])}, ${num(range[1])}, ${named});`);
      }
    }
    const cut = textOf(values, 'cut', 'None');
    const point = (x: number, y: number, z: number): string =>
      `new ${writer.use('Point3D', threeD)}(${num(x)}, ${num(y)}, ${num(z)})`;
    const plane = (): string => writer.use('ClipPlane3D', threeD);
    if (cut === 'X' || cut === 'Y' || cut === 'Z') {
      const axis = cut.toLowerCase();
      const at = num(numberOf(values, 'cutAt', 5));
      result.push(
        '// The cut plane lives in box coordinates, where every axis spans -1 to 1; outside its range it cuts the middle.',
        `const range = s.scene.${axis}Axis.visibleRange;`,
        `const offset = ${at} >= range.min && ${at} <= range.max && range.max > range.min ? -1 + (2 * (${at} - range.min)) / (range.max - range.min) : 0;`,
        `s.addPlane(new ${plane()}(${point(cut === 'X' ? 1 : 0, cut === 'Y' ? 1 : 0, cut === 'Z' ? 1 : 0)}, offset));`,
      );
    }
    for (const each of planesOf(values)) {
      result.push(
        `s.addPlane(new ${plane()}(${point(each.x, each.y, each.z)}, ${num(each.offset)}${each.slice ? ', { hides: false }' : ''}));`,
      );
    }
    return result;
  },
};

/** The 3D charts: one scene per chart with the 3D types in it. */
export const threeDModule: ChartModule = {
  types: [
    surface,
    columns,
    line,
    scatter,
    bubbles,
    cloud,
    map,
    volume,
    antenna,
    pie3D('pie3d', 'Pie 3D', 0),
    pie3D('donut3d', 'Donut 3D', 0.5),
    box,
    model3D,
    surfaceCut,
    spectrumWaterfall,
  ],
  samples: [...samples3D, ...modelSamples3D, ...liveSamples],
  scene,
  load: async () => ({ [threeD]: { ...(await import('@tachyon-charts/3d')) } }),
};
