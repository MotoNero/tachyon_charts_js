// Series of ribbons between two curves: area, stacked area and band (RibbonSeries, AreaSeries, StackedAreaSeries,
// BandSeries, SeriesFill and MeshFringe of the .NET version). Fills by value come with the colormaps.
import type { Axis } from '../axes/axis';
import type { PointSource } from '../data/source';
import { DoubleRange } from '../numerics/range';
import { meshVertexStride, type CommandList } from '../render/commands';
import { packRgba8, type Rgba8 } from '../render/types';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';

const f = Math.fround;

/** What fills a shape of a series. */
export interface SeriesFill {
  /** The color at a height in the pane (0 top, 1 bottom) and a value. */
  colorAt(position: number, value: number): Rgba8;
}

/** One color everywhere. */
export class SolidFill implements SeriesFill {
  constructor(
    /** The color of the fill. */
    readonly color: Rgba8,
  ) {}

  /** {@inheritDoc SeriesFill.colorAt} */
  colorAt(): Rgba8 {
    return this.color;
  }
}

/** A gradient from the top of the pane to its bottom. */
export class PositionGradientFill implements SeriesFill {
  constructor(
    /** The color at the top of the pane. */
    readonly top: Rgba8,
    /** The color at the bottom of the pane. */
    readonly bottom: Rgba8,
  ) {}

  /** {@inheritDoc SeriesFill.colorAt} */
  colorAt(position: number): Rgba8 {
    return mixColors(this.top, this.bottom, position);
  }
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  return rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
}

/** Mixes two colors channel by channel, rounded as the .NET version does. */
export function mixColors(first: Rgba8, second: Rgba8, amount: number): Rgba8 {
  const part = Number.isNaN(amount) ? 0 : Math.min(Math.max(amount, 0), 1);
  const channel = (from: number, to: number): number => roundHalfEven(from + (to - from) * part);
  return {
    r: channel(first.r, second.r),
    g: channel(first.g, second.g),
    b: channel(first.b, second.b),
    a: channel(first.a, second.a),
  };
}

/** Corners of triangles in pixels with their colors, as `fillMesh` takes them; kept between frames. */
export class Mesh {
  data = new Float32Array(3 * 1024);
  count = 0;
  private words = new Uint32Array(this.data.buffer);

  clear(): void {
    this.count = 0;
  }

  add(x: number, y: number, color: number): void {
    if ((this.count + 1) * meshVertexStride > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
      this.words = new Uint32Array(grown.buffer);
    }
    const at = this.count * meshVertexStride;
    this.data[at] = x;
    this.data[at + 1] = y;
    this.words[at + 2] = color;
    this.count++;
  }
}

interface Corner {
  x: number;
  y: number;
  color: Rgba8;
}

const fringeWidth = 1;
const straight = 0.01;

/** A soft band of one pixel along the outside of a slanted edge, from the color of the edge to nothing. */
function addFringe(mesh: Mesh, a: Corner, b: Corner, insideX: number, insideY: number): void {
  const alongX = f(b.x - a.x);
  const alongY = f(b.y - a.y);
  if (Math.abs(alongX) < straight || Math.abs(alongY) < straight) {
    return;
  }
  const length = f(Math.sqrt(f(f(alongY * alongY) + f(alongX * alongX))));
  const normalX = f(alongY / length);
  const normalY = f(-alongX / length);
  const side = f(f(normalX * f(insideX - a.x)) + f(normalY * f(insideY - a.y)));
  if (!Number.isFinite(side) || Math.abs(side) < 1e-4) {
    return;
  }
  const outX = f((side > 0 ? -normalX : normalX) * fringeWidth);
  const outY = f((side > 0 ? -normalY : normalY) * fringeWidth);
  const colorA = packRgba8(a.color);
  const colorB = packRgba8(b.color);
  const clearA = packRgba8({ ...a.color, a: 0 });
  const clearB = packRgba8({ ...b.color, a: 0 });
  mesh.add(a.x, a.y, colorA);
  mesh.add(b.x, b.y, colorB);
  mesh.add(f(b.x + outX), f(b.y + outY), clearB);
  mesh.add(a.x, a.y, colorA);
  mesh.add(f(b.x + outX), f(b.y + outY), clearB);
  mesh.add(f(a.x + outX), f(a.y + outY), clearA);
}

interface Column {
  pixel: number;
  lower: number;
  upper: number;
}

