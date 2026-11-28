// A chart from its description, as SpecChartBuilder of the .NET version: title, theme, axes, the series with their
// data, the interactions and the legends.
import {
  DoubleRange,
  findBuiltInTheme,
  type AxisBuilder,
  type ChartBuilder,
  type LegendPlacement,
  type NonPositiveValues,
  type ThemeDocument,
} from '@tachyon-charts/core';
import { axesOf, type ChartCatalog } from './catalog';
import { camel } from './core-module';
import type { AxisSpec, ChartSpec, LegendSpec, SeriesSpec } from './spec';

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

/** A built-in theme by its name in a description, such as TachyonDark or HighContrast. */
export function themeOf(name: string): ThemeDocument | undefined {
  return findBuiltInTheme(name.replace(/([a-z])([A-Z])/gu, '$1-$2').toLowerCase());
}

/** The ranges of the breaks of an axis, such as `2..3, 5..6`, or undefined when one does not read. */
export function breaksOf(text: string): DoubleRange[] | undefined {
  const ranges: DoubleRange[] = [];
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
    ranges.push(new DoubleRange(from, to));
  }
  return ranges;
}

function axis(builder: AxisBuilder, spec: AxisSpec, opposite: 'top' | 'right'): void {
  switch (spec.kind) {
    case 'logarithmic':
      builder.log(spec.id, spec.logBase, camel(spec.nonPositive) as NonPositiveValues);
      break;
    case 'dateTime':
      builder.dateTime(spec.id);
      break;
    case 'category':
      builder.category(
        spec.categories
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
        spec.id,
      );
      break;
    default:
      builder.numeric(spec.id);
  }
  if (spec.title.length > 0) {
    builder.title(spec.title);
  }
  if (spec.minimum !== undefined && spec.maximum !== undefined) {
    builder.range(spec.minimum, spec.maximum);
  } else {
    builder.autoRange();
  }
  if (spec.isInverted) {
    builder.inverted();
  }
  if (spec.isOpposite) {
    builder.position(opposite);
  }
  if (spec.crossesZero) {
    builder.crossesAt(0);
  }
  if (spec.labelRotation !== 0) {
    builder.labelRotation(spec.labelRotation);
  }
  if (spec.kind === 'logarithmic' && spec.floor !== undefined) {
    builder.floor(spec.floor);
  }
  const breaks = breaksOf(spec.breaks);
  if (breaks && breaks.length > 0) {
    builder.breaks(...breaks);
  }
  if (spec.pane > 0 || spec.paneWeight !== 1) {
    builder.pane(spec.pane, spec.paneWeight);
  }
  if (spec.isHidden) {
    builder.hidden();
  }
}

function legend(chart: ChartBuilder, spec: LegendSpec): void {
  chart.legend((builder) => {
    if (spec.title.length > 0) {
      builder.title(spec.title);
    }
    if (spec.placement !== 'TopRight') {
      builder.place(camel(spec.placement) as LegendPlacement);
    }
    const names = spec.series
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (names.length > 0) {
      builder.series(...names);
    }
  });
}

/** The data of a series: its sample made for its count. */
export function dataOf(catalog: ChartCatalog, series: SeriesSpec): unknown {
  return catalog.makeSample(series.data.sample, series.data.count);
}

/**
 * Describes a chart after a description.
 * @throws ChartSpecProblem when a type, a sample or an interaction of the description is unknown.
 */
export function applyChartSpec(spec: ChartSpec, catalog: ChartCatalog, chart: ChartBuilder): ChartBuilder {
  const problems = catalog.check(spec);
  if (problems.length > 0) {
    throw new ChartSpecProblem(problems);
  }
  if (spec.title.length > 0) {
    chart.title(spec.title);
  }
  const theme = spec.theme === undefined ? undefined : themeOf(spec.theme);
  if (theme) {
    chart.theme(theme);
  }
  const ownsAxes = spec.series.some((series) => catalog.findType(series.type)?.ownsAxes === true);
  if (!ownsAxes) {
    for (const each of spec.xAxes) {
      chart.xAxis((builder) => {
        axis(builder, each, 'top');
      });
    }
    for (const each of spec.yAxes) {
      chart.yAxis((builder) => {
        axis(builder, each, 'right');
      });
    }
  }
  for (const series of spec.series) {
    const type = catalog.findType(series.type);
    type?.apply(chart, series, dataOf(catalog, series), axesOf(spec, series));
  }
  for (const each of spec.modifiers) {
    const info = catalog.findModifier(each.type);
    if (info) {
      chart.addModifier(() => info.create(each.parameters));
    }
  }
  for (const each of [spec.legend, spec.secondLegend]) {
    if (each) {
      legend(chart, each);
    }
  }
  if (spec.group !== undefined && spec.group.length > 0) {
    chart.group(spec.group);
  }
  return chart;
}
