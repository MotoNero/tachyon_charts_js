// What the configurator offers, as ChartCatalog, ChartTypeInfo, ParameterInfo, ModifierInfo and SampleInfo of the .NET
// version: the types of series with their parameters, the interactions and the sample data, gathered from modules.
import type { Axis, ChartBuilder, ChartModifier, Rgba8 } from '@tachyon-charts/core';
import type { ChartSpec, SeriesSpec, SpecValues } from './spec';

/** The kind of a parameter, which decides how it is edited. */
export type ParameterKind = 'number' | 'integer' | 'flag' | 'choice' | 'choices' | 'color' | 'file' | 'text';

/** A parameter of a type of series, an interaction or an annotation. */
export interface ParameterInfo {
  /** The name shown. */
  readonly name: string;
  /** The label shown beside its editor. */
  readonly label: string;
  /** What kind it is. */
  readonly kind: ParameterKind;
  /** The value it has when nothing is set. */
  readonly default: number | boolean | string;
  /** The lowest value, if any. */
  readonly minimum?: number;
  /** The highest value, if any. */
  readonly maximum?: number;
  /** The values to choose from. */
  readonly choices?: readonly string[];
  /** A line that explains it. */
  readonly description?: string;
}

/** The group a type belongs to in the configurator. */
export type ChartCategory = 'twoD' | 'instrument' | 'threeD' | 'medical';

/** The form of the data of a type, which decides the samples it takes. */
export type DataShape = string;

/** The names of the axes a series takes. */
export interface SeriesAxes {
  /** The X axis. */
  readonly x: string;
  /** The Y axis. */
  readonly y: string;
}

/** A type of series the configurator offers. */
export interface ChartTypeInfo {
  /** The name it is known by. */
  readonly id: string;
  /** The name shown. */
  readonly name: string;
  /** The group it belongs to. */
  readonly category: ChartCategory;
  /** The form of its data. */
  readonly shape: DataShape;
  /** The sample data a new series takes. */
  readonly defaultSample: string;
  /** The parameters. */
  readonly parameters: readonly ParameterInfo[];
  /** Adds the series to a chart, from its description and its data. */
  apply(chart: ChartBuilder, series: SeriesSpec, data: unknown, axes: SeriesAxes): void;
  /** Whether the type sets the axes itself, such as a pie. */
  readonly ownsAxes?: boolean;
}

/** An interaction the configurator offers. */
export interface ModifierInfo {
  /** The name it is known by. */
  readonly id: string;
  /** The name shown. */
  readonly name: string;
  /** The parameters. */
  readonly parameters: readonly ParameterInfo[];
  /** The create. */
  create(values: SpecValues): ChartModifier;
}

/**
 * Sample data: the body of a function of `count` written once in JavaScript, run for the preview and copied into the
 * code the configurator writes, so that both always show the same data.
 */
export interface SampleInfo {
  /** The name it is known by. */
  readonly id: string;
  /** The name shown. */
  readonly name: string;
  /** The form of its data. */
  readonly shape: DataShape;
  /** The count a new series takes. */
  readonly defaultCount: number;
  /** The body of `function (count)`; it may use the names of {@link sampleScope}. */
  readonly body: string;
  /** The type the function returns, for TypeScript. */
  readonly returns: string;
  /** The names of {@link sampleScope} the body uses, to import in the code. */
  readonly uses: readonly string[];
  /** The lowest count that makes sense. */
  readonly minimumCount?: number;
  /** Whether the count changes the data. */
  readonly hasCount?: boolean;
}

/** A module of types, interactions and samples, such as the core, 3D or medical images. */
export interface ChartModule {
  /** The types of series. */
  readonly types: readonly ChartTypeInfo[];
  /** The sample data. */
  readonly samples: readonly SampleInfo[];
  /** The interactions. */
  readonly modifiers?: readonly ModifierInfo[];
}

/** What sample bodies may use besides plain JavaScript; the core module fills it. */
export const sampleScope: Record<string, unknown> = {};