/** The value further away from the other curve. */
function extreme(current: number, candidate: number, other: number): number {
  if (Number.isNaN(candidate) || Number.isNaN(current)) {
    return Number.isNaN(candidate) ? Number.NaN : current;
  }
  return Math.abs(candidate - other) > Math.abs(current - other) ? candidate : current;
}

function corner(frame: SeriesFrame, x: number, value: number, fill: SeriesFill): Corner {
  const y = frame.y.toPixel(value);
  return { x, y: f(y), color: fill.colorAt((y - frame.bounds.y) / frame.bounds.height, value) };
}

/**
 * A series made of ribbons between two curves. X values rise and are shared by all curves. The ribbons are rebuilt
 * when the data or the view changes, with at most two columns per pixel.
 */
export abstract class RibbonSeries extends ChartSeries {
  private readonly mesh = new Mesh();
  private builtVersion = -1;
  private builtFrame: SeriesFrame | undefined;
  private appearance = 0;

  /** Grows with every change of the look. */
  protected get appearanceVersion(): number {
    return this.appearance;
  }

  /** Asks for a new frame after a change of the look. */
  protected changed(): void {
    this.appearance++;
  }

  /** Adds the triangles of the series. */
  protected abstract build(
    frame: SeriesFrame,
    add: (
      x: ArrayLike<number>,
      lower: ArrayLike<number>,
      upper: ArrayLike<number>,
      fill: SeriesFill,
      smoothsTop: boolean,
    ) => void,
  ): void;

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(_device: unknown, frame: SeriesFrame): void {
    const version = this.version;
    if (version === this.builtVersion && frame === this.builtFrame) {
      return;
    }
    this.mesh.clear();
    this.build(frame, (x, lower, upper, fill, smoothsTop) => {
      this.addRibbon(frame, x, lower, upper, fill, smoothsTop);
    });
    this.builtVersion = version;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.mesh.count > 0) {
      commands.fillMesh(this.mesh.data, this.mesh.count, frame.bounds);
    }
  }

  private addRibbon(
    frame: SeriesFrame,
    x: ArrayLike<number>,
    lower: ArrayLike<number>,
    upper: ArrayLike<number>,
    fill: SeriesFill,
    smoothsTop: boolean,
  ): void {
    const count = Math.min(x.length, lower.length, upper.length);
    const stride = Math.max(Math.trunc(count / Math.max(Math.trunc(frame.bounds.width * 2), 1)), 1);
    let previous: Column | undefined;
    for (let i = 0; i < count; i += stride) {
      // Within a stride the column shows the widest part, so that peaks survive.
      let low = lower[i] as number;
      let high = upper[i] as number;
      for (let j = i + 1; j < Math.min(i + stride, count); j++) {
        low = extreme(low, lower[j] as number, high);
        high = extreme(high, upper[j] as number, low);
      }
      // On whole pixels: an edge through pixel centers would fall differently in each renderer.
      const column: Column = { pixel: roundHalfEven(f(frame.x.toPixel(x[i] as number))), lower: low, upper: high };
      if (Number.isNaN(low) || Number.isNaN(high) || !Number.isFinite(column.pixel)) {
        previous = undefined;
        continue;
      }
      if (previous) {
        this.addQuad(frame, previous, column, fill, smoothsTop);
      }
      previous = column;
    }
  }

  private addQuad(frame: SeriesFrame, first: Column, second: Column, fill: SeriesFill, smoothsTop: boolean): void {
    const a = corner(frame, first.pixel, first.lower, fill);
    const b = corner(frame, first.pixel, first.upper, fill);
    const c = corner(frame, second.pixel, second.upper, fill);
    const d = corner(frame, second.pixel, second.lower, fill);
    // A soft band of one pixel above the upper curve; the steps between the columns join inside.
    if (smoothsTop) {
      addFringe(this.mesh, b, c, f(f(a.x + d.x) / 2), f(f(a.y + d.y) / 2));
    }
    const mesh = this.mesh;
    for (const point of [a, b, c, a, c, d]) {
      mesh.add(point.x, point.y, packRgba8(point.color));
    }
  }
}

/** The area between a curve and a baseline. */
export class AreaSeries extends RibbonSeries {
  private base = 0;
  private areaFill: SeriesFill = new SolidFill({ r: 80, g: 170, b: 240, a: 160 });
  private lower = new Float64Array(0);
  private yCache: { metadata: unknown; base: number; range: DoubleRange } | undefined;

