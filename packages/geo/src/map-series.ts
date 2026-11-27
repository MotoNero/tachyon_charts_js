// The regions of a map on a chart, as GeoMapSeries of the .NET version: the sea, the regions in their colors and their
// borders, at the level of detail the view asks for, with one scale on both axes.
import {
  BufferUsage,
  ChartSeries,
  DoubleRange,
  lineGap,
  meshVertexStride,
  packRgba8,
  type Axis,
  type CommandList,
  type FoundPoint,
  type GpuBuffer,
  type RenderDevice,
  type Rgba8,
  type SeriesFrame,
} from '@tachyon-charts/core';
import type { GeoMap, GeoMapLevel, GeoRegion } from './geo-map';
import type { GeoProjection } from './projection';

const f = Math.fround;
// From these shares of the width of the world the next finer level takes over.
const mediumBelow = 0.35;
const fineBelow = 0.06;

interface ProjectedArea {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly triangles: Int32Array;
  readonly rings: Int32Array;
}

interface ProjectedRegion {
  readonly code: string;
  readonly areas: readonly ProjectedArea[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The regions of a map in the plane of a projection: the sea, the regions in their colors and their borders. */
export class GeoMapSeries extends ChartSeries {
  private readonly levels: (GeoMap | undefined)[];
  private readonly loading: (Promise<void> | undefined)[];
  private readonly projected: (ProjectedRegion[] | undefined)[];
  private readonly colors = new Map<string, Rgba8>();
  private readonly world: { x: Float64Array; y: Float64Array };
  private readonly worldX: DoubleRange;
  private readonly worldY: DoubleRange;
  private mesh = new Float32Array(3 * 4096);
  private words = new Uint32Array(this.mesh.buffer);
  private meshCount = 0;
  private borders: number[] = [];
  private borderData = new Float32Array(0);
  private buffer: GpuBuffer | undefined;
  private appearance = 0;
  private built = -1;
  private builtFrame: SeriesFrame | undefined;
  private landColor: Rgba8 = { r: 214, g: 214, b: 200, a: 255 };
  private seaColor: Rgba8 = { r: 196, g: 216, b: 232, a: 255 };
  private borderColor: Rgba8 = { r: 120, g: 120, b: 110, a: 255 };
  private thickness = 0.6;
  private shown = 0;
  private failure: unknown;
  /** Whether the chart keeps one scale on both axes, so that the map is not stretched. */
  keepsAspect = true;

  /**
   * @param levels - The levels of detail, coarse to fine: maps, or functions that bring them when first needed.
   * @param projection - The projection.
   * @param xAxis - The X axis, east on the plane.
   * @param yAxis - The Y axis, north on the plane.
   * @throws RangeError without a level.
   */
  constructor(
    levels: readonly GeoMapLevel[],
    /** The projection. */
    readonly projection: GeoProjection,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
    if (levels.length === 0) {
      throw new RangeError('A map needs a level of detail.');
    }
    this.sources = [...levels];
    this.levels = levels.map((level) => (typeof level === 'function' ? undefined : level));
    this.loading = levels.map(() => undefined);
    this.projected = levels.map(() => undefined);
    this.world = outline(projection);
    this.worldX = new DoubleRange(Math.min(...this.world.x), Math.max(...this.world.x));
    this.worldY = new DoubleRange(Math.min(...this.world.y), Math.max(...this.world.y));
  }

  private readonly sources: readonly GeoMapLevel[];

  /** The color of regions without one of their own. */
  get land(): Rgba8 {
    return this.landColor;
  }

  set land(value: Rgba8) {
    this.landColor = value;
    this.appearance++;
  }

  /** The color of the sea, the world outside the regions; transparent for none. */
  get sea(): Rgba8 {
    return this.seaColor;
  }

  set sea(value: Rgba8) {
    this.seaColor = value;
    this.appearance++;
  }

  /** The color of the borders; transparent for none. */
  get border(): Rgba8 {
    return this.borderColor;
  }

  set border(value: Rgba8) {
    this.borderColor = value;
    this.appearance++;
  }

  /**
   * The thickness of the borders in device-independent pixels.
   * @throws RangeError when negative.
   */
  get borderThickness(): number {
    return this.thickness;
  }

  set borderThickness(value: number) {
    if (!(value >= 0)) {
      throw new RangeError('The thickness of the borders must not be negative.');
    }
    this.thickness = value;
    this.appearance++;
  }

  /** The level of detail of the last frame, 0 the coarsest. */
  get level(): number {
    return this.shown;
  }

  /** Why a level could not be read, if one could not. */
  get error(): unknown {
    return this.failure;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.landColor;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.version} */
  get version(): number {
    return this.appearance;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.drawnPointCount} */
  override get drawnPointCount(): number {
    return this.meshCount;
  }

  /** Sets the colors of regions by their codes, such as data by country; the others take the color of the land. */
  setColors(colors: ReadonlyMap<string, Rgba8> | Readonly<Record<string, Rgba8>>): void {
    this.colors.clear();
    const entries = colors instanceof Map ? colors.entries() : Object.entries(colors);
    for (const [code, color] of entries as Iterable<[string, Rgba8]>) {
      this.colors.set(code.toUpperCase(), color);
    }
    this.appearance++;
  }

  /** The region at a place in degrees, on the finest level that is read; undefined on the sea. */
  regionAt(longitude: number, latitude: number): GeoRegion | undefined {
    const map = this.finestLoaded();
    return map?.regions.find((region) => region.contains(longitude, latitude));
  }

  /** Waits until the levels the map has asked for so far are read, such as before a picture of a test. */
  async whenLoaded(): Promise<void> {
    await Promise.all(this.loading.filter((each) => each !== undefined));
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    return axis === 'x' ? this.worldX : this.worldY;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.findPoint} */
  override findPoint(frame: SeriesFrame, pixelX: number, pixelY: number): FoundPoint | undefined {
    const x = frame.x.toData(pixelX);
    const y = frame.y.toData(pixelY);
    const place = this.projection.unproject(x, y);
    const map = this.finestLoaded();
    if (!place || !map) {
      return undefined;
    }
    const index = map.regions.findIndex((region) => region.contains(place.longitude, place.latitude));
    return index >= 0 ? { index, x, y } : undefined;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    if (this.keepsAspect) {
      this.keepAspect(frame);
    }
    if (this.appearance === this.built && frame === this.builtFrame) {
      return;
    }
    this.built = this.appearance;
    this.builtFrame = frame;
    this.meshCount = 0;
    this.borders = [];
    const bounds = frame.bounds;
    const left = Math.min(frame.x.toData(bounds.x), frame.x.toData(bounds.x + bounds.width));
    const right = Math.max(frame.x.toData(bounds.x), frame.x.toData(bounds.x + bounds.width));
    const bottom = Math.min(frame.y.toData(bounds.y + bounds.height), frame.y.toData(bounds.y));
    const top = Math.max(frame.y.toData(bounds.y + bounds.height), frame.y.toData(bounds.y));
    const share = (right - left) / Math.max(this.worldX.length, 1e-12);
    const wanted = Math.min(this.levels.length - 1, levelOf(share));
    // Until the wanted level is read, the finest coarser one shows, else any that is read.
    this.request(wanted);
    let level = wanted;
    while (level > 0 && !this.levels[level]) {
      level--;
    }
    if (!this.levels[level]) {
      level = this.levels.findIndex((each) => each !== undefined);
    }
    if (this.seaColor.a > 0) {
      this.addSea(frame);
    }
    if (level >= 0) {
      this.shown = level;
      const regions = (this.projected[level] ??= this.project(this.levels[level] as GeoMap));
      for (const region of regions) {
        if (region.maxX >= left && region.minX <= right && region.maxY >= bottom && region.minY <= top) {
          this.addRegion(frame, region);
        }
      }
    }
    if (this.borders.length >= 4) {
      if (this.borderData.length < this.borders.length) {
        this.borderData = new Float32Array(this.borders.length);
      }
      this.borderData.set(this.borders);
      const data = this.borderData.subarray(0, this.borders.length);
      if (!this.buffer || this.buffer.sizeInBytes < data.byteLength) {
        this.buffer?.dispose();
        this.buffer = device.createBuffer({ sizeInBytes: Math.max(data.byteLength, 4096), usage: BufferUsage.vertex });
      }
      this.buffer.write(0, data);
    }
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.meshCount > 0) {
      commands.fillMesh(this.mesh, this.meshCount, frame.bounds);
    }
    const count = this.borders.length / 2;
    if (this.buffer && count >= 2 && this.borderColor.a > 0) {
      commands.drawPolyline(this.buffer, 0, count, {
        widthInPixels: f(this.thickness * frame.dpiScale),
        color: this.borderColor,
        clip: frame.bounds,
      });
    }
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.buffer?.dispose();
    this.buffer = undefined;
    this.built = -1;
  }

  private request(level: number): void {
    const source = this.sources[level];
    if (this.levels[level] || this.loading[level] || typeof source !== 'function') {
      return;
    }
    this.loading[level] = source().then(
      (map) => {
        this.levels[level] = map;
        this.appearance++;
      },
      (error: unknown) => {
        this.failure = error;
      },
    );
  }

  private finestLoaded(): GeoMap | undefined {
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const map = this.levels[i];
      if (map) {
        return map;
      }
    }
    return undefined;
  }

