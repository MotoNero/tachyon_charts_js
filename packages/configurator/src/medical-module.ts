// The medical images of the configurator, as MedicalModule and MedicalSetup of the .NET version: an image or a plane of
// a volume with window, colors, example measurements, measuring tools and the segments of the phantoms.
import type { ChartModule, ChartTypeInfo, ParameterInfo, SampleInfo, ViewCode } from './catalog';
import { camel } from './build';
import { num, str, type CodeWriter } from './code';
import { flagOf, numberOf, textOf, type SeriesSpec, type SpecValues } from './spec';

const medicalPackage = '@tachyon-charts/medical';
const threeDPackage = '@tachyon-charts/3d';
const lines = (...items: string[]): string => items.join('\n');
const colormaps = ['Grayscale', 'Viridis', 'Inferno', 'Magma', 'Plasma', 'Turbo'];
const windows = ['Automatic', 'Brain', 'Bone', 'Lung', 'Custom'];
const planes = ['Axial', 'Coronal', 'Sagittal'];
const kinds = ['Distance', 'Angle', 'Circle', 'Rectangle', 'Freehand'];

const windowParameters: readonly ParameterInfo[] = [
  {
    name: 'colormap',
    label: 'Colors',
    kind: 'choice',
    default: 'Grayscale',
    choices: colormaps,
    description: 'From the lower to the upper end of the window.',
  },
  {
    name: 'interpolated',
    label: 'Blend pixels',
    kind: 'flag',
    default: true,
    description: 'Blends between neighbouring values; off shows each value as a square.',
  },
  {
    name: 'window',
    label: 'Window',
    kind: 'choice',
    default: 'Automatic',
    choices: windows,
    description: 'The range of values from black to white; Automatic takes the one the data bring.',
  },
  { name: 'center', label: 'Window center', kind: 'number', default: 40, description: 'For a custom window.' },
  {
    name: 'width',
    label: 'Window width',
    kind: 'number',
    default: 400,
    minimum: 1,
    description: 'For a custom window.',
  },
];

const measuringParameters: readonly ParameterInfo[] = [
  {
    name: 'measurements',
    label: 'Example measurements',
    kind: 'flag',
    default: false,
    description: 'A distance, an angle and a round region, placed by the size of the image.',
  },
  {
    name: 'toolBar',
    label: 'Tool bar in the image',
    kind: 'flag',
    default: true,
    description:
      'Buttons in the lower left corner of each image: distance, angle, circle, rectangle, freehand, delete. A click on the lit tool puts it away; the drawings stay.',
  },
  {
    name: 'tool',
    label: 'Tool at the start',
    kind: 'choice',
    default: 'None',
    choices: ['None', ...kinds],
    description:
      'What a drag in an image draws first; None moves points and the window. The tool bar and the keys D, A, C, R, F and Escape change it while measuring.',
  },
];

const segmentationParameters: readonly ParameterInfo[] = [
  {
    name: 'segmentation',
    label: 'Segmentation',
    kind: 'flag',
    default: true,
    description: 'The segments of the phantom.',
  },
  { name: 'opacity', label: 'Opacity of the segments', kind: 'number', default: 0.5, minimum: 0, maximum: 1 },
];

// The colors and the blending; nothing is written while both keep their defaults.
function lookCode(writer: CodeWriter, values: SpecValues, data: string): string[] {
  const result: string[] = [];
  const colormap = textOf(values, 'colormap', 'Grayscale');
  if (colormap !== 'Grayscale') {
    result.push(`${data}.colormap = ${writer.use('Colormap')}.builtIn(${str(colormap)});`);
  }
  if (!flagOf(values, 'interpolated', true)) {
    result.push(`${data}.isInterpolated = false;`);
  }
  return result;
}

function windowCode(writer: CodeWriter, values: SpecValues, data: string): string[] {
  const chosen = textOf(values, 'window', 'Automatic');
  if (chosen === 'Automatic') {
    return [];
  }
  if (chosen === 'Custom') {
    return [`${data}.setWindow(${num(numberOf(values, 'center', 40))}, ${num(numberOf(values, 'width', 400))});`];
  }
  return [`${data}.applyPreset(${writer.use('CtWindowPresets', medicalPackage)}.${camel(chosen)});`];
}

