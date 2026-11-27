/** Version of the package `@tachyon-charts/render-canvas`. */
export const version = '0.1.0-dev';

export { Canvas2dDevice, createCanvas2dDevice } from './device';
export { createCanvas2dWorkerDevice, type Canvas2dWorkerDeviceOptions } from './worker-device';
export {
  chartToCsv,
  chartToPng,
  chartToSvg,
  recordChartVideo,
  visiblePoints,
  type ChartExportOptions,
  type CsvPoints,
} from './export';
export {
  canEncodeVideo,
  encodeChartVideo,
  startChartRecording,
  type ChartRecording,
  type ChartVideoOptions,
} from './video';
