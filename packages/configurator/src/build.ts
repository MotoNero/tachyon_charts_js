// The code of a chart from its description, and the chart itself by running that code, as CodeGenerator and
// SpecChartBuilder of the .NET version in one: the preview and the code cannot differ.
import * as core from '@tachyon-charts/core';
import { ChartBuilder } from '@tachyon-charts/core';
import { axesOf, type ChartCatalog, type SampleInfo } from './catalog';
import { CodeWriter, identifier, num, str, type CodeLanguage } from './code';
import type { AxisSpec, ChartSpec, FontSpec, LegendSpec, ThemeSpec } from './spec';

/** A description that cannot be shown, with what keeps it from it. */
export class ChartSpecProblem extends Error {
  /** @param problems - What keeps it from being shown. */
  constructor(
    /** What keeps it from being shown. */
    readonly problems: readonly string[],
  ) {
    super(problems.join(' '));
    this.name = 'ChartSpecProblem';
  }
}

/** The packages the code of a chart may import, by name; modules add theirs. */
export const codePackages: Record<string, Record<string, unknown>> = { '@tachyon-charts/core': core };

/** A name of the .NET version, such as NameAndPercent, as the JS version spells it, nameAndPercent. */
export function camel(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

/** The id of a built-in theme for its name in a description, such as TachyonDark: tachyon-dark. */
export function themeId(name: string): string {
  return name.replace(/([a-z])([A-Z])/gu, '$1-$2').toLowerCase();
}

/** The ranges of the breaks of an axis, such as `2..3, 5..6`, or undefined when one does not read. */
export function breaksOf(text: string): [number, number][] | undefined {
  const ranges: [number, number][] = [];
  for (const part of text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)) {
    const ends = part.split('..').map((item) => item.trim());
    const from = Number(ends[0]);
    const to = Number(ends[1]);
    if (ends.length !== 2 || !Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) {
      return undefined;
    }
    ranges.push([from, to]);
  }
  return ranges;
}

function roundHelper(writer: CodeWriter): void {
  writer.helper(
    'round',
    [
      '// Rounds halves to the even neighbour, as the sample data of the .NET version do.',
      `function round(value${writer.type('number')})${writer.type('number')} {`,
      '  const floor = Math.floor(value);',
      '  const rest = value - floor;',
      '  return rest === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);',
      '}',
    ].join('\n'),
  );
}

function sampleFunction(writer: CodeWriter, sample: SampleInfo): string {
  const name = identifier(sample.id);
  for (const used of sample.uses) {
    const [from, name] = used.includes('#') ? used.split('#') : ['@tachyon-charts/core', used];
    if (used === 'round') {
      roundHelper(writer);
    } else if (from !== undefined && name !== undefined) {
      // A name only the type of the result mentions is a type: imported as one, so that JavaScript leaves it out.
      const inBody = new RegExp(`\\b${name}\\b`, 'u').test(sample.body);
      if (inBody) {
        writer.use(name, from);
      } else {
        writer.useType(name, from);
      }
    }
  }
  if (sample.returns.includes('Rgba8')) {
    writer.useType('Rgba8');
  }
  const parameter = sample.hasCount === false ? '' : `count${writer.type('number')}`;
  const body = sample.body
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return writer.helper(
    name,
    `// ${sample.name}.\nfunction ${name}(${parameter})${writer.type(sample.returns)} {\n${body}\n}`,
  );
}

function axisCode(writer: CodeWriter, spec: AxisSpec, opposite: 'top' | 'right'): string {
  let code = 'a';
  switch (spec.kind) {
    case 'logarithmic':
      code += `.log(${str(spec.id)}, ${num(spec.logBase)}, ${str(spec.nonPositive.toLowerCase())})`;
      break;
    case 'dateTime':
      code += `.dateTime(${str(spec.id)})`;
      break;
    case 'category':
      code += `.category([${spec.categories
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map(str)
        .join(', ')}], ${str(spec.id)})`;
      break;
    default:
      code += `.numeric(${str(spec.id)})`;
  }
  if (spec.title.length > 0) {
    code += `.title(${str(spec.title)})`;
  }
  code +=
    spec.minimum !== undefined && spec.maximum !== undefined
      ? `.range(${num(spec.minimum)}, ${num(spec.maximum)})`
      : '.autoRange()';
  if (spec.isInverted) {
    code += '.inverted()';
  }
  if (spec.isOpposite) {
    code += `.position(${str(opposite)})`;
  }
  if (spec.crossesZero) {
    code += '.crossesAt(0)';
  }
  if (spec.labelRotation !== 0) {
    code += `.labelRotation(${num(spec.labelRotation)})`;
  }
  if (spec.kind === 'logarithmic' && spec.floor !== undefined) {
    code += `.floor(${num(spec.floor)})`;
  }
  const breaks = breaksOf(spec.breaks);
  if (breaks && breaks.length > 0) {
    const range = writer.use('DoubleRange');
    code += `.breaks(${breaks.map(([from, to]) => `new ${range}(${num(from)}, ${num(to)})`).join(', ')})`;
  }
  if (spec.pane > 0 || spec.paneWeight !== 1) {
    code += `.pane(${num(spec.pane)}, ${num(spec.paneWeight)})`;
  }
  if (spec.isHidden) {
    code += '.hidden()';
  }
  return code;
}

