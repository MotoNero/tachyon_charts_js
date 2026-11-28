// The medical images of the configurator, as MedicalModule and MedicalSetup of the .NET version: an image or a plane of
// a volume with window, colors, example measurements, measuring tools and the segments of the phantoms.
import type { ChartModule, ChartTypeInfo, ParameterInfo, SampleInfo } from './catalog';
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
  types: [medicalImage, medicalSlice],
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
