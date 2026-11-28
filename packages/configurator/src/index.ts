/** Version of the package `@tachyon-charts/configurator`. */
export const version = '0.1.0-dev';

export {
  ChartSpecError,
  chartSpecVersion,
  flagOf,
  newAxis,
  newChartSpec,
  numberOf,
  readChartSpec,
  textOf,
  writeChartSpec,
  type AnnotationSpec,
  type AxisKind,
  type AxisSpec,
  type ChartSpec,
  type DataKind,
  type DataSpec,
  type FontSpec,
  type LegendSpec,
  type ModifierSpec,
  type SeriesSpec,
  type SpecValues,
  type ThemeSpec,
} from './spec';
export {
  ChartCatalog,
  axesOf,
  parseColor,
  type ChartCategory,
  type ChartModule,
  type ChartTypeInfo,
  type DataShape,
  type ModifierInfo,
  type ParameterInfo,
  type ParameterKind,
  type SampleInfo,
  type SeriesAxes,
} from './catalog';
export { coreModule } from './core-module';
export { medicalModule } from './medical-module';
export { ChartSpecProblem, applyChartSpec, breaksOf, camel, chartCode, codePackages, themeId } from './build';
export { CodeWriter, identifier, num, rgba, str, type CodeLanguage } from './code';
