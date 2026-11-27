// The series that shows a 3D scene in a 2D chart: it draws the scene with WebGPU into a picture and puts the picture
// into the plot, as Scene3DSeries of the .NET version. With a device without direct WebGPU it draws on a WebGPU device
// of its own and hands a copy of the picture over, one frame later.
import {
  ChartSeries,
  parseThemeColor,
  type Axis,
  type ChartGroup,
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
import type { AntennaPattern3D } from '../scene/antenna';
import type { MeasuredMap3D } from '../scene/measured-map';
import type { PointCloud3D } from '../scene/point-cloud';
import { CloudLoader } from './cloud-loader';
import { ScenePicker } from './scene-picker';
import { sceneToCsv } from './scene-csv';
import { addSpectrumLines, spectrumLevels } from '../scene/spectrum-links';
import { transferTableSize } from '../scene/transfer';
import type { Volume3D } from '../scene/volume';
import type { Pie3D } from '../scene/pie';
import { ClipPlane3D } from '../scene/clip-plane';
import { Point3D, type Matrix3D } from '../scene/matrix';
import { meshVertexStride } from './meshes';
import { bubbleStride } from './bubbles';
import type { Scene3D } from '../scene/scene';
import { fullMaterial, missingHeight, type Surface3D } from '../scene/surface';
import type { Waterfall3D } from '../scene/waterfall';
import { LineVertices, Renderer3D } from './renderer';

// The bytes of a volume per frame on their way to the GPU, and the steps of the rays per voxel.
const volumeBytesPerFrame = 1 << 23;
const fineSteps = 2;
const volumeModes = ['transfer', 'maximum', 'surface'];

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
  private readonly antennaMeshes = new Map<AntennaPattern3D, Mesh3D>();
  private readonly mapMeshes = new Map<MeasuredMap3D, Mesh3D>();
  private readonly cloudLoaders = new Map<PointCloud3D, CloudLoader>();
  private group: ChartGroup | undefined;
  private wantedGroup: ChartGroup | undefined;
  /** @internal Tells the pointer of the chart which group shows its place as crosshair. */
  pointerGroup: ((group: ChartGroup | undefined) => void) | undefined;
  private readonly volumeStates = new Map<Volume3D, { next: number; stamp: string; shares: Float32Array }>();
  private readonly transferTable = new Float32Array(transferTableSize * 4);
  private readonly corners = new Float32Array(24);
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
    /** @internal What finds the things under the pointer; it learns what the series uploads. */
    readonly picker: ScenePicker = new ScenePicker(scene),
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
  bind(chart: ChartSurface, group?: ChartGroup): void {
    this.chart = chart;
    this.wantedGroup = group;
    this.joinGroup();
  }

  // The first axis shares its range with the X axes of the 2D charts of the group, and their cursor shows in the box.
  // The scene stays in the group while its chart lives, also when its GPU resources go.
  private joinGroup(): void {
    this.pointerGroup?.(this.wantedGroup);
    const group = this.wantedGroup;
    const chart = this.chart;
    if (!group || !chart || this.group) {
      return;
    }
    this.group = group;
    group.add(chart, this.scene.xAxis);
    group.onCursorMoved = (x) => {
      this.scene.cursor = x;
      chart.invalidate();
    };
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    this.joinGroup();
    // The curves of cuts follow their planes and surfaces; a 2D chart redraws when its source changes.
    for (const feed of this.scene.feeds) {
      feed.update(this.scene);
    }
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

  /**
   * The data of the scene that lies inside the axes as CSV, one line per point with object, x, y, z and value; the CSV
   * export of the chart takes it instead of points of its own.
   */
  toCsv(): string {
    return sceneToCsv(this.scene);
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    for (const loader of this.cloudLoaders.values()) {
      loader.dispose();
    }
    this.cloudLoaders.clear();
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
    this.waiting = target
      .readPixels()
      .then((pixels) => {
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
      })
      .catch(() => {
        // The chart let go of its device while the picture was on its way back; a new device draws anew.
        this.copyPending = false;
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
    // The height of the box follows the levels of a spectrum behind a waterfall, as its reference level changes.
    for (const waterfall of this.scene.waterfalls) {
      const display = waterfall.display;
      const zAxis = this.scene.zAxis;
      if (display) {
        const levels = spectrumLevels(display);
        if (zAxis.visibleRange.min !== levels.min || zAxis.visibleRange.max !== levels.max) {
          zAxis.visibleRange = levels;
        }
      }
    }
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
    for (const cloud of this.scene.clouds) {
      let loader = this.cloudLoaders.get(cloud);
      if (!loader) {
        loader = new CloudLoader(cloud);
        this.cloudLoaders.set(cloud, loader);
      }
      loader.load(this.scene, this.renderer as Renderer3D);
      const octree = loader.octree;
      if (octree) {
        this.picker.addCloud(cloud, octree);
      }
    }
    // Maps become meshes once.
    for (const map of this.scene.maps) {
      let mesh = this.mapMeshes.get(map);
      if (!mesh) {
        mesh = map.createMesh(this.scene.xAxis, this.scene.yAxis);
        this.mapMeshes.set(map, mesh);
      }
      this.uploadMesh(mesh, map);
    }
    // Antennas become meshes once.
    for (const antenna of this.scene.antennas) {
      let mesh = this.antennaMeshes.get(antenna);
      if (!mesh) {
        mesh = antenna.createMesh();
        this.antennaMeshes.set(antenna, mesh);
      }
      this.uploadMesh(mesh, antenna);
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
    renderer.cutWith(
      this.scene.planes
        .filter((plane) => plane.hides)
        .map((plane) => [
          Math.fround(plane.normal.x),
          Math.fround(plane.normal.y),
          Math.fround(plane.normal.z),
          Math.fround(-plane.offset),
        ]),
    );
    const aspect = size.width / size.height;
    const camera = this.scene.camera;
    const sceneMatrix = camera.createMatrix(aspect);
    sceneMatrix.toGpu(this.matrix);
    for (const volume of this.scene.volumes) {
      this.updateVolume(volume, sceneMatrix);
    }
    for (const loader of this.cloudLoaders.values()) {
      loader.select(this.scene, sceneMatrix, size.width, size.height);
    }
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

  // Brings the slices of a volume to the GPU, a few megabytes per frame, and sets its place and how the rays look.
  private updateVolume(volume: Volume3D, matrix: Matrix3D): void {
    const renderer = this.renderer as Renderer3D;
    const data = volume.data;
    let state = this.volumeStates.get(volume);
    const stamp = volume.colormap.entries.map((color) => colorKey(color)).join(' ');
    const colors = (): Float32Array =>
      Float32Array.from(volume.colormap.entries.flatMap((color) => [color.r / 255, color.g / 255, color.b / 255, 1]));
    if (!state) {
      state = { next: 0, stamp, shares: new Float32Array(data.isBytes ? 0 : data.width * data.height) };
      this.volumeStates.set(volume, state);
      renderer.volumeOf(volume, colors());
    } else if (state.stamp !== stamp) {
      state.stamp = stamp;
      renderer.volumeOf(volume, colors());
    }
    const buffer = renderer.volumeOf(volume, undefined);
    if (state.next < data.depth) {
      const bytesPerSlice = data.width * data.height * (data.isBytes ? 1 : 4);
      for (let written = 0; written < volumeBytesPerFrame && state.next < data.depth; state.next++) {
        // A volume reduced on the GPU skips the slices it does not keep.
        if (buffer.keeps(state.next)) {
          if (data.isBytes) {
            buffer.writeBytes(state.next, data.byteSlice(state.next));
          } else {
            data.writeShares(state.next, state.shares);
            buffer.writeShares(state.next, state.shares);
          }
          written += bytesPerSlice;
        }
      }
      volume.setLoaded(state.next);
    }
    const scene = this.scene;
    const map = new BoxMap(scene.xAxis, scene.yAxis, scene.zAxis);
    const a = map.toBox(new Point3D(volume.x.min, volume.y.min, volume.z.min));
    const b = map.toBox(new Point3D(volume.x.max, volume.y.max, volume.z.max));
    const low = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)];
    const high = [Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)];
    buffer.setPlace(
      low.map((value) => Math.fround(value)),
      high.map((value) => Math.fround(value)),
      [volume.sliceX.offset, volume.sliceY.offset, volume.sliceZ.offset, volume.sliceThreshold].map((value) =>
        Math.fround(value),
      ),
      volume.colorShares.map((value) => Math.fround(value)),
    );
    buffer.showsSlices = volume.showsSlices;
    if (volume.marches) {
      volume.transfer?.writeTable(this.transferTable);
      // Two steps per voxel; a volume reduced on the GPU has bigger voxels, so the rays take fewer steps.
      const voxel = (((high[0] as number) - (low[0] as number)) / data.width) * (volume.gpuFit?.reduction ?? 1);
      const ratio = 1 / fineSteps;
      // Where the corners of the big triangle over the picture lie in the box, at both ends of the depth.
      [
        [-1, -1, 0],
        [3, -1, 0],
        [-1, 3, 0],
        [-1, -1, 1],
        [3, -1, 1],
        [-1, 3, 1],
      ].forEach(([x, y, z], i) => {
        const point = matrix.unproject(x as number, y as number, z as number);
        this.corners.set([point.x, point.y, point.z, 1], i * 4);
      });
      const eye = scene.camera.eye;
      const material = fullMaterial(volume.material);
      buffer.setMarch(
        [voxel * ratio, voxel, ratio, 1].map((value) => Math.fround(value)),
        [volumeModes.indexOf(volume.mode), Math.fround(volume.isoShare)],
        [eye.x, eye.y, eye.z, 1].map((value) => Math.fround(value)),
        [material.gloss, material.sharpness, material.opacity, material.isLit ? 1 : 0].map((value) =>
          Math.fround(value),
        ),
        this.corners,
        this.transferTable,
      );
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
    pie.meshes.forEach((mesh, index) => {
      if (mesh) {
        this.meshKeys.delete(mesh);
        this.uploadMesh(mesh, { pie, index });
      }
    });
  }

  // The places move into the box once; a new range of the axes or a new theme color uploads them again.
  private uploadMesh(mesh: Mesh3D, source: object = mesh): void {
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
    const indices = validIndices(positions, mesh.indices);
    renderer.uploadMesh(mesh, vertices, indices, fullMaterial(mesh.material));
    this.picker.addMesh(mesh, positions, indices, source);
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
    const numbers = new Int32Array(bubbles.count);
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
      numbers[count] = i;
      count++;
    }
    renderer.uploadBubbles(bubbles, instances, count, fullMaterial(bubbles.material));
    // The picker reads center and size of each bubble shown, and which bubble it is.
    const places = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      places.set(floats.subarray((i * bubbleStride) / 4, (i * bubbleStride) / 4 + 4), i * 4);
    }
    this.picker.addBubbles(bubbles, places, numbers.subarray(0, count));
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

  // A small cross at each measured point of a map.
  private addPointMarks(map: MeasuredMap3D): void {
    const scene = this.scene;
    const mark: Rgba8 = { r: 255, g: 255, b: 255, a: 230 };
    const count = Math.min(map.x.length, map.y.length, map.z.length);
    for (let i = 0; i < count; i++) {
      const x = Math.fround(toBox(scene.xAxis, map.x[i] as number));
      const y = Math.fround(toBox(scene.yAxis, map.y[i] as number));
      const z = Math.fround(toBox(scene.zAxis, map.z[i] as number));
      if (Number.isFinite(x + y + z)) {
        addCross(this.lines, x, y, z, mark);
      }
    }
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
      scene.antennas.length,
      scene.maps.length,
      scene.planes.map((plane) => plane.version).join(','),
      scene.cursor,
      scene.waterfalls.map((waterfall) => waterfall.display?.version ?? 0).join(','),
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
    // The cursor of the group as a thin frame across the box at its place on the first axis.
    const cursor = scene.cursor;
    if (cursor !== undefined) {
      const place = toBox(scene.xAxis, cursor);
      if (Math.abs(place) <= 1) {
        const mark: Rgba8 = { r: 255, g: 255, b: 255, a: 200 };
        const corners = new ClipPlane3D(new Point3D(1, 0, 0), place).outline();
        corners.forEach((a, i) => {
          const b = corners[(i + 1) % corners.length] as Point3D;
          this.lines.add(Math.fround(a.x), Math.fround(a.y), Math.fround(a.z), mark);
          this.lines.add(Math.fround(b.x), Math.fround(b.y), Math.fround(b.z), mark);
        });
      }
    }
    const boxMap = new BoxMap(scene.xAxis, scene.yAxis, scene.zAxis);
    const zRange = scene.zAxis.visibleRange;
    for (const waterfall of scene.waterfalls) {
      if (waterfall.display) {
        addSpectrumLines(waterfall, waterfall.display, boxMap, zRange.min, zRange.max, (x, y, z, color) => {
          this.lines.add(x, y, z, color);
        });
      }
    }
    const outline: Rgba8 = { r: 240, g: 150, b: 60, a: 255 };
    for (const plane of scene.planes) {
      const corners = plane.outline();
      corners.forEach((a, i) => {
        const b = corners[(i + 1) % corners.length] as Point3D;
        this.lines.add(Math.fround(a.x), Math.fround(a.y), Math.fround(a.z), outline);
        this.lines.add(Math.fround(b.x), Math.fround(b.y), Math.fround(b.z), outline);
      });
    }
    for (const map of scene.maps) {
      if (map.showsPoints) {
        this.addPointMarks(map);
      }
    }
    const mark: Rgba8 = { r: 255, g: 255, b: 255, a: 255 };
    for (const antenna of scene.antennas) {
      const ends: Point3D[] = [];
      antenna.addMarks(ends);
      for (const end of ends) {
        this.lines.add(toBox(scene.xAxis, end.x), toBox(scene.yAxis, end.y), toBox(scene.zAxis, end.z), mark);
      }
    }
  }
}

function addCross(lines: LineVertices, x: number, y: number, z: number, color: Rgba8): void {
  const size = Math.fround(0.012);
  lines.add(Math.fround(x - size), y, z, color);
  lines.add(Math.fround(x + size), y, z, color);
  lines.add(x, Math.fround(y - size), z, color);
  lines.add(x, Math.fround(y + size), z, color);
  lines.add(x, y, Math.fround(z - size), color);
  lines.add(x, y, Math.fround(z + size), color);
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