function exampleMeasurementsHelper(writer: CodeWriter): string {
  const layer = writer.useType('MedicalMeasurementLayer', medicalPackage);
  return writer.helper(
    'exampleMeasurements',
    lines(
      '// A distance, an angle, a round region and a freehand outline, placed by the size of the image in millimetres.',
      `function exampleMeasurements(${writer.parameter('layer', layer)}, ${writer.parameter('width', 'number')}, ${writer.parameter('height', 'number')})${writer.type('void')} {`,
      `  const at = (x = 0, y = 0) => ({ x: (x / 192) * width, y: (y / 192) * height });`,
      "  layer.add('distance', [at(33, 140), at(159, 140)], undefined, 'Width');",
      "  layer.add('angle', [at(87, 72), at(96, 122), at(105, 72)]);",
      "  layer.add('circle', [at(62.5, 82), at(68.5, 82)], undefined, 'Focus');",
      "  layer.add('freehand', [at(100, 70), at(110, 72), at(112, 95), at(110, 120), at(101, 121), at(99, 95)], undefined, 'Ventricle');",
      '}',
    ),
  );
}

function measureCode(writer: CodeWriter, values: SpecValues, owner: string): string[] {
  const layer = `${owner}.measurements`;
  const result: string[] = [];
  if (flagOf(values, 'measurements')) {
    result.push(
      `${exampleMeasurementsHelper(writer)}(${layer}, ${owner}.width * ${owner}.spacing.column, ${owner}.height * ${owner}.spacing.row);`,
    );
  }
  if (flagOf(values, 'toolBar', true)) {
    result.push(`${layer}.showsTools = true;`);
  }
  const tool = textOf(values, 'tool', 'None');
  if (tool !== 'None') {
    result.push(`${layer}.tool = ${str(camel(tool))};`);
  }
  return result;
}

function moveToHelper(writer: CodeWriter): string {
  const display = writer.useType('MedicalMprDisplay', medicalPackage);
  const plane = writer.useType('MedicalMprPlane', medicalPackage);
  writer.use('Point3D', threeDPackage);
  return writer.helper(
    'moveTo',
    lines(
      '// Moves a plane of a volume to a share of the way from its first to its last slice.',
      `function moveTo(${writer.parameter('display', display)}, ${writer.parameter('plane', plane)}, ${writer.parameter('share', 'number')})${writer.type('void')} {`,
      '  const data = display.source.data;',
      '  const spacing = display.source.voxelSpacing;',
      '  const at = display.position;',
      '  display.setPosition(',
      "    plane === 'axial'",
      '      ? new Point3D(at.x, at.y, share * (data.depth - 1) * spacing.z)',
      "      : plane === 'coronal'",
      '        ? new Point3D(at.x, share * (data.height - 1) * spacing.y, at.z)',
      '        : new Point3D(share * (data.width - 1) * spacing.x, at.y, at.z),',
      '  );',
      '}',
    ),
  );
}