function legendCode(spec: LegendSpec): string {
  let code = 'l';
  if (spec.title.length > 0) {
    code += `.title(${str(spec.title)})`;
  }
  if (spec.placement !== 'TopRight') {
    code += `.place(${str(camel(spec.placement))})`;
  }
  const names = spec.series
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (names.length > 0) {
    code += `.series(${names.map(str).join(', ')})`;
  }
  return code === 'l' ? 'c.legend();' : `c.legend((l) => ${code});`;
}

interface CodeParts {
  readonly writer: CodeWriter;
  readonly describe: string;
  /** Whether the code describes several charts with `describeCharts` instead of one with `describeChart`. */
  readonly several: boolean;
}

// The linked charts of a type with views: the data and their preparation once, then a function per chart.
function describeViews(
  spec: ChartSpec,
  catalog: ChartCatalog,
  writer: CodeWriter,
  language: CodeLanguage,
): string | undefined {
  const series = spec.series[0];
  const type = series && spec.series.length === 1 ? catalog.findType(series.type) : undefined;
  const sample = series ? catalog.findSample(series.data.sample) : undefined;
  if (!series || !type?.views || !sample) {
    return undefined;
  }
  const make = sampleFunction(writer, sample);
  const data = `${make}Data`;
  const lines = [`const ${data} = ${make}(${sample.hasCount === false ? '' : num(series.data.count)});`];
  const setup = type.code(writer, series, data, axesOf(spec, series), 0);
  if (setup.length > 0) {
    lines.push(setup);
  }
  const views = type.views(writer, series, data);
  const builder = writer.use('ChartBuilder');
  const theme =
    spec.theme === undefined
      ? []
      : [
          `c.theme(${writer.as(`${writer.use('findBuiltInTheme')}(${str(themeId(spec.theme))})`, writer.useType('ThemeDocument'))});`,
        ];
  // Each chart in a function of its own inside, so that all of them reach the data and what the preparation made.
  const functions = views.map((view) =>
    [
      `// The chart ${view.name}.`,
      `const describe${view.name} = (${writer.parameter('c', builder)})${writer.type(builder)} => {`,
      ...[...theme, ...view.code.split('\n')].map((line) => `  ${line}`),
      '  return c;',
      '};',
    ].join('\n'),
  );
  const columns = Math.max(1, type.columns?.(series, views.length) ?? Math.min(2, views.length));
  const running = writer.isLive ? `${writer.parameter('running', '(() => void)[]')} = []` : '';
  const result = language === 'typescript' ? `: { charts: ${builder}[]; columns: number }` : '';
  return [
    `export function describeCharts(${running})${result} {`,
    ...[...lines, ...functions].flatMap((line) => line.split('\n')).map((line) => `  ${line}`),
    '  return {',
    `    columns: ${String(columns)},`,
    `    charts: [${views.map((view) => `describe${view.name}(new ${builder}())`).join(', ')}],`,
    '  };',
    '}',
  ].join('\n');
}

// The names of the data made so far, shared by the charts of one description.
interface DataNames {
  readonly taken: Map<string, number>;
  readonly made: Map<string, string>;
}

// A chart of a description: the statements that make its data, those that describe it on the chart builder `c`, and
// the names of the data per series.
interface ChartParts {
  readonly data: string[];
  readonly body: string[];
  readonly names: (string | undefined)[];
}

const fontCode = (font: FontSpec): string => {
  const parts = [
    ...(font.family.length > 0 && font.family !== 'Default' ? [`family: ${str(font.family)}`] : []),
    ...(font.bold ? ['bold: true'] : []),
    ...(font.italic ? ['italic: true'] : []),
  ];
  return `{ ${parts.join(', ')} }`;
};

