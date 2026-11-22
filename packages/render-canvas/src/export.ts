// Turns a chart into a file, as ChartExporter and ChartVideo of the .NET version: PNG with the device the chart uses,
// SVG with lines and shapes as vectors, CSV of the visible points, and a video of frames at fixed times. The display
// stays as it is.
import {
  DateTimeAxis,
  type ChartSurface,
  type RenderDevice,
  type RenderTarget,
  type ThemeDocument,
} from '@tachyon-charts/core';
import { SvgDevice, SvgTarget } from './svg';

/** What an exported picture looks like. */
export interface ChartExportOptions {
  /** The width in CSS pixels, 96 per inch; 1200 by default. */
  readonly width?: number;
  /** The height in CSS pixels; 800 by default. */
  readonly height?: number;
  /** The resolution: the picture keeps its layout and gets more pixels; 96 by default. */
  readonly dpi?: number;
  /** A theme for this picture only; the one of the chart when left out. */
  readonly theme?: ThemeDocument;
}

/** The size, length and encoding of a video of a chart. */
export interface ChartVideoOptions {
  /** The width in pixels; 1280 by default. */
  readonly width?: number;
  /** The height in pixels; 720 by default. */
  readonly height?: number;
  /** Frames per second; 30 by default. */
  readonly frameRate?: number;
  /** The length in seconds; 5 by default. */
  readonly duration?: number;
  /** Bits per second of the encoded video; 8 million by default. */
  readonly bitRate?: number;
  /** A theme for the video only; the one of the chart when left out. */
  readonly theme?: ThemeDocument;
  /**
   * Called before each frame with its number and its time in seconds, the frame number divided by the frame rate:
   * move a range, append data. The video plays evenly however long a frame takes.
   */
  readonly step?: (frame: number, seconds: number) => void;
}

const inchesPerMeter = 39.3700787;
const minimumVectorDpi = 288;
// The layout can depend on the size of the picture; three passes let it settle.
const passes = 3;

// Prepares a chart for a picture and puts it back afterwards, as ExportScope of the .NET version.
function withScope<T>(chart: ChartSurface, theme: ThemeDocument | undefined, render: () => T): T {
  const ownTheme = chart.theme;
  const zoomRectangle = chart.zoomRectangle;
  chart.zoomRectangle = undefined;
  if (theme) {
    chart.theme = theme;
  }
  try {
    return render();
  } finally {
    chart.theme = ownTheme;
    chart.zoomRectangle = zoomRectangle;
    chart.invalidate();
  }
}

function renderPasses(chart: ChartSurface, device: RenderDevice, target: RenderTarget): void {
  for (let pass = 0; pass < passes; pass++) {
    chart.invalidate();
    chart.render(device, target);
  }
}

function pixelSize(options: ChartExportOptions, dpi: number, maximum: number): { width: number; height: number } {
  if (!(dpi > 0) || !Number.isFinite(dpi)) {
    throw new RangeError(`The resolution must be positive, not ${String(dpi)}.`);
  }
  const width = Math.round(((options.width ?? 1200) * dpi) / 96);
  const height = Math.round(((options.height ?? 800) * dpi) / 96);
  if (!(width >= 1) || !(height >= 1) || width > maximum || height > maximum) {
    throw new RangeError(`${String(width)} × ${String(height)} pixels are outside of 1 to ${String(maximum)}.`);
  }
  return { width, height };
}