function phantomSegmentationHelper(writer: CodeWriter): string {
  const volume = writer.useType('MedicalVolume', medicalPackage);
  const mode = writer.useType('MedicalSegmentation3DMode', medicalPackage);
  const segment = writer.use('MedicalSegment', medicalPackage);
  return writer.helper(
    'phantomSegmentation',
    lines(
      '// Two organs of a phantom as ellipsoids in shares of the volume: a focus (1) and a cavity (2).',
      `function phantomSegmentation(${writer.parameter('volume', volume)}, ${writer.parameter('mode', mode)}, ${writer.parameter('opacity', 'number')}) {`,
      '  const data = volume.data;',
      '  const labels = new Uint16Array(data.width * data.height * data.depth);',
      '  const square = (value = 0) => value * value;',
      '  for (let z = 0; z < data.depth; z++) {',
      '    const nz = z / (data.depth - 1);',
      '    for (let y = 0; y < data.height; y++) {',
      '      const ny = y / (data.height - 1);',
      '      for (let x = 0; x < data.width; x++) {',
      '        const nx = x / (data.width - 1);',
      '        const focus = square((nx - 0.32) / 0.11) + square((ny - 0.46) / 0.14) + square((nz - 0.52) / 0.16) < 1;',
      '        const cavity = square((nx - 0.56) / 0.12) + square((ny - 0.5) / 0.19) + square((nz - 0.5) / 0.28) < 1;',
      '        labels[(z * data.height + y) * data.width + x] = focus ? 1 : cavity ? 2 : 0;',
      '      }',
      '    }',
      '  }',
      `  const focus = new ${segment}(1, 'Focus', { r: 245, g: 70, b: 80, a: 255 });`,
      '  focus.opacity = opacity;',
      `  const cavity = new ${segment}(2, 'Cavity', { r: 45, g: 205, b: 235, a: 255 });`,
      '  cavity.opacity = opacity;',
      `  return new ${writer.use('MedicalSegmentation', medicalPackage)}(`,
      `    new ${writer.use('VolumeData', threeDPackage)}(labels, data.width, data.height, data.depth),`,
      '    { row: volume.voxelSpacing.y, column: volume.voxelSpacing.x },',
      '    volume.voxelSpacing.z,',
      '    volume.origin,',
      '    volume.orientation,',
      '    [focus, cavity],',
      '    mode,',
      '  );',
      '}',
    ),
  );
}

const medicalImage: ChartTypeInfo = {
  id: 'medicalImage',
  name: 'Medical image',
  category: 'medical',
  shape: 'medicalImage',
  defaultSample: 'headAxial',
  ownsAxes: true,
  parameters: [...windowParameters, ...measuringParameters],
  code(writer, series, data) {
    const values = series.parameters;
    return [
      ...lookCode(writer, values, data),
      ...windowCode(writer, values, data),
      ...measureCode(writer, values, data),
      `${data}.configure(c);`,
    ].join('\n');
  },
};

function planeOf(values: SpecValues): string {
  const chosen = textOf(values, 'plane', 'Axial');
  return planes.includes(chosen) ? camel(chosen) : 'axial';
}

function segmentationCode(writer: CodeWriter, series: SeriesSpec, data: string, mode: string): string[] {
  const values = series.parameters;
  if (!flagOf(values, 'segmentation', true) || series.data.kind !== 'sample') {
    return [];
  }
  return [
    `${data}.addSegmentation(${phantomSegmentationHelper(writer)}(${data}.source, ${str(mode)}, ${num(numberOf(values, 'opacity', 0.5))}));`,
  ];
}

const medicalSlice: ChartTypeInfo = {
  id: 'medicalSlice',
  name: 'Medical plane (MPR)',
  category: 'medical',
  shape: 'medicalVolume',
  defaultSample: 'headPhantom',
  ownsAxes: true,
  parameters: [
    { name: 'plane', label: 'Plane', kind: 'choice', default: 'Axial', choices: planes },
    {
      name: 'position',
      label: 'Position in %',
      kind: 'number',
      default: 50,
      minimum: 0,
      maximum: 100,
      description: 'Where the plane cuts the volume, from its first to its last slice.',
    },
    ...windowParameters,
    ...segmentationParameters,
    ...measuringParameters,
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const plane = planeOf(values);
    return [
      ...lookCode(writer, values, data),
      ...windowCode(writer, values, data),
      `${moveToHelper(writer)}(${data}, ${str(plane)}, ${num(numberOf(values, 'position', 50) / 100)});`,
      ...segmentationCode(writer, series, data, 'volume'),
      ...measureCode(writer, values, `${data}.${plane}`),
      `${data}.${plane}.configure(c);`,
    ].join('\n');
  },
};

