// Bars or columns (BarSeries and MeshShapes of the .NET version).
import type { Axis } from '../axes/axis';
import { DoubleRange } from '../numerics/range';
import type { LinearAxisTransform } from '../numerics/transform';
import type { CommandList } from '../render/commands';
import { packRgba8, type PixelRect, type Rgba8 } from '../render/types';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import { Mesh, SolidFill, type SeriesFill } from './ribbon-series';

const f = Math.fround;
const cornerSegments = 6;

/** How the rows of a bar series share a place: side by side, on top of each other, or as shares of 100 %. */
export type BarLayout = 'grouped' | 'stacked' | 'percent';

const barColors: readonly Rgba8[] = [
  { r: 76, g: 201, b: 240, a: 255 },
  { r: 247, g: 37, b: 133, a: 255 },
  { r: 124, g: 252, b: 154, a: 255 },
  { r: 255, g: 183, b: 3, a: 255 },
  { r: 179, g: 136, b: 255, a: 255 },
];

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  return rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
}

/** Where the bars of each row start and end, by place; stacked rows grow up from zero and down for negatives. */
export function computeBarEnds(
  rows: readonly ArrayLike<number>[],
  layout: BarLayout,
): { lower: Float64Array[]; upper: Float64Array[] } {
  const count = rows[0]?.length ?? 0;
  const lower = rows.map(() => new Float64Array(count));
  const upper = rows.map(() => new Float64Array(count));
  for (let i = 0; i < count; i++) {
    let above = 0;
    let below = 0;
    rows.forEach((row, index) => {
      const value = row[i] as number;
      const low = lower[index] as Float64Array;
      const high = upper[index] as Float64Array;
      if (layout === 'grouped') {
        high[i] = value;
        return;
      }
      const amount = Number.isFinite(value) ? value : 0;
      // Negative values stack downwards from zero, each side on its own.
      if (amount >= 0) {
        low[i] = above;
        above += amount;
        high[i] = above;
      } else {
        low[i] = below;
        below += amount;
        high[i] = below;
      }
    });
    if (layout === 'percent' && above - below !== 0) {
      const factor = 100 / (above - below);
      for (let row = 0; row < rows.length; row++) {
        (lower[row] as Float64Array)[i] = ((lower[row] as Float64Array)[i] as number) * factor;
        (upper[row] as Float64Array)[i] = ((upper[row] as Float64Array)[i] as number) * factor;
      }
    }
  }
  return { lower, upper };
}

/**
 * Bars or columns: one row of values per color, at places 0, 1, 2 or at given positions. Narrower than a pixel they
 * merge to one bar per pixel, which keeps peaks visible and a million bars fast.
 */
export class BarSeries extends ChartSeries {
  private rowValues: Float64Array[];
  private places: Float64Array | undefined;
  private barLayout: BarLayout = 'grouped';
  private horizontal = false;
  private share = 0.8;
  private radius = 0;
  private rowFills: readonly SeriesFill[];
  private shadow: Rgba8 | undefined;
  private blur = 6;
  private changes = 0;
  private readonly mesh = new Mesh();
  private builtVersion = -1;
  private builtFrame: SeriesFrame | undefined;
  private endsVersion = -1;
  private ends: { lower: Float64Array[]; upper: Float64Array[] } = { lower: [], upper: [] };
  private ranges: { x: DoubleRange | undefined; y: DoubleRange | undefined } = { x: undefined, y: undefined };

  /** @throws RangeError without rows or with rows of different lengths. */
  constructor(rows: readonly ArrayLike<number>[], xAxis: Axis, yAxis: Axis) {
    super(xAxis, yAxis);
    this.rowValues = BarSeries.validate(rows);
    this.rowFills = rows.map((_, index) => new SolidFill(barColors[index % barColors.length] as Rgba8));
  }

  /** The places of the bars; 0, 1, 2 and so on when left out. */
  get positions(): ArrayLike<number> | undefined {
    return this.places;
  }

  set positions(value: ArrayLike<number> | undefined) {
    this.places = value ? Float64Array.from(value) : undefined;
    this.touch();
  }

  /** How the rows share a place. */
  get layout(): BarLayout {
    return this.barLayout;
  }

  set layout(value: BarLayout) {
    this.barLayout = value;
    this.touch();
  }

  /** Whether the bars lie along the X axis, with their places on the Y axis. */
  get isHorizontal(): boolean {
    return this.horizontal;
  }

  set isHorizontal(value: boolean) {
    this.horizontal = value;
    this.touch();
  }

