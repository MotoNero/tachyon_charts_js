// The description of a chart the configurator edits, as ChartSpec of the .NET version: the same `.chart.json` files,
// read and written with the same names, so that both configurators open each other's descriptions.

/** Values of parameters by name: numbers, yes/no values or texts. */
export type SpecValues = Record<string, number | boolean | string>;

/** The kind of an axis. */
export type AxisKind = 'numeric' | 'logarithmic' | 'dateTime' | 'category';

/** An axis of a description. */
export interface AxisSpec {
  /** The name it is known by. */
  id: string;
  /** What kind it is. */
  kind: AxisKind;
  /** The title. */
  title: string;
  /** The lowest value, if any. */
  minimum?: number | undefined;
  /** The highest value, if any. */
  maximum?: number | undefined;
  /** Whether the axis runs against its usual direction. */
  isInverted: boolean;
  /** Whether the axis stands on the opposite side. */
  isOpposite: boolean;
  /** Whether a time axis leaves out weekends. */
  skipsWeekends: boolean;
  /** The categories, separated by commas. */
  categories: string;
  /** Whether the axis crosses the other one at zero. */
  crossesZero: boolean;
  /** Ranges left out, such as `2..3, 5..6`. */
  breaks: string;
  /** The pane the axis belongs to. */
  pane: number;
  /** The share of the height of its pane. */
  paneWeight: number;
  /** Whether the axis takes no room and draws nothing. */
  isHidden: boolean;
  /** The base of a logarithmic axis. */
  logBase: number;
  /** How a logarithmic axis treats values of zero and below. */
  nonPositive: string;
  /** The lowest value a logarithmic axis shows. */
  floor?: number | undefined;
  /** The turn of the labels in degrees. */
  labelRotation: number;
}

/** Where the data of a series come from. */
export type DataKind = 'sample' | 'csv' | 'live' | 'medicalFile' | 'hdf5' | 'file';

/** The data of a series. */
export interface DataSpec {
  /** What kind it is. */
  kind: DataKind;
  /** The sample data. */
  sample: string;
  /** The number of values. */
  count: number;
  /** Further options of the data. */
  options: SpecValues;
  /** The file, for data from a file. */
  path?: string | undefined;
}

/** A series of a description. */
export interface SeriesSpec {
  /** The type. */
  type: string;
  /** The name shown. */
  name: string;
  /** The X axis, or the first one when left out. */
  xAxis?: string | undefined;
  /** The Y axis, or the first one when left out. */
  yAxis?: string | undefined;
  /** The parameters. */
  parameters: SpecValues;
  /** Where the data come from. */
  data: DataSpec;
}

/** An interaction of a description. */
export interface ModifierSpec {
  /** The type. */
  type: string;
  /** The parameters. */
  parameters: SpecValues;
}

/** A legend of a description. */
export interface LegendSpec {
  /** The title. */
  title: string;
  /** Where the legend stands. */
  placement: string;
  /** The series. */
  series: string;
}

/** An annotation of a description. */
export interface AnnotationSpec {
  /** The type. */
  type: string;
  /** The parameters. */
  parameters: SpecValues;
}

/** A font of a description. */
export interface FontSpec {
  /** The family of the font. */
  family: string;
  /** Whether the font is bold. */
  bold: boolean;
  /** Whether the font is italic. */
  italic: boolean;
}

/** A theme of its own: a built-in base with some values changed. */
export interface ThemeSpec {
  /** The name shown. */
  name: string;
  /** The built-in theme it changes. */
  base: string;
  /** The changed values by name. */
  values: Record<string, string>;
}