const layouts = ['2 × 2', 'Row', 'Column'];
const layoutParameter: ParameterInfo = {
  name: 'layout',
  label: 'Arrangement',
  kind: 'choice',
  default: '2 × 2',
  choices: layouts,
  description: 'How the linked charts stand in the window.',
};
const title3D: ParameterInfo = {
  name: 'title3d',
  label: 'Title of the 3D chart',
  kind: 'text',
  default: '',
  description: 'Empty for the title the volume brings.',
};
const measurements3D: ParameterInfo = {
  name: 'measurements3d',
  label: 'Measurements in 3D',
  kind: 'flag',
  default: true,
  description: 'Every measurement also as a line in the 3D chart, on the slice it was drawn on.',
};
const toolParameters = measuringParameters.filter((parameter) => parameter.name !== 'measurements');

const columnsOf = (series: SeriesSpec, count: number): number => {
  const layout = textOf(series.parameters, 'layout', '2 × 2');
  return layout === 'Row' ? count : layout === 'Column' ? 1 : Math.min(2, count);
};

// The tools of the planes that take measurements by hand.
function toolsCode(values: SpecValues, layers: readonly string[]): string[] {
  const result: string[] = [];
  const tool = textOf(values, 'tool', 'None');
  for (const layer of layers) {
    if (flagOf(values, 'toolBar', true)) {
      result.push(`${layer}.showsTools = true;`);
    }
    if (tool !== 'None') {
      result.push(`${layer}.tool = ${str(camel(tool))};`);
    }
  }
  return result;
}

const sliceView = (plane: string, data: string): ViewCode => ({
  name: plane.charAt(0).toUpperCase() + plane.slice(1),
  code: `${data}.${plane}.configure(c);`,
});

// The volume in 3D with the title chosen for it, set after the volume has set its own.
function volumeView(writer: CodeWriter, series: SeriesSpec, configure: string): ViewCode {
  const title = textOf(series.parameters, 'title3d');
  return {
    name: 'Volume',
    code: lines(
      `${writer.use('scene3D', threeDPackage)}(c, (scene) => ${configure});`,
      ...(title.length > 0 ? [`c.title(${str(title)});`] : []),
    ),
  };
}

function namedHelper(writer: CodeWriter): string {
  const slice = writer.useType('MedicalMprSlice', medicalPackage);
  return writer.helper(
    'named',
    lines(
      '// The measurement of a plane with a name.',
      `function named(${writer.parameter('slice', slice)}, ${writer.parameter('name', 'string')}) {`,
      '  return slice.measurements.measurements.find((measurement) => measurement.name === name);',
      '}',
    ),
  );
}