  constructor(
    /** The data. */
    readonly source: PointSource,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** The value the area reaches down (or up) to; 0. */
  get baseline(): number {
    return this.base;
  }

  set baseline(value: number) {
    this.base = value;
    this.changed();
  }

  /** The fill of the area. */
  get fill(): SeriesFill {
    return this.areaFill;
  }

  set fill(value: SeriesFill) {
    this.areaFill = value;
    this.changed();
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.areaFill.colorAt(0, 0);
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.source.version + this.appearanceVersion;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const metadata = this.source.metadata;
    if (metadata.count === 0) {
      return undefined;
    }
    if (axis === 'x') {
      return metadata.xRange;
    }
    if (this.yCache?.metadata !== metadata || this.yCache.base !== this.base) {
      const range = metadata.yRange.isEmpty
        ? metadata.yRange
        : new DoubleRange(Math.min(metadata.yRange.min, this.base), Math.max(metadata.yRange.max, this.base));
      this.yCache = { metadata, base: this.base, range };
    }
    return this.yCache.range;
  }

  /** {@inheritDoc RibbonSeries.build} */
  protected build(_frame: SeriesFrame, add: Parameters<RibbonSeries['build']>[1]): void {
    const snapshot = this.source.snapshot();
    if (this.lower.length !== snapshot.count) {
      this.lower = new Float64Array(snapshot.count);
    }
    this.lower.fill(this.base);
    add(
      snapshot.x.subarray(0, snapshot.count),
      this.lower,
      snapshot.y.subarray(0, snapshot.count),
      this.areaFill,
      true,
    );
  }
}

const stackColors: readonly Rgba8[] = [
  { r: 76, g: 201, b: 240, a: 200 },
  { r: 247, g: 37, b: 133, a: 200 },
  { r: 124, g: 252, b: 154, a: 200 },
  { r: 255, g: 183, b: 3, a: 200 },
  { r: 179, g: 136, b: 255, a: 200 },
];

/** The edges of stacked layers: each layer on top of the ones before; NaN counts as 0; in percent on request. */
export function stackLayers(layers: readonly ArrayLike<number>[], isPercent: boolean): Float64Array[] {
  const count = layers.length === 0 ? 0 : Math.min(...layers.map((layer) => layer.length));
  const edges = layers.map(() => new Float64Array(count));
  for (let i = 0; i < count; i++) {
    let sum = 0;
    layers.forEach((layer, index) => {
      const value = layer[i] as number;
      sum += Number.isFinite(value) ? value : 0;
      (edges[index] as Float64Array)[i] = sum;
    });
    if (isPercent && sum !== 0) {
      for (const edge of edges) {
        edge[i] = (edge[i] as number) * (100 / sum);
      }
    }
  }
  return edges;
}

/** Areas on top of each other. All layers share the X values of the first. A missing value counts as zero. */
export class StackedAreaSeries extends RibbonSeries {
  private layerFills: readonly SeriesFill[];
  private percent = false;
  private edgesVersion = -1;
  private edges: Float64Array[] = [];
  private yRange: DoubleRange | undefined;

  /** @throws RangeError without layers. */
  constructor(
    /** The layers, the lowest first. */
    readonly layers: readonly PointSource[],
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
    if (layers.length === 0) {
      throw new RangeError('A stack needs at least one layer.');
    }
    this.layerFills = layers.map((_, index) => new SolidFill(stackColors[index % stackColors.length] as Rgba8));
  }

  /** The fill of each layer. @throws RangeError when not every layer has one. */
  get fills(): readonly SeriesFill[] {
    return this.layerFills;
  }

  set fills(value: readonly SeriesFill[]) {
    if (value.length !== this.layers.length) {
      throw new RangeError('Every layer needs a fill.');
    }
    this.layerFills = [...value];
    this.changed();
  }

  /** Whether the layers show shares of their sum in percent. */
  get isPercent(): boolean {
    return this.percent;
  }

  set isPercent(value: boolean) {
    this.percent = value;
    this.changed();
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    let sum = this.appearanceVersion;
    for (const layer of this.layers) {
      sum += layer.version;
    }
    return sum;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const first = this.layers[0] as PointSource;
    if (axis === 'x') {
      return first.metadata.count > 0 ? first.metadata.xRange : undefined;
    }
    this.readEdges();
    return this.yRange;
  }