/** The description of a chart, or of several linked charts in `charts`. */
export interface ChartSpec {
  /** The version of the format. */
  version: number;
  /** The title. */
  title: string;
  /** The built-in theme, if any. */
  theme?: string | undefined;
  /** A theme of its own, if any. */
  ownTheme?: ThemeSpec | undefined;
  /** The font of the title, if not the usual one. */
  titleFont?: FontSpec | undefined;
  /** The font of the axes, if not the usual one. */
  axisFont?: FontSpec | undefined;
  /** Whether the X axis runs downwards. */
  xDown: boolean;
  /** The group of charts it shows the same X range with. */
  group?: string | undefined;
  /** The X axes. */
  xAxes: AxisSpec[];
  /** The Y axes. */
  yAxes: AxisSpec[];
  /** The series. */
  series: SeriesSpec[];
  /** The interactions. */
  modifiers: ModifierSpec[];
  /** The legend, if any. */
  legend?: LegendSpec | undefined;
  /** Whether the chart offers export. */
  exportMenu: boolean;
  /** Whether an overview shows below the chart. */
  overview: boolean;
  /** The annotations. */
  annotations: AnnotationSpec[];
  /** A second legend, if any. */
  secondLegend?: LegendSpec | undefined;
  /** The settings of a 3D scene. */
  scene: SpecValues;
  /** Linked charts that show together. */
  charts: ChartSpec[];
  /** The columns of linked charts. */
  columns: number;
}

/** The version of the format the configurator writes. */
export const chartSpecVersion = 1;

/** A description that cannot be read. */
export class ChartSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChartSpecError';
  }
}

/** An axis with the values a new one has. */
export function newAxis(id: string, kind: AxisKind = 'numeric'): AxisSpec {
  return {
    id,
    kind,
    title: '',
    isInverted: false,
    isOpposite: false,
    skipsWeekends: false,
    categories: '',
    crossesZero: false,
    breaks: '',
    pane: 0,
    paneWeight: 1,
    isHidden: false,
    logBase: 10,
    nonPositive: 'Hide',
    labelRotation: 0,
  };
}

/** An empty description with an X and a Y axis. */
export function newChartSpec(): ChartSpec {
  return {
    version: chartSpecVersion,
    title: '',
    xDown: false,
    xAxes: [newAxis('x')],
    yAxes: [newAxis('y')],
    series: [],
    modifiers: [],
    exportMenu: false,
    overview: false,
    annotations: [],
    scene: {},
    charts: [],
    columns: 0,
  };
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const flag = (value: unknown, fallback = false): boolean => (typeof value === 'boolean' ? value : fallback);
const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const optionalText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function readValues(value: unknown, where: string): SpecValues {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isObject(value)) {
    throw new ChartSpecError(`The parameters of ${where} are no object of names and values.`);
  }
  const values: SpecValues = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new ChartSpecError(`The parameter ${name} of ${where} is not finite.`);
      }
      values[name] = item;
    } else if (typeof item === 'boolean' || typeof item === 'string') {
      values[name] = item;
    } else {
      throw new ChartSpecError(`The parameter ${name} of ${where} is no number, yes/no value or text.`);
    }
  }
  return values;
}

const axisKinds: Record<string, AxisKind> = {
  numeric: 'numeric',
  logarithmic: 'logarithmic',
  datetime: 'dateTime',
  category: 'category',
};

function readAxis(value: unknown, fallbackId: string): AxisSpec {
  const json = isObject(value) ? value : {};
  const axis = newAxis(text(json.id, fallbackId), axisKinds[text(json.kind, 'numeric').toLowerCase()] ?? 'numeric');
  axis.title = text(json.title);
  axis.minimum = optionalNumber(json.minimum);
  axis.maximum = optionalNumber(json.maximum);
  axis.isInverted = flag(json.isInverted);
  axis.isOpposite = flag(json.isOpposite);
  axis.skipsWeekends = flag(json.skipsWeekends);
  axis.categories = text(json.categories);
  axis.crossesZero = flag(json.crossesZero);
  axis.breaks = text(json.breaks);
  axis.pane = num(json.pane, 0);
  axis.paneWeight = num(json.paneWeight, 1);
  axis.isHidden = flag(json.isHidden);
  axis.logBase = num(json.logBase, 10);
  axis.nonPositive = text(json.nonPositive, 'Hide');
  axis.floor = optionalNumber(json.floor);
  axis.labelRotation = num(json.labelRotation, 0);
  return axis;
}