const medicalMpr: ChartTypeInfo = {
  id: 'medicalMpr',
  name: 'Medical MPR (linked)',
  category: 'medical',
  shape: 'medicalVolume',
  defaultSample: 'headPhantom',
  ownsAxes: true,
  parameters: [
    layoutParameter,
    { name: 'axial', label: 'Axial', kind: 'flag', default: true },
    { name: 'coronal', label: 'Coronal', kind: 'flag', default: true },
    { name: 'sagittal', label: 'Sagittal', kind: 'flag', default: true },
    { name: 'volume', label: 'Volume in 3D', kind: 'flag', default: true },
    title3D,
    measurements3D,
    { name: 'x', label: 'Sagittal position in %', kind: 'number', default: 50, minimum: 0, maximum: 100 },
    { name: 'y', label: 'Coronal position in %', kind: 'number', default: 50, minimum: 0, maximum: 100 },
    { name: 'z', label: 'Axial position in %', kind: 'number', default: 50, minimum: 0, maximum: 100 },
    ...windowParameters,
    ...segmentationParameters,
    { name: 'mode', label: 'Segments in 3D', kind: 'choice', default: 'Volume', choices: ['Volume', 'Surface'] },
    ...measuringParameters,
    {
      name: 'cine',
      label: 'Cine',
      kind: 'choice',
      default: 'Off',
      choices: ['Off', ...planes],
      description: 'Plays the slices of a plane in a loop; Space starts and stops it in a plane.',
    },
    { name: 'speed', label: 'Cine frames per second', kind: 'number', default: 10, minimum: 1, maximum: 120 },
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const move = moveToHelper(writer);
    const result = [
      ...lookCode(writer, values, data),
      ...windowCode(writer, values, data),
      `${move}(${data}, 'sagittal', ${num(numberOf(values, 'x', 50) / 100)});`,
      `${move}(${data}, 'coronal', ${num(numberOf(values, 'y', 50) / 100)});`,
      `${move}(${data}, 'axial', ${num(numberOf(values, 'z', 50) / 100)});`,
      ...segmentationCode(writer, series, data, camel(textOf(values, 'mode', 'Volume'))),
    ];
    if (flagOf(values, 'measurements')) {
      const axial = `${data}.axial`;
      result.push(
        `${exampleMeasurementsHelper(writer)}(${axial}.measurements, ${axial}.width * ${axial}.spacing.column, ${axial}.height * ${axial}.spacing.row);`,
      );
    }
    result.push(
      ...toolsCode(
        values,
        ['axial', 'coronal', 'sagittal'].map((plane) => `${data}.${plane}.measurements`),
      ),
    );
    if (!flagOf(values, 'measurements3d', true)) {
      result.push(`${data}.showsMeasurements3D = false;`);
    }
    result.push(`${data}.cine.framesPerSecond = ${num(numberOf(values, 'speed', 10))};`);
    const cine = textOf(values, 'cine', 'Off');
    if (cine !== 'Off') {
      result.push(`${data}.cine.play(${str(camel(cine))});`);
    }
    return result.join('\n');
  },
  views(writer, series, data) {
    const values = series.parameters;
    const views: ViewCode[] = [];
    if (flagOf(values, 'volume', true)) {
      views.push(volumeView(writer, series, `${data}.configure3D(scene)`));
    }
    for (const plane of ['axial', 'coronal', 'sagittal']) {
      if (flagOf(values, plane, true)) {
        views.push(sliceView(plane, data));
      }
    }
    return views.length > 0 ? views : [sliceView('axial', data)];
  },
  columns: columnsOf,
};

const medicalAnalysis: ChartTypeInfo = {
  id: 'medicalAnalysis',
  name: 'Medical analysis (profile, histogram)',
  category: 'medical',
  shape: 'medicalVolume',
  defaultSample: 'headPhantom',
  ownsAxes: true,
  parameters: [
    layoutParameter,
    { name: 'volume', label: 'Volume in 3D', kind: 'flag', default: true },
    title3D,
    { name: 'slice', label: 'Axial plane', kind: 'flag', default: true },
    { name: 'profile', label: 'Profile', kind: 'flag', default: true },
    { name: 'histogram', label: 'Histogram', kind: 'flag', default: true },
    ...windowParameters,
    ...segmentationParameters,
    { name: 'bins', label: 'Histogram bins', kind: 'integer', default: 512, minimum: 8, maximum: 4096 },
    ...toolParameters,
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const axial = `${data}.axial`;
    return [
      ...lookCode(writer, values, data),
      ...windowCode(writer, values, data),
      ...segmentationCode(writer, series, data, 'volume'),
      '// A line across the middle of the axial plane and a circle on the focus of the phantom.',
      `const width = ${axial}.width * ${axial}.spacing.column;`,
      `const height = ${axial}.height * ${axial}.spacing.row;`,
      `${axial}.measurements.add('distance', [{ x: width * 0.12, y: height * 0.5 }, { x: width * 0.88, y: height * 0.5 }], undefined, 'Profile line');`,
      `${axial}.measurements.add('circle', [{ x: width * 0.323, y: height * 0.43 }, { x: width * 0.358, y: height * 0.43 }], undefined, 'Focus');`,
      ...toolsCode(values, [`${axial}.measurements`]),
    ].join('\n');
  },
  views(writer, series, data) {
    const values = series.parameters;
    const views: ViewCode[] = [];
    if (flagOf(values, 'volume', true)) {
      views.push(volumeView(writer, series, `${data}.configure3D(scene)`));
    }
    if (flagOf(values, 'slice', true)) {
      views.push(sliceView('axial', data));
    }
    if (flagOf(values, 'profile', true)) {
      views.push({
        name: 'Profile',
        code: `new ${writer.use('MedicalProfile', medicalPackage)}(${data}.axial).configure(c);`,
      });
    }
    if (flagOf(values, 'histogram', true)) {
      const bins = Math.trunc(numberOf(values, 'bins', 512));
      views.push({
        name: 'Histogram',
        code: lines(
          `const histogram = new ${writer.use('MedicalHistogram', medicalPackage)}(${data}.axial, ${String(bins)});`,
          `histogram.region = ${namedHelper(writer)}(${data}.axial, 'Focus');`,
          'histogram.configure(c);',
        ),
      });
    }
    return views.length > 0 ? views : [sliceView('axial', data)];
  },
  columns: columnsOf,
};