  // The triangles of a region in its color, and its borders.
  private addRegion(frame: SeriesFrame, region: ProjectedRegion): void {
    const color = packRgba8(this.colors.get(region.code) ?? this.landColor);
    const drawsBorders = this.borderColor.a > 0 && this.thickness > 0;
    for (const area of region.areas) {
      for (const corner of area.triangles) {
        this.add(f(frame.x.toPixel(area.x[corner] as number)), f(frame.y.toPixel(area.y[corner] as number)), color);
      }
      if (drawsBorders) {
        this.addRings(frame, area);
      }
    }
  }

  private addRings(frame: SeriesFrame, area: ProjectedArea): void {
    let start = 0;
    for (const length of area.rings) {
      if (this.borders.length > 0) {
        this.borders.push(lineGap, lineGap);
      }
      for (let i = 0; i <= length; i++) {
        const at = start + (i % length);
        this.borders.push(f(frame.x.toPixel(area.x[at] as number)), f(frame.y.toPixel(area.y[at] as number)));
      }
      start += length;
    }
  }

  // The sea as a fan from the middle of the outline, which every projection here keeps convex enough.
  private addSea(frame: SeriesFrame): void {
    const color = packRgba8(this.seaColor);
    const middleX = f(frame.x.toPixel((this.worldX.min + this.worldX.max) / 2));
    const middleY = f(frame.y.toPixel((this.worldY.min + this.worldY.max) / 2));
    const { x, y } = this.world;
    for (let i = 0; i < x.length; i++) {
      const next = (i + 1) % x.length;
      this.add(middleX, middleY, color);
      this.add(f(frame.x.toPixel(x[i] as number)), f(frame.y.toPixel(y[i] as number)), color);
      this.add(f(frame.x.toPixel(x[next] as number)), f(frame.y.toPixel(y[next] as number)), color);
    }
  }

