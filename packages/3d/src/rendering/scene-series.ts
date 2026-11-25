// The series that shows a 3D scene in a 2D chart: it draws the scene with WebGPU into a picture and puts the picture
// into the plot, as Scene3DSeries of the .NET version. With a device without direct WebGPU it draws on a WebGPU device
// of its own and hands a copy of the picture over, one frame later.
import {
  ChartSeries,
  parseThemeColor,
  type Axis,
  type ChartSurface,
  type CommandList,
  type GpuTexture,
  type RenderDevice,
  type Rgba8,
  type SeriesFrame,
  type ThemeDocument,
} from '@tachyon-charts/core';
import { createWebGpuDevice, WebGpuDevice } from '@tachyon-charts/render-webgpu';
import { addBoxLines, selectWalls, tickPlaces, toBox } from '../scene/axis-box';
import type { Scene3D } from '../scene/scene';
import { fullMaterial, type Surface3D } from '../scene/surface';
import { LineVertices, Renderer3D } from './renderer';

const defaultBackground: Rgba8 = { r: 14, g: 17, b: 23, a: 255 };
const defaultGrid: Rgba8 = { r: 255, g: 255, b: 255, a: 40 };
const defaultFrame: Rgba8 = { r: 255, g: 255, b: 255, a: 110 };

function themeColor(text: string | undefined, fallback: Rgba8): Rgba8 {
  return text ? parseThemeColor(text) : fallback;
}

/** @internal Shows a scene as a picture in the plot of a chart. */
export class Scene3DSeries extends ChartSeries {
  private chart: ChartSurface | undefined;
  private renderer: Renderer3D | undefined;
  private rendererDevice: WebGpuDevice | undefined;
  private ownDevice: WebGpuDevice | undefined;
  private ownDeviceWanted = false;
  private copy: GpuTexture | undefined;
  private copyDevice: RenderDevice | undefined;
  private copyPending = false;
  private drawsCopy = false;
  private readonly lines = new LineVertices();
  private readonly grid: number[] = [];
  private readonly frameLines: number[] = [];
  private linesKey = '';
  private renderedKey = '';
  private copies = 0;
  private readonly matrix = new Float32Array(16);
  private readonly surfaceVersions = new Map<Surface3D, number>();
  private heights = new Float32Array(0);
  private ranges = '';
  private waiting: Promise<void> | undefined;

  /**
   * @param scene - The scene.
   * @param xAxis - The hidden horizontal axis of the chart.
   * @param yAxis - The hidden vertical axis of the chart.
   */
  constructor(
    /** The scene. */
    readonly scene: Scene3D,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.scene.version + this.scene.camera.version + this.copies;
  }

  /** @internal Settles once the work started by the last frame is done, so that the next frame shows the picture. */
  whenReady(): Promise<void> {
    return this.waiting ?? Promise.resolve();
  }

  /** @internal Connects the series with its chart, for the theme. */
  bind(chart: ChartSurface): void {
    this.chart = chart;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    this.drawsCopy = !(device instanceof WebGpuDevice);
    if (device instanceof WebGpuDevice) {
      this.render(device, frame);
    } else {
      this.prepareCopy(device, frame);
    }
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    const picture = this.drawsCopy ? this.copy : this.renderer?.picture;
    if (picture) {
      commands.drawImage(picture, frame.bounds);
    }
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.renderer?.dispose();
    this.renderer = undefined;
    this.rendererDevice = undefined;
    this.renderedKey = '';
    this.copy?.dispose();
    this.copy = undefined;
    this.copyDevice = undefined;
  }

  // Draws on a WebGPU device of its own, reads the picture back and hands it to the device of the chart one frame
  // later, as for an export or a chart in a render worker.
  private prepareCopy(device: RenderDevice, frame: SeriesFrame): void {
    const gpu = this.ownDevice;
    if (!gpu) {
      if (!this.ownDeviceWanted) {
        this.ownDeviceWanted = true;
        this.waiting = createWebGpuDevice().then((created) => {
          this.ownDevice = created;
          this.copies++;
        });
      }
      return;
    }
    const before = this.renderedKey;
    this.render(gpu, frame);
    const picture = this.renderer?.picture;
    if (!picture || (before === this.renderedKey && this.copy && this.copyDevice === device) || this.copyPending) {
      return;
    }
    const size = picture.size;
    const target = gpu.createOffscreenTarget(size, 1);
    const commands = gpu.beginFrame(target);
    commands.drawImage(picture, { x: 0, y: 0, width: size.width, height: size.height });
    commands.submit();
    this.copyPending = true;
    this.waiting = target.readPixels().then((pixels) => {
      target.dispose();
      this.copyPending = false;
      if (
        !this.copy ||
        this.copyDevice !== device ||
        this.copy.size.width !== size.width ||
        this.copy.size.height !== size.height
      ) {
        this.copy?.dispose();
        this.copy = device.createTexture({ size, format: 'rgba8unorm' });
        this.copyDevice = device;
      }
      this.copy.write(pixels);
      this.copies++;
    });
  }