function obliqueHelper(writer: CodeWriter): string {
  const display = writer.useType('MedicalMprDisplay', medicalPackage);
  const oblique = writer.use('MedicalObliqueSlice', medicalPackage);
  return writer.helper(
    'obliqueOf',
    lines(
      '// The oblique plane of a display along the line on its axial plane, one for all charts.',
      `const obliques = new WeakMap${writer.language === 'typescript' ? `<${display}, ${oblique}>` : ''}();`,
      `function obliqueOf(${writer.parameter('display', display)})${writer.type(oblique)} {`,
      '  let oblique = obliques.get(display);',
      '  if (!oblique) {',
      `    oblique = new ${oblique}(display);`,
      '    oblique.followLine(display.axial);',
      '    obliques.set(display, oblique);',
      '  }',
      '  return oblique;',
      '}',
    ),
  );
}

const medicalReformat: ChartTypeInfo = {
  id: 'medicalReformat',
  name: 'Medical oblique and curved',
  category: 'medical',
  shape: 'medicalVolume',
  defaultSample: 'thoraxPhantom',
  ownsAxes: true,
  parameters: [
    layoutParameter,
    {
      name: 'volume',
      label: 'Volume in 3D',
      kind: 'flag',
      default: true,
      description: 'With the oblique plane in it; the key V on the oblique plane turns it to face the 3D view.',
    },
    title3D,
    { name: 'axial', label: 'Axial plane', kind: 'flag', default: true },
    { name: 'oblique', label: 'Oblique plane', kind: 'flag', default: true },
    { name: 'curved', label: 'Curved section', kind: 'flag', default: true },
    measurements3D,
    ...windowParameters,
    ...toolParameters,
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const axial = `${data}.axial`;
    return [
      ...lookCode(writer, values, data),
      ...windowCode(writer, values, data),
      `${obliqueHelper(writer)}(${data});`,
      '// A line across the axial plane for the oblique plane, an arc along the front of the body for the curved section.',
      `const width = ${axial}.width * ${axial}.spacing.column;`,
      `const height = ${axial}.height * ${axial}.spacing.row;`,
      `${axial}.measurements.add('distance', [{ x: width * 0.156, y: height * 0.73 }, { x: width * 0.86, y: height * 0.35 }], undefined, 'Oblique plane');`,
      'const arc = Array.from({ length: 13 }, (_, i) => {',
      '  const angle = Math.PI + 0.45 + ((Math.PI - 0.9) * i) / 12;',
      '  return { x: width * (0.5 + 0.396 * Math.cos(angle)), y: height * (0.5 + 0.285 * Math.sin(angle)) };',
      '});',
      `${axial}.measurements.add('freehand', arc, undefined, 'Arc');`,
      ...toolsCode(values, [`${axial}.measurements`]),
      ...(flagOf(values, 'measurements3d', true) ? [] : [`${data}.showsMeasurements3D = false;`]),
    ].join('\n');
  },
  views(writer, series, data) {
    const values = series.parameters;
    const oblique = obliqueHelper(writer);
    const views: ViewCode[] = [];
    if (flagOf(values, 'volume', true)) {
      const configure = lines(
        '{',
        `  ${data}.configure3D(scene);`,
        `  ${oblique}(${data}).configure3D(scene);`,
        `  ${oblique}(${data}).viewCamera = scene.scene.camera;`,
        '  return scene;',
        '}',
      );
      views.push(volumeView(writer, series, configure));
    }
    if (flagOf(values, 'axial', true)) {
      views.push(sliceView('axial', data));
    }
    if (flagOf(values, 'oblique', true)) {
      views.push({ name: 'Oblique', code: `${oblique}(${data}).configure(c);` });
    }
    if (flagOf(values, 'curved', true)) {
      views.push({
        name: 'Curved',
        code: lines(
          `const curved = new ${writer.use('MedicalCurvedSlice', medicalPackage)}(${data}.axial);`,
          `curved.path = ${namedHelper(writer)}(${data}.axial, 'Arc');`,
          'curved.configure(c);',
        ),
      });
    }
    return views.length > 0 ? views : [sliceView('axial', data)];
  },
  columns: columnsOf,
};