// A theme of its own: the values by their dotted names, nested as a theme document on the built-in base.
function ownThemeCode(writer: CodeWriter, theme: ThemeSpec): string {
  const groups = new Map<string, string[]>();
  const top: string[] = [`name: ${str(theme.name)}`, `base: ${str(themeId(theme.base))}`];
  for (const [key, value] of Object.entries(theme.values)) {
    if (key === 'palette') {
      top.push(
        `palette: [${value
          .split(',')
          .map((part) => str(part.trim()))
          .join(', ')}]`,
      );
      continue;
    }
    const [group, ...rest] = key.split('.');
    if (group === undefined || rest.length === 0) {
      continue;
    }
    const entries = groups.get(group) ?? [];
    entries.push(`${rest.join('.')}: ${str(value)}`);
    groups.set(group, entries);
  }
  for (const [group, entries] of groups) {
    top.push(`${group}: { ${entries.join(', ')} }`);
  }
  return `${writer.use('resolveTheme')}({ ${top.join(', ')} })`;
}

function chartParts(
  spec: ChartSpec,
  catalog: ChartCatalog,
  writer: CodeWriter,
  names: DataNames,
  reuse?: readonly (string | undefined)[],
): ChartParts {
  const data: string[] = [];
  const lines: string[] = [];
  const dataNames: (string | undefined)[] = [];
  const scene = catalog.scene;
  const inScene = scene !== undefined && spec.series.some((series) => catalog.findType(series.type)?.inScene === true);
  if (spec.title.length > 0 && !inScene) {
    lines.push(`c.title(${str(spec.title)});`);
  }
  if (spec.ownTheme !== undefined) {
    lines.push(`c.theme(${ownThemeCode(writer, spec.ownTheme)});`);
  } else if (spec.theme !== undefined) {
    const find = writer.use('findBuiltInTheme');
    lines.push(`c.theme(${writer.as(`${find}(${str(themeId(spec.theme))})`, writer.useType('ThemeDocument'))});`);
  }
  if (spec.titleFont !== undefined) {
    lines.push(`c.titleFont(${fontCode(spec.titleFont)});`);
  }
  if (spec.axisFont !== undefined) {
    lines.push(`c.axisFont(${fontCode(spec.axisFont)});`);
  }
  const ownsAxes = spec.series.some((series) => catalog.findType(series.type)?.ownsAxes === true);
  if (!ownsAxes) {
    for (const axis of spec.xAxes) {
      lines.push(`c.xAxis((a) => ${axisCode(writer, axis, 'top')});`);
    }
    for (const axis of spec.yAxes) {
      lines.push(`c.yAxis((a) => ${axisCode(writer, axis, 'right')});`);
    }
  }
  const sceneLines: string[] = [];
  spec.series.forEach((series, index) => {
    const type = catalog.findType(series.type);
    const sample = catalog.findSample(series.data.sample);
    if (!type || !sample) {
      dataNames.push(undefined);
      return;
    }
    const axes = { ...axesOf(spec, series), inSharedBox: sceneLines.length > 0 };
    if (type.noData === true) {
      dataNames.push(undefined);
      (type.inScene === true ? sceneLines : lines).push(type.code(writer, series, '', axes, index));
      return;
    }
    let name = reuse?.[index];
    if (name === undefined) {
      const make = sampleFunction(writer, sample);
      const count = Math.min(series.data.count, sample.maximumCount ?? Number.POSITIVE_INFINITY);
      const argument = sample.hasCount === false ? '' : num(count);
      if (count < series.data.count) {
        data.push(`// ${num(series.data.count)} in the description; a browser tab holds ${num(count)}.`);
      }
      const key = `${make}(${argument})`;
      name = sample.shared === true ? names.made.get(key) : undefined;
      if (name === undefined) {
        const times = (names.taken.get(make) ?? 0) + 1;
        names.taken.set(make, times);
        name = `${make}Data${times === 1 ? '' : String(times)}`;
        names.made.set(key, name);
        data.push(`const ${name} = ${key};`);
      }
    }
    dataNames.push(name);
    if (type.inScene === true && scene) {
      sceneLines.push(type.code(writer, series, name, axes, index));
    } else {
      lines.push(type.code(writer, series, name, axesOf(spec, series), index));
    }
  });
  if (inScene) {
    // The series of the scene in one 3D chart: its settings first, its axes and planes after the series.
    const body = [
      ...(spec.title.length > 0 ? [`s.title(${str(spec.title)});`] : []),
      ...scene.start(writer, spec),
      ...sceneLines,
      ...scene.end(writer, spec),
      'return s;',
    ];
    lines.push(
      `${writer.use(scene.host.name, scene.host.from)}(c, (s) => {\n${body
        .flatMap((line) => line.split('\n'))
        .map((line) => `  ${line}`)
        .join('\n')}\n});`,
    );
  }
  const editable = spec.modifiers.some((modifier) => modifier.type === 'annotationedit');
  for (const annotation of spec.annotations) {
    const info = catalog.findAnnotation(annotation.type);
    if (info) {
      lines.push(`c.addOverlay((chart) => ${info.code(writer, annotation.parameters, editable)});`);
    }
  }
  for (const modifier of spec.modifiers) {
    const info = catalog.findModifier(modifier.type);
    if (info) {
      lines.push(`c.addModifier(() => ${info.code(writer, modifier.parameters)});`);
    }
  }
  for (const legend of [spec.legend, spec.secondLegend]) {
    if (legend) {
      lines.push(legendCode(legend));
    }
  }
  if (spec.group !== undefined && spec.group.length > 0) {
    lines.push(`c.group(${str(spec.group)});`);
  }
  return { data, body: lines, names: dataNames };
}

