// The annotations of the configurator, as AnnotationCatalog of the .NET version: lines, bands, boxes, text and lines
// between two points, with label, color and the look of label and line; they go on the first X and value axis.
import type { AnnotationInfo, ParameterInfo } from './catalog';
import { camel } from './build';
import { num, str, type CodeWriter } from './code';
import { colorCode } from './series-code';
import { flagOf, numberOf, textOf, type SpecValues } from './spec';

const color: ParameterInfo = {
  name: 'color',
  label: 'Color',
  kind: 'color',
  default: '',
  description: 'Empty for the usual color.',
};
const label: ParameterInfo = { name: 'label', label: 'Label', kind: 'text', default: '' };
const fonts = ['Default', 'Roboto', 'Roboto Slab', 'Arial', 'Segoe UI', 'Consolas'];

const look: readonly ParameterInfo[] = [
  {
    name: 'labelPlace',
    label: 'Label along',
    kind: 'choice',
    default: 'Auto',
    choices: ['Auto', 'Start', 'Middle', 'End'],
    description: 'Where the label stands along its line: at the start, in the middle or at the end.',
  },
  {
    name: 'labelSide',
    label: 'Label beside',
    kind: 'choice',
    default: 'Auto',
    choices: ['Auto', 'Before', 'After'],
    description: 'Before: above a level line, left of an upright one; After: the other side.',
  },
  { name: 'labelOffset', label: 'Label distance', kind: 'number', default: 0, minimum: -200, maximum: 200 },
  {
    name: 'labelSize',
    label: 'Label size',
    kind: 'number',
    default: 0,
    minimum: 0,
    maximum: 72,
    description: 'The size of the text; 0 for that of the chart.',
  },
  { name: 'labelFont', label: 'Label font', kind: 'choice', default: 'Default', choices: fonts },
  { name: 'labelBold', label: 'Label bold', kind: 'flag', default: false },
  { name: 'labelItalic', label: 'Label italic', kind: 'flag', default: false },
  { name: 'labelColor', label: 'Label text color', kind: 'color', default: '' },
  {
    name: 'labelFill',
    label: 'Label plate',
    kind: 'color',
    default: '',
    description: 'A transparent color leaves the plate out.',
  },
  { name: 'labelBorder', label: 'Label border', kind: 'color', default: '', description: 'Empty for none.' },
  { name: 'labelBorderWidth', label: 'Label border width', kind: 'number', default: 1, minimum: 0.5, maximum: 10 },
  {
    name: 'labelTurn',
    label: 'Label turn',
    kind: 'choice',
    default: 'Level',
    choices: ['Level', 'AlongLine', 'Angle'],
  },
  { name: 'labelAngle', label: 'Label angle', kind: 'number', default: 0, minimum: -180, maximum: 180 },
  {
    name: 'labelIcon',
    label: 'Label sign',
    kind: 'choice',
    default: 'None',
    choices: ['None', 'Warning', 'Info', 'Arrow', 'Marker'],
  },
  { name: 'labelIconColor', label: 'Label sign color', kind: 'color', default: '' },
  { name: 'dash', label: 'Line', kind: 'choice', default: 'Solid', choices: ['Solid', 'Dashed', 'Dotted'] },
  {
    name: 'thickness',
    label: 'Line width',
    kind: 'number',
    default: 0,
    minimum: 0,
    maximum: 20,
    description: '0 for that of the annotation.',
  },
];

// Only what differs from the plain look, as LookCode of the .NET version.
function appearance(values: SpecValues): string | undefined {
  const parts: string[] = [];
  const choice = (name: string, standard: string, property: string): void => {
    const chosen = textOf(values, name, standard);
    if (chosen !== standard) {
      parts.push(`${property}: ${str(camel(chosen))}`);
    }
  };
  const colored = (name: string, property: string): void => {
    const chosen = colorCode(values, name);
    if (chosen) {
      parts.push(`${property}: ${chosen}`);
    }
  };
  choice('labelPlace', 'Auto', 'labelPlace');
  choice('labelSide', 'Auto', 'labelSide');
  if (numberOf(values, 'labelOffset', 0) !== 0) {
    parts.push(`labelOffset: ${num(numberOf(values, 'labelOffset', 0))}`);
  }
  if (numberOf(values, 'labelSize', 0) > 0) {
    parts.push(`labelSize: ${num(numberOf(values, 'labelSize', 0))}`);
  }
  const family = textOf(values, 'labelFont', 'Default');
  const font = [
    ...(family === 'Default' ? [] : [`family: ${str(family)}`]),
    ...(flagOf(values, 'labelBold') ? ['bold: true'] : []),
    ...(flagOf(values, 'labelItalic') ? ['italic: true'] : []),
  ];
  if (font.length > 0) {
    parts.push(`labelFont: { ${font.join(', ')} }`);
  }
  colored('labelColor', 'labelColor');
  colored('labelFill', 'labelFill');
  colored('labelBorder', 'labelBorder');
  if (numberOf(values, 'labelBorderWidth', 1) !== 1) {
    parts.push(`labelBorderThickness: ${num(numberOf(values, 'labelBorderWidth', 1))}`);
  }
  choice('labelTurn', 'Level', 'labelTurn');
  if (numberOf(values, 'labelAngle', 0) !== 0) {
    parts.push(`labelAngle: ${num(numberOf(values, 'labelAngle', 0))}`);
  }
  choice('labelIcon', 'None', 'labelIcon');
  colored('labelIconColor', 'labelIconColor');
  choice('dash', 'Solid', 'dash');
  if (numberOf(values, 'thickness', 0) > 0) {
    parts.push(`thickness: ${num(numberOf(values, 'thickness', 0))}`);
  }
  return parts.length === 0 ? undefined : `{ ${parts.join(', ')} }`;
}

