// What the configurator offers, as ChartCatalog, ChartTypeInfo, ParameterInfo, ModifierInfo and SampleInfo of the .NET
// version: the types of series with their parameters, the interactions and the sample data, gathered from modules.
import type { Rgba8 } from '@tachyon-charts/core';
import type { CodeWriter } from './code';
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
  /** In a 3D scene: whether an earlier series has set up the box, so that this one leaves the axes alone. */
  readonly inSharedBox?: boolean;
}

/**
 * The 3D scene that series of a module share, as SceneInfo of the .NET version: its settings, and the statements on
 * the scene builder `s` before and after the series.
 */
export interface SceneSetup {
  /** The settings of the scene. */
  readonly parameters: readonly ParameterInfo[];
  /** The function that puts a scene into a chart builder, such as `scene3D`, and the package it comes from. */
  readonly host: { readonly name: string; readonly from: string };
  /** Statements before the series. */
  start(writer: CodeWriter, spec: ChartSpec): string[];
  /** Statements after the series. */
  end(writer: CodeWriter, spec: ChartSpec): string[];
}

/** A chart of a type that shows its data in several linked charts, such as the planes of a volume. */
export interface ViewCode {
  /** The name of the chart, a word that names its function, such as `Axial`. */
  readonly name: string;
  /** Statements that describe the chart on the chart builder `c`, with the data in the variable the type was given. */
  readonly code: string;
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
  /**
   * Writes the code that adds the series to the chart builder `c`, its data in the variable `data`.
   * @returns Statements, each ending with a semicolon.
   */
  code(writer: CodeWriter, series: SeriesSpec, data: string, axes: SeriesAxes, index: number): string;
  /** Whether the type sets the axes itself, such as a pie. */
  readonly ownsAxes?: boolean;
  /**
   * The linked charts of a type that shows its data in several, such as the planes of a volume; `code` then only
   * prepares the data, and each chart takes them.
   */
  views?(writer: CodeWriter, series: SeriesSpec, data: string): ViewCode[];
  /** Whether the type shows no data of its own, such as the axis box alone; then no sample is made for it. */
  readonly noData?: boolean;
  /** Whether the series goes into the 3D scene of the chart; its code then uses the scene builder `s`. */
  readonly inScene?: boolean;
  /** The number of columns its linked charts stand in; two by default. */
  columns?(series: SeriesSpec, count: number): number;
  /** Whether the type shows times along X, so that a new chart of it takes a time axis. */
  readonly usesTime?: boolean;
  /** Whether a new chart of a type that sets its axes itself still takes the usual interactions. */
  readonly takesInteractions?: boolean;
}

/** An interaction the configurator offers. */
export interface ModifierInfo {
  /** The name it is known by. */
  readonly id: string;
  /** The name shown. */
  readonly name: string;
  /** The parameters. */
  readonly parameters: readonly ParameterInfo[];
  /** Writes the expression that makes the interaction. */
  code(writer: CodeWriter, values: SpecValues): string;
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
  /** The body of `function (count)`, valid TypeScript and JavaScript at once. */
  readonly body: string;
  /** The type the function returns, for TypeScript. */
  readonly returns: string;
  /**
   * The names the body uses: of `@tachyon-charts/core` by name, of another package as `package#Name`, and `round` for
   * the rounding of the .NET version.
   */
  readonly uses: readonly string[];
  /** The lowest count that makes sense. */
  readonly minimumCount?: number;
  /** The highest count a browser tab holds; a description with more takes this many. */
  readonly maximumCount?: number;
  /** Whether the count changes the data. */
  readonly hasCount?: boolean;
  /** Whether series of the same sample and count share one set of data, as the channels of one bus do. */
  readonly shared?: boolean;
}

/** A module of types, interactions and samples, such as the core, 3D or medical images. */
export interface ChartModule {
  /** The types of series. */
  readonly types: readonly ChartTypeInfo[];
  /** The sample data. */
  readonly samples: readonly SampleInfo[];
  /** The interactions. */
  readonly modifiers?: readonly ModifierInfo[];
  /**
   * Loads the packages its code imports from, by name, besides `@tachyon-charts/core`; they arrive on demand, so that a
   * page loads them only for charts that need them.
   */
  readonly load?: () => Promise<Record<string, Record<string, unknown>>>;
  /** The 3D scene its series share, if any. */
  readonly scene?: SceneSetup;
}

/** All that the modules offer. */
export class ChartCatalog {
  private readonly typeList: ChartTypeInfo[] = [];
  private readonly sampleList: SampleInfo[] = [];
  private readonly modifierList: ModifierInfo[] = [];
  private readonly packageList: Record<string, Record<string, unknown>> = {};
  private readonly moduleList: ChartModule[] = [];
  private sceneSetup: SceneSetup | undefined;
  private readonly loading = new Map<ChartModule, Promise<void>>();

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
    this.moduleList.push(module);
    this.sceneSetup = module.scene ?? this.sceneSetup;
  }

  /** The 3D scene of the modules, if one brings it. */
  get scene(): SceneSetup | undefined {
    return this.sceneSetup;
  }

  /**
   * Loads the packages of the modules a description needs, or of all modules without one; the code of a chart runs only
   * after its packages have arrived.
   */
  async load(spec?: ChartSpec): Promise<void> {
    const used = spec ? new Set(spec.series.map((series) => series.type)) : undefined;
    const wanted = this.moduleList.filter(
      (module) => module.load !== undefined && (!used || module.types.some((type) => used.has(type.id))),
    );
    await Promise.all(
      wanted.map((module) => {
        let loading = this.loading.get(module);
        if (!loading) {
          loading = (module.load?.() ?? Promise.resolve({})).then((packages) => {
            Object.assign(this.packageList, packages);
          });
          this.loading.set(module, loading);
        }
        return loading;
      }),
    );
  }

  /** The packages loaded so far that the code of the modules imports from, besides `@tachyon-charts/core`. */
  get packages(): Readonly<Record<string, Record<string, unknown>>> {
    return this.packageList;
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