  /** {@inheritDoc RibbonSeries.build} */
  protected build(_frame: SeriesFrame, add: Parameters<RibbonSeries['build']>[1]): void {
    const edges = this.readEdges();
    const snapshot = (this.layers[0] as PointSource).snapshot();
    const x = snapshot.x.subarray(0, snapshot.count);
    const zero = new Float64Array(edges[0]?.length ?? 0);
    edges.forEach((edge, layer) => {
      add(
        x,
        layer === 0 ? zero : (edges[layer - 1] as Float64Array),
        edge,
        this.layerFills[layer] as SeriesFill,
        layer === edges.length - 1,
      );
    });
  }

  // Computed again only when a layer or the look changed.
  private readEdges(): Float64Array[] {
    const version = this.version;
    if (version !== this.edgesVersion) {
      this.edgesVersion = version;
      this.edges = stackLayers(
        this.layers.map((layer) => {
          const snapshot = layer.snapshot();
          return snapshot.y.subarray(0, snapshot.count);
        }),
        this.percent,
      );
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const value of this.edges[this.edges.length - 1] ?? []) {
        min = Math.min(min, value, 0);
        max = Math.max(max, value, 0);
      }
      this.yRange = (this.edges[0]?.length ?? 0) > 0 && min <= max ? new DoubleRange(min, max) : undefined;
    }
    return this.edges;
  }
}

/** Inserts the crossings of two curves as points of their own. */
export function insertCrossings(
  x: ArrayLike<number>,
  first: ArrayLike<number>,
  second: ArrayLike<number>,
): { x: number[]; first: number[]; second: number[] } {
  const count = Math.min(x.length, first.length, second.length);
  const result = { x: [] as number[], first: [] as number[], second: [] as number[] };
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      const before = (first[i - 1] as number) - (second[i - 1] as number);
      const after = (first[i] as number) - (second[i] as number);
      if (before * after < 0) {
        const part = before / (before - after);
        const value = (first[i - 1] as number) + ((first[i] as number) - (first[i - 1] as number)) * part;
        result.x.push((x[i - 1] as number) + ((x[i] as number) - (x[i - 1] as number)) * part);
        result.first.push(value);
        result.second.push(value);
      }
    }
    result.x.push(x[i] as number);
    result.first.push(first[i] as number);
    result.second.push(second[i] as number);
  }
  return result;
}

/**
 * The band between two curves, with a fill of its own for each side: where the first curve lies above the second,
 * and the other way round. Crossings are found, so that the fills meet exactly.
 */
export class BandSeries extends RibbonSeries {
  private firstFill: SeriesFill = new SolidFill({ r: 110, g: 210, b: 130, a: 150 });
  private secondFill: SeriesFill = new SolidFill({ r: 240, g: 100, b: 100, a: 150 });
  private yCache: { first: unknown; second: unknown; range: DoubleRange } | undefined;

  constructor(
    /** The first curve. */
    readonly first: PointSource,
    /** The second curve. */
    readonly second: PointSource,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** The fill where the first curve lies above the second. */
  get firstAboveFill(): SeriesFill {
    return this.firstFill;
  }

  set firstAboveFill(value: SeriesFill) {
    this.firstFill = value;
    this.changed();
  }

  /** The fill where the second curve lies above the first. */
  get secondAboveFill(): SeriesFill {
    return this.secondFill;
  }

  set secondAboveFill(value: SeriesFill) {
    this.secondFill = value;
    this.changed();
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.first.version + this.second.version + this.appearanceVersion;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const [one, two] = [this.first.metadata, this.second.metadata];
    if (one.count === 0) {
      return undefined;
    }
    if (axis === 'x') {
      return one.xRange;
    }
    if (this.yCache?.first !== one || this.yCache.second !== two) {
      this.yCache = { first: one, second: two, range: one.yRange.union(two.yRange) };
    }
    return this.yCache.range;
  }

  /** {@inheritDoc RibbonSeries.build} */
  protected build(_frame: SeriesFrame, add: Parameters<RibbonSeries['build']>[1]): void {
    const one = this.first.snapshot();
    const two = this.second.snapshot();
    const { x, first, second } = insertCrossings(
      one.x.subarray(0, one.count),
      one.y.subarray(0, one.count),
      two.y.subarray(0, two.count),
    );
    // Each side is a ribbon that collapses to nothing where the other one is on top.
    const lowerOfBoth = first.map((value, i) => {
      const other = second[i] as number;
      return Number.isNaN(value) || Number.isNaN(other) ? Number.NaN : Math.min(value, other);
    });
    add(x, lowerOfBoth, first, this.firstFill, false);
    add(x, lowerOfBoth, second, this.secondFill, false);
  }
}