// The overview below a chart: the same data at a glance, without titles, ranges, labels and interactions; dragging
// its window moves the chart, as OverviewOf of the .NET version.
function overviewOf(spec: ChartSpec): ChartSpec {
  const overview: ChartSpec = JSON.parse(JSON.stringify(spec)) as ChartSpec;
  overview.title = '';
  overview.legend = undefined;
  overview.secondLegend = undefined;
  overview.group = undefined;
  overview.overview = false;
  overview.exportMenu = false;
  overview.modifiers = [];
  overview.annotations = [];
  for (const axis of [...overview.xAxes, ...overview.yAxes]) {
    axis.title = '';
    axis.minimum = undefined;
    axis.maximum = undefined;
  }
  for (const series of overview.series) {
    if (series.type === 'line' || series.parameters.thickness !== undefined) {
      series.parameters.thickness = 1;
    }
    for (const label of ['lastValue', 'values']) {
      if (series.parameters[label] === true) {
        series.parameters[label] = false;
      }
    }
  }
  return overview;
}

const indented = (lines: readonly string[], by = '  '): string[] =>
  lines.flatMap((line) => line.split('\n')).map((line) => `${by}${line}`);

// Linked charts of a description: its own and those of `charts`, or itself with an overview below.
function describeLinked(spec: ChartSpec, catalog: ChartCatalog, writer: CodeWriter, language: CodeLanguage): string {
  const names: DataNames = { taken: new Map(), made: new Map() };
  const builder = writer.use('ChartBuilder');
  const charts: { name: string; parts: ChartParts }[] = [];
  if (spec.overview && spec.charts.length === 0) {
    const main: ChartSpec = { ...spec, group: spec.group !== undefined && spec.group.length > 0 ? spec.group : 'Main' };
    const parts = chartParts(main, catalog, writer, names);
    charts.push({ name: 'Chart', parts });
    const overview = chartParts(overviewOf(spec), catalog, writer, names, parts.names);
    overview.body.push(`c.addModifier(() => ${writer.use('OverviewModifier')}.of(${str(main.group ?? 'Main')}));`);
    charts.push({ name: 'Overview', parts: overview });
  } else {
    [{ ...spec, charts: [] }, ...spec.charts].forEach((each, i) => {
      charts.push({ name: `Chart${i === 0 ? '' : String(i + 1)}`, parts: chartParts(each, catalog, writer, names) });
    });
  }
  const columns = spec.overview && spec.charts.length === 0 ? 1 : Math.max(1, spec.columns);
  const running = writer.isLive ? `${writer.parameter('running', '(() => void)[]')} = []` : '';
  const result = language === 'typescript' ? `: { charts: ${builder}[]; columns: number }` : '';
  const functions = charts.flatMap(({ name, parts }) => [
    `// The chart ${name}.`,
    `const describe${name} = (${writer.parameter('c', builder)})${writer.type(builder)} => {`,
    ...indented([...parts.body, 'return c;']),
    '};',
  ]);
  return [
    `export function describeCharts(${running})${result} {`,
    ...indented([...charts.flatMap(({ parts }) => parts.data), ...functions]),
    '  return {',
    `    columns: ${String(columns)},`,
    `    charts: [${charts.map(({ name }) => `describe${name}(new ${builder}())`).join(', ')}],`,
    '  };',
    '}',
  ].join('\n');
}