  private add(x: number, y: number, color: number): void {
    if ((this.meshCount + 1) * meshVertexStride > this.mesh.length) {
      const grown = new Float32Array(this.mesh.length * 2);
      grown.set(this.mesh);
      this.mesh = grown;
      this.words = new Uint32Array(grown.buffer);
    }
    const at = this.meshCount * meshVertexStride;
    this.mesh[at] = x;
    this.mesh[at + 1] = y;
    this.words[at + 2] = color;
    this.meshCount++;
  }

  // One scale on both axes: the vertical range follows the horizontal one around its middle.
  private keepAspect(frame: SeriesFrame): void {
    const bounds = frame.bounds;
    if (bounds.width < 1 || bounds.height < 1) {
      return;
    }
    const xRange = this.xAxis.visibleRange;
    const yRange = this.yAxis.visibleRange;
    const wanted = (xRange.length * bounds.height) / bounds.width;
    if (!Number.isFinite(wanted) || wanted <= 0 || Math.abs(wanted - yRange.length) <= yRange.length * 1e-3) {
      return;
    }
    const middle = (yRange.min + yRange.max) / 2;
    this.yAxis.visibleRange = new DoubleRange(middle - wanted / 2, middle + wanted / 2);
    this.appearance++;
  }

  // A level on the plane: each region with its box and its areas, corners projected once.
  private project(map: GeoMap): ProjectedRegion[] {
    return map.regions.map((region) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const areas = region.polygons.map((_, p) => {
        const cut = region.triangles(p);
        const { x, y } = this.projection.projectAll(cut.x, cut.y);
        for (let i = 0; i < x.length; i++) {
          minX = Math.min(minX, x[i] as number);
          minY = Math.min(minY, y[i] as number);
          maxX = Math.max(maxX, x[i] as number);
          maxY = Math.max(maxY, y[i] as number);
        }
        return { x, y, triangles: cut.triangles, rings: cut.rings };
      });
      return { code: region.code.toUpperCase(), areas, minX, minY, maxX, maxY };
    });
  }
}

// The outline of the world on the plane: along the meridians at ±180° and the parallels at ±90°.
function outline(projection: GeoProjection): { x: Float64Array; y: Float64Array } {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (longitude: number, latitude: number): void => {
    const point = projection.project(longitude, latitude);
    xs.push(point.x);
    ys.push(point.y);
  };
  for (let latitude = -90; latitude <= 90; latitude += 2) {
    add(-180, latitude);
  }
  for (let longitude = -180; longitude <= 180; longitude += 2) {
    add(longitude, 90);
  }
  for (let latitude = 90; latitude >= -90; latitude -= 2) {
    add(180, latitude);
  }
  for (let longitude = 180; longitude >= -180; longitude -= 2) {
    add(longitude, -90);
  }
  return { x: Float64Array.from(xs), y: Float64Array.from(ys) };
}

// The coarse level for wide views, the finer ones as the view narrows.
function levelOf(share: number): number {
  if (share > mediumBelow) {
    return 0;
  }
  return share > fineBelow ? 1 : 2;
}