const phantom = (id: string, name: string, which: 'head' | 'thorax'): SampleInfo => ({
  id,
  name,
  shape: 'medicalVolume',
  defaultCount: 1,
  hasCount: false,
  body: `return new MedicalMprDisplay(MedicalPhantoms.${which}());`,
  returns: 'MedicalMprDisplay',
  uses: [`${medicalPackage}#MedicalMprDisplay`, `${medicalPackage}#MedicalPhantoms`],
});

// One plane of a phantom as a single image, the way a scanner would store it; at the middle or where given, in
// millimetres.
const image = (id: string, name: string, which: 'head' | 'thorax', plane: string, at?: number): SampleInfo => {
  const place =
    at === undefined
      ? 'display.position'
      : plane === 'axial'
        ? `new Point3D(0, 0, ${num(at)})`
        : plane === 'coronal'
          ? `new Point3D(0, ${num(at)}, 0)`
          : `new Point3D(${num(at)}, 0, 0)`;
  return {
    id,
    name,
    shape: 'medicalImage',
    defaultCount: 1,
    hasCount: false,
    body: lines(
      `const volume = MedicalPhantoms.${which}();`,
      'const display = new MedicalMprDisplay(volume);',
      `const slice = MedicalSlices.cut(volume, ${str(plane)}, ${place});`,
      'const image = new MedicalImageDisplay(slice.values, slice.width, slice.height, slice.spacing, slice.orientation, display.unit);',
      'image.setWindow(display.window.center, display.window.width);',
      'return image;',
    ),
    returns: 'MedicalImageDisplay',
    uses: [
      `${medicalPackage}#MedicalPhantoms`,
      `${medicalPackage}#MedicalMprDisplay`,
      `${medicalPackage}#MedicalSlices`,
      `${medicalPackage}#MedicalImageDisplay`,
      ...(at === undefined ? [] : [`${threeDPackage}#Point3D`]),
    ],
  };
};

/** The medical images: an image or a plane of a volume, with the phantoms of the package as samples. */
export const medicalModule: ChartModule = {
  types: [medicalImage, medicalSlice, medicalMpr, medicalAnalysis, medicalReformat],
  samples: [
    phantom('headPhantom', 'Head phantom', 'head'),
    phantom('thoraxPhantom', 'Thorax phantom', 'thorax'),
    // The planes of the head through the ventricles and the focus, in millimetres.
    image('headAxial', 'Head phantom, axial image', 'head', 'axial', 97),
    image('headCoronal', 'Head phantom, coronal image', 'head', 'coronal', 81.5),
    image('headSagittal', 'Head phantom, sagittal image', 'head', 'sagittal', 86.5),
    image('thoraxAxial', 'Thorax phantom, axial image', 'thorax', 'axial'),
  ],
  load: async () => {
    const [medical, threeD] = await Promise.all([import('@tachyon-charts/medical'), import('@tachyon-charts/3d')]);
    return { [medicalPackage]: { ...medical }, [threeDPackage]: { ...threeD } };
  },
};
