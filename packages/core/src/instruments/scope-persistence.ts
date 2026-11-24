// The persistence of an oscilloscope, as PersistenceBuffer, ScopePersistenceSeries and ScopeColormaps of the .NET
// version: the hits of the waveforms per pixel, faded or kept, drawn as a raster in the color of the channel or in a
// color grade.
import { ColorAxis } from '../axes/color-axis';
import type { Axis } from '../axes/axis';
import { roundHalfEven } from '../numerics/nice';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuTexture } from '../render/resources';
import type { Rgba8 } from '../render/types';
import { Colormap } from '../series/colormap';
import type { ScopeChannel, ScopeDisplay, ScopePersistence } from './scope-display';

const f = Math.fround;
const maximumWidth = 1920;
const maximumHeight = 1080;
const entryCount = 256;

/** A colormap of evenly mixed colors, as Colormap.FromColors of the .NET version: 256 entries. */
export function colormapFromColors(name: string, stops: readonly Rgba8[]): Colormap {
  if (stops.length < 2) {
    throw new RangeError('A colormap needs at least two colors.');
  }
  const entries: Rgba8[] = [];
  for (let i = 0; i < entryCount; i++) {
    const position = (i * (stops.length - 1)) / (entryCount - 1);
    const first = Math.min(Math.trunc(position), stops.length - 2);
    const fraction = position - first;
    const from = stops[first] as Rgba8;
    const to = stops[first + 1] as Rgba8;
    const mix = (a: number, b: number): number => roundHalfEven(a + (b - a) * fraction);
    entries.push({ r: mix(from.r, to.r), g: mix(from.g, to.g), b: mix(from.b, to.b), a: mix(from.a, to.a) });
  }
  return new Colormap(name, entries);
}

const gradeSteps: readonly Rgba8[] = [
  { r: 40, g: 60, b: 200, a: 255 },
  { r: 40, g: 150, b: 220, a: 255 },
  { r: 40, g: 200, b: 110, a: 255 },
  { r: 190, g: 220, b: 50, a: 255 },
  { r: 250, g: 170, b: 40, a: 255 },
  { r: 240, g: 70, b: 50, a: 255 },
  { r: 255, g: 240, b: 240, a: 255 },
];

let grade: Colormap | undefined;

/** The colors of the color grade: blue for rare, red and white for frequent. */
function gradeColormap(): Colormap {
  grade ??= colormapFromColors(
    'Grade',
    Array.from({ length: entryCount }, (_, i) => gradeSteps[Math.trunc((i * gradeSteps.length) / entryCount)] as Rgba8),
  );
  return grade;
}

/** The hits of waveforms per pixel. */
export class PersistenceBuffer {
  /** The hits, rows from the top. */
  readonly hits: Float32Array;
  private readonly marks: Int32Array;
  private pass = 0;
  private highest = 0;

  /**
   * @param width - The pixels across.
   * @param height - The pixels from top to bottom.
   */
  constructor(
    /** The pixels across. */
    readonly width: number,
    /** The pixels from top to bottom. */
    readonly height: number,
  ) {
    this.hits = new Float32Array(width * height);
    this.marks = new Int32Array(width * height);
  }

  /** The most hits of a pixel. */
  get maximum(): number {
    return this.highest;
  }

  /** Forgets all hits. */
  clear(): void {
    this.hits.fill(0);
    this.highest = 0;
  }

  /** Multiplies all hits with the factor. */
  fade(factor: number): void {
    const scale = f(factor);
    for (let i = 0; i < this.hits.length; i++) {
      this.hits[i] = f((this.hits[i] as number) * scale);
    }
    this.highest = f(this.highest * scale);
  }

  /** Adds one waveform in pixels, x and y pairs; a pixel counts once per waveform. NaN points are gaps. */
  add(points: Float32Array, count: number): void {
    this.pass++;
    let hasPrevious = false;
    let px = 0;
    let py = 0;
    for (let i = 0; i < count; i++) {
      const x = points[i * 2] as number;
      const y = points[i * 2 + 1] as number;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        hasPrevious = false;
        continue;
      }
      if (hasPrevious) {
        this.addSegment(px, py, x, y);
      }
      px = x;
      py = y;
      hasPrevious = true;
    }
  }

  private addSegment(fromX: number, fromY: number, toX: number, toY: number): void {
    const firstColumn = Math.max(Math.floor(Math.min(fromX, toX)), 0);
    const lastColumn = Math.min(Math.floor(Math.max(fromX, toX)), this.width - 1);
    const run = f(toX - fromX);
    const rise = f(toY - fromY);
    for (let column = firstColumn; column <= lastColumn; column++) {
      // The part of the segment inside this column.
      const start = run === 0 ? 0 : Math.min(Math.max(f(f(column - fromX) / run), 0), 1);
      const end = run === 0 ? 1 : Math.min(Math.max(f(f(column + 1 - fromX) / run), 0), 1);
      const y0 = f(fromY + f(rise * start));
      const y1 = f(fromY + f(rise * end));
      const firstRow = Math.max(Math.floor(Math.min(y0, y1)), 0);
      const lastRow = Math.min(Math.floor(Math.max(y0, y1)), this.height - 1);
      for (let row = firstRow; row <= lastRow; row++) {
        const index = row * this.width + column;
        if (this.marks[index] !== this.pass) {
          this.marks[index] = this.pass;
          const value = f((this.hits[index] as number) + 1);
          this.hits[index] = value;
          this.highest = Math.max(this.highest, value);
        }
      }
    }
  }
}

