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
import { BoxMap, toSizeCode, type Line3D, type Scatter3D } from '../scene/points';
import { barStride, type Bars3D } from '../scene/bars';
import type { Bubbles3D } from '../scene/bubbles';
import { calculateNormals, validIndices, type Mesh3D, type Vertex3D } from '../scene/mesh';
import type { Pie3D } from '../scene/pie';
import { Point3D } from '../scene/matrix';
import { meshVertexStride } from './meshes';
import { bubbleStride } from './bubbles';
import type { Scene3D } from '../scene/scene';
import { fullMaterial, missingHeight, type Surface3D } from '../scene/surface';
import type { Waterfall3D } from '../scene/waterfall';
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
  private readonly barVersions = new Map<Bars3D, number>();
  private readonly waterfallRows = new Map<Waterfall3D, number>();
  private readonly bubbleKeys = new Map<Bubbles3D, string>();
  private readonly meshKeys = new Map<Mesh3D, string>();
  private readonly pieKeys = new Map<Pie3D, string>();
  private heights = new Float32Array(0);
  private ranges = '';
  private palette: readonly Rgba8[] = [];
  private paletteVersion = 0;
  private themeColors = new Map<object, Rgba8>();
  private themeColorsStamp = '';
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

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.onPalette} */
  override onPalette(palette: readonly Rgba8[]): void {
    this.palette = [...palette];
    this.paletteVersion++;
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
    for (const waterfall of this.scene.waterfalls) {
      this.updateWaterfall(waterfall);
    }
    for (const bars of this.scene.bars) {
      this.updateBars(bars);
    }
    const boxMap = new BoxMap(this.scene.xAxis, this.scene.yAxis, this.scene.zAxis);
    for (const mesh of this.scene.meshes) {
      this.uploadMesh(mesh);
    }
    for (const bubbles of this.scene.bubbles) {
      this.uploadBubbles(bubbles, boxMap);
    }
    for (const pie of this.scene.pies) {
      this.uploadPie(pie);
    }
    const map = new BoxMap(this.scene.xAxis, this.scene.yAxis, this.scene.zAxis);
    const renderer = this.renderer as Renderer3D;
    for (const line of this.scene.lines) {
      const color = this.colorOf(line, line.hasOwnColor, line.color);
      renderer.traceOf(line).upload(map, color, this.ranges + ' ' + colorKey(color));
    }
    for (const scatter of this.scene.scatters) {
      const color = this.colorOf(scatter, scatter.hasOwnColor, scatter.color);
      renderer.spotsOf(scatter).upload(map, color, this.ranges + ' ' + colorKey(color), toSizeCode(scatter.size));
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

  // The color an element draws with: its own, or the color of the palette its place among the elements without one
  // gives.
  private colorOf(element: Line3D | Scatter3D | Bubbles3D | Mesh3D, hasOwn: boolean, own: Rgba8): Rgba8 {
    if (hasOwn || this.palette.length === 0) {
      return own;
    }
    const stamp = String(this.scene.version) + ' ' + String(this.paletteVersion);
    if (stamp !== this.themeColorsStamp) {
      this.themeColors = new Map();
      let next = 0;
      for (const item of [...this.scene.lines, ...this.scene.scatters, ...this.scene.bubbles]) {
        if (!item.hasOwnColor) {
          this.themeColors.set(item, this.palette[next++ % this.palette.length] as Rgba8);
        }
      }
      for (const mesh of this.scene.meshes) {
        if (mesh.takesThemeColor) {
          this.themeColors.set(mesh, this.palette[next++ % this.palette.length] as Rgba8);
        }
      }
      this.themeColorsStamp = stamp;
    }
    return this.themeColors.get(element) ?? own;
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
      this.barVersions.clear();
      this.waterfallRows.clear();
      this.bubbleKeys.clear();
      this.meshKeys.clear();
      this.pieKeys.clear();
    }
  }

  // A pie lays out its slices again when a slice moves out or the colors of the theme change.
  private uploadPie(pie: Pie3D): void {
    const key = `${String(pie.version)} ${String(this.paletteVersion)}`;
    if (this.pieKeys.get(pie) === key) {
      return;
    }
    this.pieKeys.set(pie, key);
    pie.layout(this.palette);
    for (const mesh of pie.meshes) {
      if (mesh) {
        this.meshKeys.delete(mesh);
        this.uploadMesh(mesh);
      }
    }
  }

  // The places move into the box once; a new range of the axes or a new theme color uploads them again.
  private uploadMesh(mesh: Mesh3D): void {
    const renderer = this.renderer as Renderer3D;
    const themeColor =
      mesh.takesThemeColor && this.palette.length > 0
        ? this.colorOf(mesh, false, mesh.vertices[0]?.color ?? { r: 0, g: 0, b: 0, a: 255 })
        : undefined;
    const key = themeColor ? colorKey(themeColor) : '';
    if (this.meshKeys.get(mesh) === key && renderer.holdsMesh(mesh)) {
      return;
    }
    this.meshKeys.set(mesh, key);
    const scene = this.scene;
    const positions = mesh.vertices.map(
      (vertex) =>
        new Point3D(
          toBox(scene.xAxis, vertex.position.x),
          toBox(scene.yAxis, vertex.position.y),
          toBox(scene.zAxis, vertex.position.z),
        ),
    );
    const normals = calculateNormals(positions, mesh.indices);
    const vertices = new ArrayBuffer(positions.length * meshVertexStride);
    const floats = new Float32Array(vertices);
    const bytes = new Uint8Array(vertices);
    positions.forEach((p, i) => {
      const n = normals[i] as Point3D;
      const at = (i * meshVertexStride) / 4;
      floats.set([p.x, p.y, p.z, n.x, n.y, n.z], at);
      const color = themeColor ?? (mesh.vertices[i] as Vertex3D).color;
      bytes.set([color.r, color.g, color.b, color.a], (at + 6) * 4);
    });
    renderer.uploadMesh(mesh, vertices, validIndices(positions, mesh.indices), fullMaterial(mesh.material));
  }

  private uploadBubbles(bubbles: Bubbles3D, map: BoxMap): void {
    const renderer = this.renderer as Renderer3D;
    const color = this.colorOf(bubbles, bubbles.hasOwnColor, bubbles.color);
    const key = colorKey(color);
    if (this.bubbleKeys.get(bubbles) === key && renderer.holdsBubbles(bubbles)) {
      return;
    }
    this.bubbleKeys.set(bubbles, key);
    const range = this.scene.xAxis.visibleRange;
    const span = range.max - range.min;
    const isScreen = bubbles.sizeUnit === 'screen';
    const instances = new ArrayBuffer(bubbles.count * bubbleStride);
    const floats = new Float32Array(instances);
    const bytes = new Uint8Array(instances);
    let count = 0;
    for (let i = 0; i < bubbles.count; i++) {
      const at = (count * bubbleStride) / 4;
      map.write(bubbles.x[i] as number, bubbles.y[i] as number, bubbles.z[i] as number, floats, at);
      const diameter = bubbles.diameters[i] as number;
      if ((floats[at] as number) > 1e29 || !Number.isFinite(diameter) || diameter <= 0) {
        continue;
      }
      // A radius in the box spans half the diameter of 2 / span: the box is 2 wide.
      floats[at + 3] = isScreen ? -diameter : diameter / span;
      const own = bubbles.colors?.[i] ?? color;
      bytes.set([own.r, own.g, own.b, own.a], (at + 4) * 4);
      count++;
    }
    renderer.uploadBubbles(bubbles, instances, count, fullMaterial(bubbles.material));
  }

  private updateWaterfall(waterfall: Waterfall3D): void {
    const renderer = this.renderer as Renderer3D;
    const data = waterfall.data;
    const columns = data.columns;
    const rows = data.rows;
    const total = data.totalRows;
    if (!renderer.holdsSurface(waterfall) || !this.waterfallRows.has(waterfall)) {
      this.createWaterfall(waterfall);
      this.waterfallRows.set(waterfall, 0);
    }
    const scene = this.scene;
    const transform = scene.zAxis.createTransform(-1, 2);
    const sign = scene.zAxis.isHorizontal ? 1 : -1;
    const row = new Float32Array(columns);
    for (let index = Math.max(this.waterfallRows.get(waterfall) ?? 0, total - rows); index < total; index++) {
      for (let column = 0; column < columns; column++) {
        const value = data.read(index, column);
        const place = Number.isFinite(value) ? sign * transform.toPixel(value) : Number.NaN;
        row[column] = Number.isFinite(place) ? place : missingHeight;
      }
      renderer.writeRow(waterfall, index % rows, row, (index + 1) % rows);
    }
    this.waterfallRows.set(waterfall, total);
  }

  private createWaterfall(waterfall: Waterfall3D): void {
    const scene = this.scene;
    const columns = waterfall.data.columns;
    const rows = waterfall.data.rows;
    const left = toBox(scene.xAxis, waterfall.x.min);
    const right = toBox(scene.xAxis, waterfall.x.max);
    const front = toBox(scene.yAxis, waterfall.y.min);
    const back = toBox(scene.yAxis, waterfall.y.max);
    const range = waterfall.colorRange ?? scene.zAxis.visibleRange;
    // The oldest row comes first, at the far end, and the rows run towards the front.
    (this.renderer as Renderer3D).updateSurface(
      waterfall,
      {
        columns,
        rows,
        origin: [left, back, (right - left) / (columns - 1), (front - back) / (rows - 1)],
        colors: [toBox(scene.zAxis, range.min), toBox(scene.zAxis, range.max)],
        firstRow: 0,
        levels: new Float32Array(0),
        contours: undefined,
        lineSpacing: waterfall.style === 'lines' ? Math.max(waterfall.lineSpacing, 1) : 0,
      },
      new Float32Array(columns * rows).fill(missingHeight),
      colorTable(waterfall),
      fullMaterial(waterfall.material),
    );
  }

  private updateBars(bars: Bars3D): void {
    const renderer = this.renderer as Renderer3D;
    const version = bars.data.version;
    if (this.barVersions.get(bars) === version && renderer.holdsBars(bars)) {
      return;
    }
    this.barVersions.set(bars, version);
    const count = bars.data.width * bars.data.height;
    const instances = new ArrayBuffer(count * barStride);
    bars.write(this.scene, instances);
    renderer.updateBars(bars, instances, count, bars.cells(this.scene), fullMaterial(bars.material));
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
        lineSpacing: 0,
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

function colorKey(color: Rgba8): string {
  return [color.r, color.g, color.b, color.a].join(',');
}

// The colors of the colormap as a table of four floats each, opaque.
function colorTable(surface: Surface3D | Waterfall3D): Float32Array {
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