  private render(device: WebGpuDevice, frame: SeriesFrame): void {
    if (this.rendererDevice !== device) {
      this.releaseResources();
      this.rendererDevice = device;
      this.renderer = new Renderer3D(device);
    }
    const size = { width: Math.round(frame.bounds.width), height: Math.round(frame.bounds.height) };
    const theme = this.chart?.theme;
    const key = `${String(this.scene.version)} ${String(this.scene.camera.version)} ${String(size.width)} ${String(size.height)} ${String(themeKey(theme))}`;
    if (size.width <= 0 || size.height <= 0 || key === this.renderedKey) {
      return;
    }
    this.renderedKey = key;
    this.takeRanges();
    this.collectLines(theme);
    for (const surface of this.scene.surfaces) {
      this.updateSurface(surface);
    }
    const aspect = size.width / size.height;
    const camera = this.scene.camera;
    camera.createMatrix(aspect).toGpu(this.matrix);
    const eye = camera.eye;
    const walls = selectWalls(eye);
    const background = themeColor(theme?.surface?.background, defaultBackground);
    (this.renderer as Renderer3D).render(
      size,
      this.matrix,
      [Math.fround(eye.x), Math.fround(eye.y), Math.fround(eye.z)],
      background,
      this.lines,
      [walls.x, walls.y, walls.z, 0],
    );
  }

  // New ranges move everything in the box: a chart group zooms from outside, so all data reach the GPU anew.
  private takeRanges(): void {
    const scene = this.scene;
    const ranges = [scene.xAxis, scene.yAxis, scene.zAxis]
      .map((axis) => `${String(axis.visibleRange.min)}:${String(axis.visibleRange.max)}`)
      .join(' ');
    if (ranges !== this.ranges) {
      this.ranges = ranges;
      this.surfaceVersions.clear();
    }
  }

  private updateSurface(surface: Surface3D): void {
    const renderer = this.renderer as Renderer3D;
    const version = surface.data.version;
    if (this.surfaceVersions.get(surface) === version && renderer.holdsSurface(surface)) {
      return;
    }
    this.surfaceVersions.set(surface, version);
    const scene = this.scene;
    const columns = surface.data.width;
    const rows = surface.data.height;
    if (this.heights.length !== columns * rows) {
      this.heights = new Float32Array(columns * rows);
    }
    surface.writeHeights(scene.zAxis, this.heights);
    const left = toBox(scene.xAxis, surface.x.min);
    const right = toBox(scene.xAxis, surface.x.max);
    const front = toBox(scene.yAxis, surface.y.min);
    const back = toBox(scene.yAxis, surface.y.max);
    const range = surface.colorRange ?? surface.data.valueRange;
    const contours = surface.contours;
    renderer.updateSurface(
      surface,
      {
        columns,
        rows,
        origin: [left, front, (right - left) / (columns - 1), (back - front) / (rows - 1)],
        colors: range ? [toBox(scene.zAxis, range.min), toBox(scene.zAxis, range.max)] : [0, 0],
        firstRow: 0,
        levels: Float32Array.from(contours?.levels ?? [], (level) => toBox(scene.zAxis, level)),
        contours,
      },
      this.heights,
      colorTable(surface),
      fullMaterial(surface.material),
    );
  }

  private collectLines(theme: ThemeDocument | undefined): void {
    const scene = this.scene;
    const walls = selectWalls(scene.camera.eye);
    const key = [
      walls.x,
      walls.y,
      walls.z,
      themeKey(theme),
      scene.xAxis.version,
      scene.yAxis.version,
      scene.zAxis.version,
      scene.showsAxes,
    ].join(' ');
    if (key === this.linesKey) {
      return;
    }
    this.linesKey = key;
    this.grid.length = 0;
    this.frameLines.length = 0;
    this.lines.clear();
    if (scene.showsAxes) {
      addBoxLines(
        this.grid,
        this.frameLines,
        walls,
        tickPlaces(scene.xAxis),
        tickPlaces(scene.yAxis),
        tickPlaces(scene.zAxis),
      );
    }
    this.lines.addAll(this.grid, themeColor(theme?.grid?.major, defaultGrid));
    this.lines.addAll(this.frameLines, themeColor(theme?.axis?.line, defaultFrame));
  }
}

// The colors of the colormap as a table of four floats each, opaque.
function colorTable(surface: Surface3D): Float32Array {
  const entries = surface.colormap.entries;
  const table = new Float32Array(entries.length * 4);
  entries.forEach((entry, i) => {
    table.set([entry.r / 255, entry.g / 255, entry.b / 255, 1], i * 4);
  });
  return table;
}

// Themes are objects that do not change; their identity tells a new one.
const themeIds = new WeakMap<object, number>();
let nextThemeId = 1;

function themeKey(theme: ThemeDocument | undefined): number {
  if (!theme) {
    return 0;
  }
  let id = themeIds.get(theme);
  if (id === undefined) {
    id = nextThemeId++;
    themeIds.set(theme, id);
  }
  return id;
}