  /** The share of the distance between places that a bar or group takes, above 0 and at most 1; 0.8. */
  get barWidth(): number {
    return this.share;
  }

  set barWidth(value: number) {
    if (!(value > 0 && value <= 1)) {
      throw new RangeError(`The share must be above 0 and at most 1, not ${String(value)}.`);
    }
    this.share = value;
    this.touch();
  }

  /** The radius of the corners in device-independent units. */
  get cornerRadius(): number {
    return this.radius;
  }

  set cornerRadius(value: number) {
    this.radius = Math.max(value, 0);
    this.touch();
  }

  /** The color of a soft shadow below each bar; none when left out. */
  get shadowColor(): Rgba8 | undefined {
    return this.shadow;
  }

  set shadowColor(value: Rgba8 | undefined) {
    this.shadow = value;
    this.touch();
  }

  /** The reach of the shadow in device-independent units; 6. */
  get shadowBlur(): number {
    return this.blur;
  }

  set shadowBlur(value: number) {
    this.blur = Math.max(value, 0);
    this.touch();
  }

  /** The fill of each row. @throws RangeError when not every row has one. */
  get fills(): readonly SeriesFill[] {
    return this.rowFills;
  }

  set fills(value: readonly SeriesFill[]) {
    if (value.length !== this.rowValues.length) {
      throw new RangeError('Every row needs a fill.');
    }
    this.rowFills = [...value];
    this.touch();
  }

  override get accentColor(): Rgba8 {
    return (this.rowFills[0] as SeriesFill).colorAt(0, 0);
  }

  get version(): number {
    return this.changes;
  }

  override get drawnPointCount(): number {
    return Math.trunc(this.mesh.count / 6);
  }