// The annotation made, its members set, and a call that places it.
function annotationCode(
  _writer: CodeWriter,
  values: SpecValues,
  editable: boolean,
  make: string,
  members: readonly string[],
  place?: string,
  standardColor = '',
): string {
  const chosen = colorCode({ color: textOf(values, 'color', standardColor) }, 'color');
  const label = textOf(values, 'label');
  const look = appearance(values);
  const all = [
    ...members,
    ...(label.length > 0 ? [`label: ${str(label)}`] : []),
    ...(chosen ? [`color: ${chosen}`] : []),
    ...(editable ? ['isEditable: true'] : []),
    ...(look ? [`appearance: ${look}`] : []),
  ];
  const made = all.length === 0 ? make : `Object.assign(${make}, { ${all.join(', ')} })`;
  if (!place) {
    return made;
  }
  return `(() => {\n  const annotation = ${made};\n  annotation.${place};\n  return annotation;\n})()`;
}

const x = 'chart.horizontalAxes[0]';
const y = 'chart.panes[0]?.axes[0]';

function axes(writer: CodeWriter): { x: string; y: string } {
  const axis = writer.useType('Axis');
  return { x: writer.as(x, axis), y: writer.as(y, axis) };
}

/** The annotations of the core. */
export const coreAnnotations: readonly AnnotationInfo[] = [
  {
    id: 'hline',
    name: 'Horizontal line',
    parameters: [{ name: 'y', label: 'Value', kind: 'number', default: 0.5 }, label, color, ...look],
    code: (writer, values, editable) =>
      annotationCode(writer, values, editable, `new ${writer.use('HorizontalLineAnnotation')}(${axes(writer).y})`, [
        `y: ${num(numberOf(values, 'y', 0.5))}`,
      ]),
  },
  {
    id: 'vline',
    name: 'Vertical line',
    parameters: [{ name: 'x', label: 'Place', kind: 'number', default: 5 }, label, color, ...look],
    code: (writer, values, editable) =>
      annotationCode(writer, values, editable, `new ${writer.use('VerticalLineAnnotation')}(${axes(writer).x})`, [
        `x: ${num(numberOf(values, 'x', 5))}`,
      ]),
  },
  {
    id: 'band',
    name: 'Band',
    parameters: [
      { name: 'from', label: 'From', kind: 'number', default: 2 },
      { name: 'to', label: 'To', kind: 'number', default: 4 },
      {
        name: 'color',
        label: 'Color',
        kind: 'color',
        default: '#F0BE5A30',
        description: 'A band covers what lies behind it; a color with little opacity keeps that visible.',
      },
      label,
      ...look,
    ],
    code: (writer, values, editable) =>
      annotationCode(
        writer,
        values,
        editable,
        `new ${writer.use('BandAnnotation')}(${axes(writer).x})`,
        [],
        `setRange(${num(numberOf(values, 'from', 2))}, ${num(numberOf(values, 'to', 4))})`,
        '#F0BE5A30',
      ),
  },
  {
    id: 'box',
    name: 'Box',
    parameters: [
      { name: 'x1', label: 'Left', kind: 'number', default: 6 },
      { name: 'y1', label: 'Bottom', kind: 'number', default: -0.5 },
      { name: 'x2', label: 'Right', kind: 'number', default: 8 },
      { name: 'y2', label: 'Top', kind: 'number', default: 0.5 },
      label,
      color,
      ...look,
    ],
    code: (writer, values, editable) =>
      annotationCode(
        writer,
        values,
        editable,
        `new ${writer.use('BoxAnnotation')}(${axes(writer).x}, ${axes(writer).y})`,
        [],
        `setCorners(${['x1', 'y1', 'x2', 'y2'].map((name, i) => num(numberOf(values, name, [6, -0.5, 8, 0.5][i] ?? 0))).join(', ')})`,
      ),
  },
  {
    id: 'text',
    name: 'Text',
    parameters: [
      { name: 'x', label: 'Place', kind: 'number', default: 1 },
      { name: 'y', label: 'Value', kind: 'number', default: 0.8 },
      { name: 'text', label: 'Text', kind: 'text', default: 'Note' },
      { name: 'size', label: 'Font size', kind: 'number', default: 13, minimum: 6, maximum: 72 },
      color,
      ...look,
    ],
    code: (writer, values, editable) =>
      annotationCode(
        writer,
        values,
        editable,
        `new ${writer.use('TextAnnotation')}(${axes(writer).x}, ${axes(writer).y})`,
        [`text: ${str(textOf(values, 'text', 'Note'))}`, `fontSize: ${num(numberOf(values, 'size', 13))}`],
        `moveTo(${num(numberOf(values, 'x', 1))}, ${num(numberOf(values, 'y', 0.8))})`,
      ),
  },
  {
    id: 'line',
    name: 'Line',
    parameters: [
      { name: 'x1', label: 'Start place', kind: 'number', default: 2 },
      { name: 'y1', label: 'Start value', kind: 'number', default: -0.5 },
      { name: 'x2', label: 'End place', kind: 'number', default: 8 },
      { name: 'y2', label: 'End value', kind: 'number', default: 0.5 },
      label,
      color,
      ...look,
    ],
    code: (writer, values, editable) =>
      annotationCode(
        writer,
        values,
        editable,
        `new ${writer.use('LineAnnotation')}(${axes(writer).x}, ${axes(writer).y})`,
        [],
        `setEnds(${['x1', 'y1', 'x2', 'y2'].map((name, i) => num(numberOf(values, name, [2, -0.5, 8, 0.5][i] ?? 0))).join(', ')})`,
      ),
  },
];