/** All that the modules offer. */
export class ChartCatalog {
  private readonly typeList: ChartTypeInfo[] = [];
  private readonly sampleList: SampleInfo[] = [];
  private readonly modifierList: ModifierInfo[] = [];
  private readonly made = new Map<string, (count: number) => unknown>();

  /** @param modules - The modules, the core first. */
  constructor(modules: readonly ChartModule[]) {
    for (const module of modules) {
      this.add(module);
    }
  }

  /** The types of series. */
  get types(): readonly ChartTypeInfo[] {
    return this.typeList;
  }

  /** The sample data. */
  get samples(): readonly SampleInfo[] {
    return this.sampleList;
  }

  /** The interactions. */
  get modifiers(): readonly ModifierInfo[] {
    return this.modifierList;
  }

  /** Adds the types, samples and interactions of a module; later ones of the same name replace earlier ones. */
  add(module: ChartModule): void {
    const replace = <T extends { id: string }>(list: T[], items: readonly T[]): void => {
      for (const item of items) {
        const at = list.findIndex((known) => known.id === item.id);
        if (at >= 0) {
          list[at] = item;
        } else {
          list.push(item);
        }
      }
    };
    replace(this.typeList, module.types);
    replace(this.sampleList, module.samples);
    replace(this.modifierList, module.modifiers ?? []);
  }

  /** A type by its id. */
  findType(id: string): ChartTypeInfo | undefined {
    return this.typeList.find((type) => type.id === id);
  }

  /** Sample data by their id. */
  findSample(id: string): SampleInfo | undefined {
    return this.sampleList.find((sample) => sample.id === id);
  }

  /** An interaction by its id. */
  findModifier(id: string): ModifierInfo | undefined {
    return this.modifierList.find((modifier) => modifier.id === id);
  }

  /**
   * The data of a sample for a count, made by running its body.
   * @throws RangeError for an unknown sample.
   */
  makeSample(id: string, count: number): unknown {
    let make = this.made.get(id);
    if (!make) {
      const sample = this.findSample(id);
      if (!sample) {
        throw new RangeError(`There are no sample data ${id}.`);
      }
      const names = Object.keys(sampleScope);
      // The body is code of the configurator itself, written once for the preview and the code it writes.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const create = new Function(...names, 'count', sample.body) as (...args: unknown[]) => unknown;
      const values = names.map((name) => sampleScope[name]);
      make = (n: number) => create(...values, n);
      this.made.set(id, make);
    }
    return make(count);
  }

  /** What keeps a description from being shown: unknown types, samples or interactions. */
  check(spec: ChartSpec): string[] {
    const problems: string[] = [];
    for (const series of spec.series) {
      if (!this.findType(series.type)) {
        problems.push(`The type ${series.type} is unknown.`);
      } else if (series.data.kind === 'sample' && !this.findSample(series.data.sample)) {
        problems.push(`The sample data ${series.data.sample} are unknown.`);
      }
    }
    for (const modifier of spec.modifiers) {
      if (!this.findModifier(modifier.type)) {
        problems.push(`The interaction ${modifier.type} is unknown.`);
      }
    }
    return problems;
  }
}

/** A color of a description, `#RRGGBB` or `#RRGGBBAA`, or undefined for another text. */
export function parseColor(text: string): Rgba8 | undefined {
  if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u.test(text)) {
    return undefined;
  }
  const value = Number.parseInt(text.slice(1), 16);
  return text.length === 7
    ? { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255, a: 255 }
    : { r: (value >>> 24) & 255, g: (value >> 16) & 255, b: (value >> 8) & 255, a: value & 255 };
}

/** The axes of a series: its own, or the first of the chart. */
export function axesOf(spec: ChartSpec, series: SeriesSpec): SeriesAxes {
  return { x: series.xAxis ?? spec.xAxes[0]?.id ?? 'x', y: series.yAxis ?? spec.yAxes[0]?.id ?? 'y' };
}

/** @internal An axis of the chart by its name, for a type that makes its series itself. */
export type AxisOf = (id: string) => Axis;