function describeChart(spec: ChartSpec, catalog: ChartCatalog, language: CodeLanguage): CodeParts {
  const problems = [...catalog.check(spec), ...spec.charts.flatMap((each) => catalog.check(each))];
  if (problems.length > 0) {
    throw new ChartSpecProblem(problems);
  }
  const writer = new CodeWriter(language);
  const views = describeViews(spec, catalog, writer, language);
  if (views !== undefined) {
    return { writer, describe: views, several: true };
  }
  if (spec.charts.length > 0 || spec.overview) {
    return { writer, describe: describeLinked(spec, catalog, writer, language), several: true };
  }
  const parts = chartParts(spec, catalog, writer, { taken: new Map(), made: new Map() });
  const builder = writer.useType('ChartBuilder');
  const running = writer.isLive ? `, ${writer.parameter('running', '(() => void)[]')} = []` : '';
  const signature =
    language === 'typescript'
      ? `export function describeChart(c: ${builder}${running}): ${builder} {`
      : `export function describeChart(c${running}) {`;
  const describe = [signature, ...indented([...parts.data, ...parts.body, 'return c;']), '}'].join('\n');
  return { writer, describe, several: false };
}

/**
 * The code of a chart: a module that exports `describeChart(c)`, to call with a `ChartBuilder` and give to a
 * `<tachyon-chart>` element; for linked charts `describeCharts()`, which gives the charts and the columns they stand in.
 * @throws ChartSpecProblem when a type, a sample or an interaction of the description is unknown.
 */
export function chartCode(spec: ChartSpec, catalog: ChartCatalog, language: CodeLanguage = 'typescript'): string {
  const { writer, describe, several } = describeChart(spec, catalog, language);
  const usage = [
    ...(several
      ? [
          '// Shows the charts in <tachyon-chart> elements of the page, in a grid of `columns` columns:',
          "// const elements = document.querySelectorAll('tachyon-chart');",
          '// describeCharts().charts.forEach((chart, i) => { elements[i].chart = chart; });',
        ]
      : [
          '// Shows the chart in a <tachyon-chart> element of the page:',
          "// const element = document.querySelector('tachyon-chart');",
          '// element.chart = describeChart(new ChartBuilder());',
        ]),
    ...(writer.isLive
      ? ['// Live data keep coming until the functions in the list `running`, given as last argument, are called.']
      : []),
  ];
  return [
    ...writer.importLines(),
    '',
    ...writer.helperCode().flatMap((code) => [code, '']),
    describe,
    '',
    ...usage,
    '',
  ].join('\n');
}

/** Charts described after a description: one, or the linked charts of a type with several views. */
export interface DescribedCharts {
  /** The charts. */
  readonly charts: readonly ChartBuilder[];
  /** The number of columns they stand in. */
  readonly columns: number;
}

/**
 * Describes the charts of a description by running the code the configurator writes for it; the packages of its
 * modules must have arrived, see {@link ChartCatalog.load}. What keeps running, such as live data, puts the function
 * that stops it into `running`.
 * @throws ChartSpecProblem when a type, a sample or an interaction of the description is unknown.
 */
export function applyChartSpecs(
  spec: ChartSpec,
  catalog: ChartCatalog,
  running: (() => void)[] = [],
  chart: ChartBuilder = new ChartBuilder(),
): DescribedCharts {
  const { writer, describe, several } = describeChart(spec, catalog, 'javascript');
  const names: string[] = [];
  const values: unknown[] = [];
  for (const [source, imported] of writer.importedNames()) {
    const module = codePackages[source] ?? catalog.packages[source];
    if (!module) {
      throw new ChartSpecProblem([`The package ${source} is not loaded; await catalog.load(spec) first.`]);
    }
    for (const name of imported) {
      names.push(name);
      values.push(module[name]);
    }
  }
  const entry = several ? 'describeCharts' : 'describeChart';
  const body = [...writer.helperCode(), describe.replace(/^export /gmu, ''), `return ${entry};`].join('\n');
  // The code is the configurator's own, made from the description; running it keeps preview and code equal.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(...names, body) as (...args: unknown[]) => (...args: unknown[]) => unknown;
  const described = make(...values);
  return several
    ? (described(running) as DescribedCharts)
    : { charts: [described(chart, running) as ChartBuilder], columns: 1 };
}

/**
 * Describes a chart after a description by running the code the configurator writes for it; of linked charts the
 * first, see {@link applyChartSpecs}.
 * @throws ChartSpecProblem when a type, a sample or an interaction of the description is unknown.
 */
export function applyChartSpec(
  spec: ChartSpec,
  catalog: ChartCatalog,
  chart: ChartBuilder,
  running: (() => void)[] = [],
): ChartBuilder {
  return applyChartSpecs(spec, catalog, running, chart).charts[0] ?? chart;
}