  /**
   * Replaces the values, as many rows as before.
   * @throws RangeError when the number of rows changes or they differ in length.
   */
  setValues(rows: readonly ArrayLike<number>[]): void {
    const valid = BarSeries.validate(rows);
    if (valid.length !== this.rowValues.length) {
      throw new RangeError('The number of rows must stay the same.');
    }
    this.rowValues = valid;
    this.touch();
  }

  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    this.readEnds();
    return axis === 'x' ? this.ranges.x : this.ranges.y;
  }

  override prepare(_device: unknown, frame: SeriesFrame): void {
    if (this.builtVersion === this.changes && this.builtFrame === frame) {
      return;
    }
    this.mesh.clear();
    this.build(frame);
    this.builtVersion = this.changes;
    this.builtFrame = frame;
  }

  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.mesh.count > 0) {
      commands.fillMesh(this.mesh.data, this.mesh.count, frame.bounds);
    }
  }

  private static validate(rows: readonly ArrayLike<number>[]): Float64Array[] {
    const first = rows[0];
    if (!first || rows.some((row) => row.length !== first.length)) {
      throw new RangeError('There must be rows of equal length.');
    }
    return rows.map((row) => Float64Array.from(row));
  }

  private touch(): void {
    this.changes++;
  }

  private position(index: number): number {
    return this.places ? (this.places[index] as number) : index;
  }

  private step(): number {
    const count = (this.rowValues[0] as Float64Array).length;
    return count < 2 ? 1 : (this.position(count - 1) - this.position(0)) / (count - 1);
  }

  // The ends and the data ranges, computed again only after a change.
  private readEnds(): { lower: Float64Array[]; upper: Float64Array[] } {
    if (this.endsVersion !== this.changes) {
      this.endsVersion = this.changes;
      this.ends = computeBarEnds(this.rowValues, this.barLayout);
      const count = (this.rowValues[0] as Float64Array).length;
      let min = 0;
      let max = 0;
      this.ends.upper.forEach((upper, row) => {
        const lower = this.ends.lower[row] as Float64Array;
        for (let i = 0; i < count; i++) {
          const high = upper[i] as number;
          if (Number.isFinite(high)) {
            min = Math.min(min, lower[i] as number, high);
            max = Math.max(max, lower[i] as number, high);
          }
        }
      });
      const step = this.step();
      const places =
        count === 0 ? undefined : new DoubleRange(this.position(0) - step / 2, this.position(count - 1) + step / 2);
      const values = count === 0 ? undefined : new DoubleRange(min, max);
      this.ranges = this.horizontal ? { x: values, y: places } : { x: places, y: values };
    }
    return this.ends;
  }

  private build(frame: SeriesFrame): void {
    const count = (this.rowValues[0] as Float64Array).length;
    if (count === 0) {
      return;
    }
    const places = this.horizontal ? frame.y : frame.x;
    const values = this.horizontal ? frame.x : frame.y;
    const step = this.step();
    const pixelsPerPlace = Math.abs(places.toPixel(step) - places.toPixel(0));
    const { lower, upper } = this.readEnds();
    // Only the places that are visible, by the even spacing of the places.
    const bounds = frame.bounds;
    const a = places.toData(this.horizontal ? bounds.y : bounds.x);
    const b = places.toData(this.horizontal ? bounds.y + bounds.height : bounds.x + bounds.width);
    const clamp = (value: number): number => Math.min(Math.max(value, 0), count - 1);
    const first = clamp(Math.trunc(Math.floor((Math.min(a, b) - this.position(0)) / step - 1)));
    const last = clamp(Math.trunc(Math.ceil((Math.max(a, b) - this.position(0)) / step + 1)));
    if (pixelsPerPlace < 1) {
      this.buildMerged(frame, places, values, lower, upper, first, last);
      return;
    }
    const isGrouped = this.barLayout === 'grouped';
    const width = pixelsPerPlace * this.share;
    const slotWidth = width / (isGrouped ? this.rowValues.length : 1);
    for (let i = first; i <= last; i++) {
      const center = places.toPixel(this.position(i));
      for (let row = 0; row < this.rowValues.length; row++) {
        const high = (upper[row] as Float64Array)[i] as number;
        if (Number.isFinite(high)) {
          const start = roundHalfEven(center - width / 2 + (isGrouped ? row * slotWidth : 0));
          const end = roundHalfEven(center - width / 2 + (isGrouped ? row + 1 : 1) * slotWidth);
          const from = roundHalfEven(values.toPixel((lower[row] as Float64Array)[i] as number));
          const to = roundHalfEven(values.toPixel(high));
          this.addBar(frame, row, start, end, from, to, pixelsPerPlace, high);
        }
      }
    }
  }

  private addBar(
    frame: SeriesFrame,
    row: number,
    start: number,
    end: number,
    from: number,
    to: number,
    pixelsPerPlace: number,
    value: number,
  ): void {
    const radius = f(this.radius * frame.dpiScale);
    const blur = f(this.blur * frame.dpiScale);
    const [x, y, width, height] = this.horizontal
      ? [f(Math.min(from, to)), f(start), f(Math.abs(to - from)), f(end - start)]
      : [f(start), f(Math.min(from, to)), f(end - start), f(Math.abs(to - from))];
    if (this.shadow && pixelsPerPlace >= 3) {
      addSoftRectangle(this.mesh, f(x + f(blur / 3)), f(y + f(blur / 3)), width, height, blur, this.shadow);
    }
    addRoundedRectangle(this.mesh, x, y, width, height, radius, frame.bounds, this.rowFills[row] as SeriesFill, value);
  }

  // One bar per pixel and row, from the lowest to the highest end in that pixel.
  private buildMerged(
    frame: SeriesFrame,
    places: LinearAxisTransform,
    values: LinearAxisTransform,
    lower: Float64Array[],
    upper: Float64Array[],
    first: number,
    last: number,
  ): void {
    const origin = this.horizontal ? frame.bounds.y : frame.bounds.x;
    const length = Math.trunc(this.horizontal ? frame.bounds.height : frame.bounds.width);
    if (length <= 0) {
      return;
    }
    const low = new Float64Array(length);
    const high = new Float64Array(length);
    for (let row = 0; row < this.rowValues.length; row++) {
      low.fill(Number.POSITIVE_INFINITY);
      high.fill(Number.NEGATIVE_INFINITY);
      const lows = lower[row] as Float64Array;
      const highs = upper[row] as Float64Array;
      for (let i = first; i <= last; i++) {
        const column = Math.trunc(places.toPixel(this.position(i)) - origin);
        const top = highs[i] as number;
        if (column >= 0 && column < length && Number.isFinite(top)) {
          const bottom = lows[i] as number;
          low[column] = Math.min(low[column] as number, Math.min(bottom, top));
          high[column] = Math.max(high[column] as number, Math.max(bottom, top));
        }
      }
      for (let column = 0; column < length; column++) {
        const smallest = low[column] as number;
        const largest = high[column] as number;
        if (smallest > largest) {
          continue;
        }
        const from = f(roundHalfEven(values.toPixel(smallest)));
        const to = f(roundHalfEven(values.toPixel(largest)));
        const start = f(origin + column);
        const size = Math.max(Math.abs(f(to - from)), 1);
        const [x, y, width, height] = this.horizontal
          ? [Math.min(from, to), start, size, 1]
          : [start, Math.min(from, to), 1, size];
        addRoundedRectangle(this.mesh, x, y, width, height, 0, frame.bounds, this.rowFills[row] as SeriesFill, largest);
      }
    }
  }
}