const dataKinds: Record<string, DataKind> = {
  sample: 'sample',
  csv: 'csv',
  live: 'live',
  medicalfile: 'medicalFile',
  hdf5: 'hdf5',
  file: 'file',
};

function readSeries(value: unknown, index: number): SeriesSpec {
  if (!isObject(value)) {
    throw new ChartSpecError(`Series ${String(index + 1)} is no object.`);
  }
  const data = isObject(value.data) ? value.data : {};
  const where = `series ${String(index + 1)}`;
  return {
    type: text(value.type, 'line'),
    name: text(value.name),
    xAxis: optionalText(value.xAxis),
    yAxis: optionalText(value.yAxis),
    parameters: readValues(value.parameters, where),
    data: {
      kind: dataKinds[text(data.kind, 'sample').toLowerCase()] ?? 'sample',
      sample: text(data.sample, 'sine'),
      count: num(data.count, 1000),
      options: readValues(data.options, `the data of ${where}`),
      path: optionalText(data.path),
    },
  };
}

function readLegend(value: unknown): LegendSpec | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return {
    title: text(value.title),
    placement: text(value.placement, 'TopRight'),
    series: text(value.series),
  };
}

function readFont(value: unknown): FontSpec | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return { family: text(value.family, 'Default'), bold: flag(value.bold), italic: flag(value.italic) };
}

function readSpec(json: Json): ChartSpec {
  const version = num(json.version, chartSpecVersion);
  if (version > chartSpecVersion) {
    throw new ChartSpecError(`The description was written by a newer version (${String(version)}).`);
  }
  const ownTheme = isObject(json.ownTheme) ? json.ownTheme : undefined;
  return {
    version,
    title: text(json.title),
    theme: optionalText(json.theme),
    ownTheme: ownTheme
      ? {
          name: text(ownTheme.name, 'Own'),
          base: text(ownTheme.base, 'TachyonDark'),
          values: Object.fromEntries(
            Object.entries(isObject(ownTheme.values) ? ownTheme.values : {}).map(([key, item]) => [key, text(item)]),
          ),
        }
      : undefined,
    titleFont: readFont(json.titleFont),
    axisFont: readFont(json.axisFont),
    xDown: flag(json.xDown),
    group: optionalText(json.group),
    xAxes: list(json.xAxes).map((axis) => readAxis(axis, 'x')),
    yAxes: list(json.yAxes).map((axis) => readAxis(axis, 'y')),
    series: list(json.series).map(readSeries),
    modifiers: list(json.modifiers).map((item, i) => {
      const modifier = isObject(item) ? item : {};
      return {
        type: text(modifier.type, 'zoompan'),
        parameters: readValues(modifier.parameters, `interaction ${String(i + 1)}`),
      };
    }),
    legend: readLegend(json.legend),
    exportMenu: flag(json.exportMenu),
    overview: flag(json.overview),
    annotations: list(json.annotations).map((item, i) => {
      const annotation = isObject(item) ? item : {};
      return {
        type: text(annotation.type, 'hline'),
        parameters: readValues(annotation.parameters, `annotation ${String(i + 1)}`),
      };
    }),
    secondLegend: readLegend(json.secondLegend),
    scene: readValues(json.scene, 'the scene'),
    charts: list(json.charts).map((chart) => readSpec(isObject(chart) ? chart : {})),
    columns: num(json.columns, 0),
  };
}

/**
 * Reads a description from the text of a `.chart.json` file.
 * @throws ChartSpecError when the text is no description or was written by a newer version.
 */