/** Encodes RGBA pixels as PNG through a canvas of the browser. */
async function encodePng(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('The browser has no 2D canvas to encode a PNG.');
  }
  const data = new Uint8ClampedArray(pixels.length);
  data.set(pixels);
  context.putImageData(new ImageData(data, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Renders a PNG file with the device the chart uses, with its resolution in the file, so that a picture of 300 dpi
 * prints at its size.
 * @throws RangeError when the size is not positive or more than the device can render.
 */
export async function chartToPng(
  chart: ChartSurface,
  device: RenderDevice,
  options: ChartExportOptions = {},
): Promise<Blob> {
  const dpi = options.dpi ?? 96;
  const size = pixelSize(options, dpi, device.capabilities.maxTextureDimension);
  const target = device.createOffscreenTarget(size, dpi / 96);
  try {
    withScope(chart, options.theme, () => {
      renderPasses(chart, device, target);
    });
    await device.whenIdle();
    const pixels = await target.readPixels();
    const png = withResolution(await encodePng(pixels, size.width, size.height), dpi);
    return new Blob([png], { type: 'image/png' });
  } finally {
    target.dispose();
  }
}

/**
 * Writes an SVG file. Lines and shapes stay vectors, while text and rasters are embedded as pictures of at least
 * 288 dpi. Long series are thinned out to the resolution, as on the screen.
 * @throws RangeError when the size is not positive or too large.
 */
export async function chartToSvg(chart: ChartSurface, options: ChartExportOptions = {}): Promise<string> {
  const dpi = Math.max(options.dpi ?? 96, minimumVectorDpi);
  const device = new SvgDevice();
  const size = pixelSize(options, dpi, device.capabilities.maxTextureDimension);
  const target = new SvgTarget(device, size, dpi / 96);
  try {
    withScope(chart, options.theme, () => {
      renderPasses(chart, device, target);
    });
    let content = target.content;
    for (const picture of target.pictures) {
      const png = await encodePng(picture.pixels.data, picture.pixels.width, picture.pixels.height);
      content = content.replace(`href="${picture.placeholder}"`, `href="data:image/png;base64,${base64(png)}"`);
    }
    const width = String(options.width ?? 1200);
    const height = String(options.height ?? 800);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${String(size.width)} ${String(size.height)}">\n${content}\n</svg>\n`
    );
  } finally {
    chart.releaseDevice(device);
    device.dispose();
  }
}

/** The points a CSV file holds: of a series, the X and Y values. */
export interface CsvPoints {
  /** The name of the series. */
  readonly name: string;
  /** The X values. */
  readonly x: ArrayLike<number>;
  /** The Y values. */
  readonly y: ArrayLike<number>;
  /** The axis of X, which formats times as the cursor does. */
  readonly formatX: (value: number) => string;
}

/**
 * Writes the visible points of the series with points of their own as CSV: a header, then the series, X and Y of
 * each point. Numbers use a dot, so that every program reads them alike; times are written as the cursor shows them.
 * Series without points of their own, such as bars and rasters, have no rows.
 */
export function chartToCsv(chart: ChartSurface): string {
  const lines = ['series,x,y'];
  for (const points of visiblePoints(chart)) {
    const name = quote(points.name);
    for (let i = 0; i < points.x.length; i++) {
      lines.push(`${name},${quote(points.formatX(points.x[i] as number))},${String(points.y[i])}`);
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** The points of each series with a source of points that lie in the visible ranges of its axes. */
export function visiblePoints(chart: ChartSurface): CsvPoints[] {
  const result: CsvPoints[] = [];
  for (const series of chart.series) {
    const source = (
      series as { source?: { snapshot?: () => { x: ArrayLike<number>; y: ArrayLike<number>; count: number } } }
    ).source;
    if (typeof source?.snapshot !== 'function') {
      continue;
    }
    const snapshot = source.snapshot();
    const xRange = series.xAxis.visibleRange;
    const yRange = series.yAxis.visibleRange;
    const [xLow, xHigh] = [Math.min(xRange.min, xRange.max), Math.max(xRange.min, xRange.max)];
    const [yLow, yHigh] = [Math.min(yRange.min, yRange.max), Math.max(yRange.min, yRange.max)];
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < snapshot.count; i++) {
      const px = snapshot.x[i] as number;
      const py = snapshot.y[i] as number;
      if (px >= xLow && px <= xHigh && py >= yLow && py <= yHigh) {
        x.push(px);
        y.push(py);
      }
    }
    const axis = series.xAxis;
    const formatX =
      axis instanceof DateTimeAxis
        ? (value: number): string => axis.formatCursorValue(value)
        : (value: number): string => String(value);
    result.push({ name: series.name ?? '', x, y, formatX });
  }
  return result;
}

/**
 * Records a video of a chart as WebM: each frame belongs to a fixed time, the frame number divided by the frame rate,
 * and is drawn with the device of the chart and handed to the encoder of the browser at that pace. Recording takes as
 * long as the video. Needs a page: it records from a canvas of the document.
 */
export async function recordChartVideo(
  chart: ChartSurface,
  device: RenderDevice,
  options: ChartVideoOptions = {},
): Promise<Blob> {
  // Even sizes, as video encoders need them.
  const width = Math.floor((options.width ?? 1280) / 2) * 2;
  const height = Math.floor((options.height ?? 720) / 2) * 2;
  const frameRate = options.frameRate ?? 30;
  const frames = Math.ceil((options.duration ?? 5) * frameRate);
  if (!(width >= 2 && height >= 2 && frameRate > 0 && frames > 0)) {
    throw new RangeError('A video needs a size, a frame rate and a length above 0.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (!context || !track) {
    throw new Error('The browser cannot record a canvas.');
  }
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: options.bitRate ?? 8_000_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => {
      resolve();
    };
  });
  const target = device.createOffscreenTarget({ width, height }, 1);
  const image = new ImageData(width, height);
  const ownTheme = chart.theme;
  if (options.theme) {
    chart.theme = options.theme;
  }
  recorder.start();
  const start = performance.now();
  try {
    for (let frame = 0; frame < frames; frame++) {
      options.step?.(frame, frame / frameRate);
      renderPasses(chart, device, target);
      image.data.set(await target.readPixels());
      context.putImageData(image, 0, 0);
      track.requestFrame();
      // At the pace of the video, so that the encoder of the browser sees each frame at its time.
      const due = start + ((frame + 1) * 1000) / frameRate;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - performance.now())));
    }
  } finally {
    recorder.stop();
    target.dispose();
    chart.theme = ownTheme;
    chart.invalidate();
  }
  await stopped;
  track.stop();
  return new Blob(chunks, { type: 'video/webm' });
}

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// The resolution as a pHYs chunk behind the header: browsers write none, and without one a picture of 300 dpi comes
// out huge in print.
export function withResolution(png: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  const pixelsPerMeter = Math.round(dpi * inchesPerMeter);
  const header = 8 + 25;
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
  view.setUint32(8, pixelsPerMeter);
  view.setUint32(12, pixelsPerMeter);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  const result = new Uint8Array(png.length + chunk.length);
  result.set(png.subarray(0, header));
  result.set(chunk, header);
  result.set(png.subarray(header), header + chunk.length);
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