function colorAt(fill: SeriesFill, y: number, pane: PixelRect, value: number): number {
  return packRgba8(fill.colorAt(f(f(y - pane.y) / pane.height), value));
}

/** A rectangle with round corners as a fan of triangles around its middle; square corners below half a pixel. */
export function addRoundedRectangle(
  mesh: Mesh,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  pane: PixelRect,
  fill: SeriesFill,
  value: number,
): void {
  const limited = Math.min(radius, f(Math.min(width, height) / 2));
  const right = f(x + width);
  const bottom = f(y + height);
  if (limited < 0.5) {
    const [top, low] = [colorAt(fill, y, pane, value), colorAt(fill, bottom, pane, value)];
    mesh.add(x, y, top);
    mesh.add(right, y, top);
    mesh.add(right, bottom, low);
    mesh.add(x, y, top);
    mesh.add(right, bottom, low);
    mesh.add(x, bottom, low);
    return;
  }
  const centerX = f(x + f(width / 2));
  const centerY = f(y + f(height / 2));
  const center = colorAt(fill, centerY, pane, value);
  let previousX = 0;
  let previousY = 0;
  let previousColor = 0;
  let firstX = 0;
  let firstY = 0;
  let firstColor = 0;
  let hasPrevious = false;
  for (let corner = 0; corner < 4; corner++) {
    const cornerX = corner === 1 || corner === 2 ? f(right - limited) : f(x + limited);
    const cornerY = corner === 2 || corner === 3 ? f(bottom - limited) : f(y + limited);
    for (let step = 0; step <= cornerSegments; step++) {
      const angle = f(f(f(f(Math.PI) * (corner + 2)) / 2) + f(f(f(step * f(Math.PI)) / 2) / cornerSegments));
      const vx = f(cornerX + f(f(Math.cos(angle)) * limited));
      const vy = f(cornerY + f(f(Math.sin(angle)) * limited));
      const color = colorAt(fill, vy, pane, value);
      if (hasPrevious) {
        mesh.add(centerX, centerY, center);
        mesh.add(previousX, previousY, previousColor);
        mesh.add(vx, vy, color);
      } else {
        [firstX, firstY, firstColor] = [vx, vy, color];
        hasPrevious = true;
      }
      [previousX, previousY, previousColor] = [vx, vy, color];
    }
  }
  mesh.add(centerX, centerY, center);
  mesh.add(previousX, previousY, previousColor);
  mesh.add(firstX, firstY, firstColor);
}

/** A rectangle with edges that fade to nothing over `blur` pixels, for shadows. */
export function addSoftRectangle(
  mesh: Mesh,
  x: number,
  y: number,
  width: number,
  height: number,
  blur: number,
  color: Rgba8,
): void {
  const inner = packRgba8(color);
  const outer = packRgba8({ ...color, a: 0 });
  const right = f(x + width);
  const bottom = f(y + height);
  const [up, down, left, beyond] = [f(y - blur), f(bottom + blur), f(x - blur), f(right + blur)];
  const quad = (points: [number, number, number][]): void => {
    for (const index of [0, 1, 2, 0, 2, 3]) {
      const [px, py, pc] = points[index] as [number, number, number];
      mesh.add(px, py, pc);
    }
  };
  quad([
    [x, y, inner],
    [right, y, inner],
    [right, bottom, inner],
    [x, bottom, inner],
  ]);
  quad([
    [x, up, outer],
    [right, up, outer],
    [right, y, inner],
    [x, y, inner],
  ]);
  quad([
    [x, bottom, inner],
    [right, bottom, inner],
    [right, down, outer],
    [x, down, outer],
  ]);
  quad([
    [left, y, outer],
    [x, y, inner],
    [x, bottom, inner],
    [left, bottom, outer],
  ]);
  quad([
    [right, y, inner],
    [beyond, y, outer],
    [beyond, bottom, outer],
    [right, bottom, inner],
  ]);
  const corner = (cx: number, cy: number, sx: number, sy: number, ex: number, ey: number): void => {
    mesh.add(cx, cy, inner);
    mesh.add(sx, sy, outer);
    mesh.add(ex, ey, outer);
  };
  corner(x, y, left, y, x, up);
  corner(right, y, right, up, beyond, y);
  corner(right, bottom, beyond, bottom, right, down);
  corner(x, bottom, x, down, left, bottom);
}
