// Pieces of the code of a series that several types share.
import { parseColor } from './catalog';
import { rgba, str } from './code';
import { textOf, type SeriesSpec, type SpecValues } from './spec';

/** @internal A color of the parameters as code, or undefined for none. */
export function colorCode(values: SpecValues, name: string): string | undefined {
  const parsed = parseColor(textOf(values, name));
  return parsed ? rgba(parsed) : undefined;
}

/**
 * @internal The code that adds a series the code makes itself, `make`, with its properties set; `assignments` are
 * `property = value` in code, `before` statements ahead of it inside the function.
 */
export function seriesCode(
  series: SeriesSpec,
  make: string,
  assignments: readonly string[],
  axes: { x: string; y: string },
  before: readonly string[] = [],
): string {
  const usesAxis = before.some((line) => line.includes('axis(')) || make.includes('axis(');
  const all = [...(series.name.length > 0 ? [`name = ${str(series.name)}`] : []), ...assignments];
  return [
    'c.addSeries(',
    `  (x, y${usesAxis ? ', axis' : ''}) => {`,
    ...before.map((line) => `    ${line}`),
    `    const series = ${make};`,
    ...all.map((line) => `    series.${line};`),
    '    return series;',
    '  },',
    `  ${str(axes.x)},`,
    `  ${str(axes.y)},`,
    ');',
  ].join('\n');
}

/** @internal An object made and set up in one expression. */
export function madeWith(make: string, name: string, assignments: readonly string[]): string {
  if (assignments.length === 0) {
    return make;
  }
  return `(() => {\n  const ${name} = ${make};\n${assignments.map((line) => `  ${name}.${line};`).join('\n')}\n  return ${name};\n})()`;
}