/** @internal The persistence of one channel, below its line. */
export class ScopePersistenceSeries extends ChartSeries {
  private readonly scale = new ColorAxis('persistence');
  private buffer: PersistenceBuffer | undefined;
  private points = new Float32Array(0);
  private texture: GpuTexture | undefined;
  private table: GpuTexture | undefined;
  private tableMap: Colormap | undefined;
  private fadeMap: Colormap | undefined;
  private fadeColor: Rgba8 | undefined;
  private acquisition = -1;
  private scaleVersion = -1;
  private mode: ScopePersistence = 'off';
  private lastTime = 0;

  constructor(
    private readonly display: ScopeDisplay,
    private readonly channel: ScopeChannel,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
    this.scale.belowColor = { r: 0, g: 0, b: 0, a: 0 };
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.channel.color;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.display.version;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(): DoubleRange | undefined {
    return undefined;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    const mode = this.display.persistence;
    if (mode === 'off') {
      this.buffer = undefined;
      return;
    }
    const width = Math.min(Math.max(Math.trunc(frame.bounds.width), 1), maximumWidth);
    const height = Math.min(Math.max(Math.trunc(frame.bounds.height), 1), maximumHeight);
    let buffer = this.buffer;
    if (
      buffer?.width !== width ||
      buffer.height !== height ||
      mode !== this.mode ||
      this.scaleVersion !== this.display.scaleVersion
    ) {
      buffer = new PersistenceBuffer(width, height);
      this.buffer = buffer;
      this.texture?.dispose();
      this.texture = device.createTexture({ size: { width, height }, format: 'r32float' });
      this.mode = mode;
      this.scaleVersion = this.display.scaleVersion;
      this.acquisition = -1;
    }
    if (this.channel.acquisitionCount !== this.acquisition) {
      this.acquisition = this.channel.acquisitionCount;
      this.accumulate(buffer, mode);
      this.texture?.write(buffer.hits);
    }
    const map = mode === 'colorGrade' ? gradeColormap() : this.fade();
    if (!this.table || this.tableMap !== map) {
      this.table?.dispose();
      this.table = device.createTexture({ size: { width: map.entries.length, height: 1 }, format: 'rgba8unorm' });
      this.table.write(map.toBytes());
      this.tableMap = map;
    }
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    const buffer = this.buffer;
    if (this.display.persistence !== 'off' && this.texture && this.table && buffer && buffer.maximum > 0) {
      this.scale.visibleRange = new DoubleRange(0.05, Math.max(buffer.maximum, 1));
      commands.drawRaster(this.texture, this.table, frame.bounds, this.scale.rasterStyle());
    }
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.texture?.dispose();
    this.table?.dispose();
    this.texture = undefined;
    this.table = undefined;
    this.tableMap = undefined;
    this.buffer = undefined;
    this.acquisition = -1;
  }

  // The color of the channel from clear to 150 of 255.
  private fade(): Colormap {
    const color = this.channel.color;
    if (!this.fadeMap || this.fadeColor !== color) {
      this.fadeMap = colormapFromColors('Fade', [
        { ...color, a: 0 },
        { ...color, a: 150 },
      ]);
      this.fadeColor = color;
    }
    return this.fadeMap;
  }

  private accumulate(buffer: PersistenceBuffer, mode: ScopePersistence): void {
    if (mode === 'variable') {
      const now = Date.now();
      const seconds = this.lastTime === 0 ? 0 : (now - this.lastTime) / 1000;
      this.lastTime = now;
      buffer.fade(Math.exp(-seconds / this.display.persistenceSeconds));
    }
    const snapshot = this.channel.data.snapshot();
    const count = snapshot.count;
    if (this.points.length < count * 2) {
      this.points = new Float32Array(count * 2);
    }
    const range = this.display.timeRange();
    const volts = this.channel.range();
    const scaleX = f(buffer.width / (range.max - range.min));
    const scaleY = f(buffer.height / (volts.max - volts.min));
    for (let i = 0; i < count; i++) {
      this.points[i * 2] = ((snapshot.x[i] as number) - range.min) * scaleX;
      this.points[i * 2 + 1] = (volts.max - (snapshot.y[i] as number)) * scaleY;
    }
    buffer.add(this.points, count);
  }
}