export function readChartSpec(json: string): ChartSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ChartSpecError(
      `The text is no description of a chart: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed)) {
    throw new ChartSpecError('The text is no description of a chart.');
  }
  return readSpec(parsed);
}

const axisKindNames: Record<AxisKind, string> = {
  numeric: 'numeric',
  logarithmic: 'logarithmic',
  dateTime: 'dateTime',
  category: 'category',
};

function writeAxis(axis: AxisSpec): Json {
  return {
    id: axis.id,
    kind: axisKindNames[axis.kind],
    title: axis.title,
    ...(axis.minimum === undefined ? {} : { minimum: axis.minimum }),
    ...(axis.maximum === undefined ? {} : { maximum: axis.maximum }),
    isInverted: axis.isInverted,
    isOpposite: axis.isOpposite,
    skipsWeekends: axis.skipsWeekends,
    categories: axis.categories,
    crossesZero: axis.crossesZero,
    breaks: axis.breaks,
    pane: axis.pane,
    paneWeight: axis.paneWeight,
    isHidden: axis.isHidden,
    logBase: axis.logBase,
    nonPositive: axis.nonPositive,
    ...(axis.floor === undefined ? {} : { floor: axis.floor }),
    labelRotation: axis.labelRotation,
    isAutoRange: axis.minimum === undefined || axis.maximum === undefined,
  };
}

const sorted = (values: SpecValues): SpecValues =>
  Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function writeSpec(spec: ChartSpec): Json {
  return {
    version: spec.version,
    title: spec.title,
    ...(spec.theme === undefined ? {} : { theme: spec.theme }),
    ...(spec.ownTheme === undefined ? {} : { ownTheme: spec.ownTheme }),
    ...(spec.titleFont === undefined ? {} : { titleFont: spec.titleFont }),
    ...(spec.axisFont === undefined ? {} : { axisFont: spec.axisFont }),
    xDown: spec.xDown,
    ...(spec.group === undefined ? {} : { group: spec.group }),
    xAxes: spec.xAxes.map(writeAxis),
    yAxes: spec.yAxes.map(writeAxis),
    series: spec.series.map((series) => ({
      type: series.type,
      name: series.name,
      ...(series.xAxis === undefined ? {} : { xAxis: series.xAxis }),
      ...(series.yAxis === undefined ? {} : { yAxis: series.yAxis }),
      parameters: sorted(series.parameters),
      data: {
        kind: series.data.kind,
        sample: series.data.sample,
        count: series.data.count,
        options: sorted(series.data.options),
        ...(series.data.path === undefined || series.data.kind === 'medicalFile' ? {} : { path: series.data.path }),
      },
    })),
    modifiers: spec.modifiers.map((modifier) => ({ type: modifier.type, parameters: sorted(modifier.parameters) })),
    ...(spec.legend === undefined ? {} : { legend: spec.legend }),
    exportMenu: spec.exportMenu,
    overview: spec.overview,
    annotations: spec.annotations.map((annotation) => ({
      type: annotation.type,
      parameters: sorted(annotation.parameters),
    })),
    ...(spec.secondLegend === undefined ? {} : { secondLegend: spec.secondLegend }),
    scene: sorted(spec.scene),
    ...(spec.charts.length === 0 ? {} : { charts: spec.charts.map(writeSpec) }),
    ...(spec.columns === 0 ? {} : { columns: spec.columns }),
  };
}

/** Writes a description as the text of a `.chart.json` file, indented as the .NET version writes it. */
export function writeChartSpec(spec: ChartSpec): string {
  return JSON.stringify(writeSpec(spec), undefined, 2);
}

/** A number of parameters, or the fallback when it is missing or of another kind. */
export function numberOf(values: SpecValues, name: string, fallback: number): number {
  const value = values[name];
  return typeof value === 'number' ? value : fallback;
}

/** A yes/no value of parameters, or the fallback. */
export function flagOf(values: SpecValues, name: string, fallback = false): boolean {
  const value = values[name];
  return typeof value === 'boolean' ? value : fallback;
}

/** A text of parameters, or the fallback. */
export function textOf(values: SpecValues, name: string, fallback = ''): string {
  const value = values[name];
  return typeof value === 'string' ? value : fallback;
}
