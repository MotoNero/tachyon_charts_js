// A pie or donut chart as a lit body, as Pie3D of the .NET version.
import { chartText, formatFixed, formatGeneral, type PieLabels, type Rgba8 } from '@tachyon-charts/core';
import { Point3D } from './matrix';
import { Mesh3D, type Vertex3D } from './mesh';
import type { Material3D } from './surface';

const stepsPerTurn = 180;
const turn = 2 * Math.PI;
const defaultPalette: readonly Rgba8[] = [
  { r: 76, g: 201, b: 240, a: 255 },
  { r: 247, g: 37, b: 133, a: 255 },
  { r: 255, g: 190, b: 11, a: 255 },
  { r: 114, g: 9, b: 183, a: 255 },
  { r: 58, g: 134, b: 255, a: 255 },
  { r: 6, g: 214, b: 160, a: 255 },
  { r: 251, g: 86, b: 7, a: 255 },
  { r: 131, g: 56, b: 236, a: 255 },
];

/** The options of a pie in 3D. */
export interface Pie3DOptions {
  /** The names of the slices; by default their numbers from 1. */
  readonly names?: readonly string[];
  /** The radius of the hole as a share of the radius, from 0 for a pie to 0.9 for a thin ring; 0 by default. */
  readonly innerRadius?: number;
  /** The height of the body in units of the radius; 0.3 by default. */
  readonly height?: number;
  /** How far a slice moves out when it is pulled out, in units of the radius; 0.15 by default. */
  readonly explodeDistance?: number;
  /** The gap between the slices in units of the radius; 0.012 by default. */
  readonly gap?: number;
  /** The colors of the slices; by default the palette of the theme. */
  readonly colors?: readonly Rgba8[];
  /** What the label on each slice shows, as on a pie in 2D; name and percent by default. */
  readonly labels?: PieLabels;
  /** How the slices take the light. */
  readonly material?: Material3D;
  /** The number of the slice that is pulled out, or -1 for none (the default). */
  readonly explodedIndex?: number;
}

function counts(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

type Ring = readonly [radius: number, z: number];

/**
 * A pie or donut chart as a lit body: each value is a slice, clockwise from the top. Zero, negative and missing values
 * get no slice and do not count. The pie lies in the middle of the box with a radius of 1 in units of the axes;
 * `Chart3DBuilder.addPie` sets the axes and hides them.
 */
export class Pie3D {
  /** The values. */
  readonly values: readonly number[];
  /** The names. */
  readonly names: readonly string[];
  /** The sum of all values that get a slice. */
  readonly total: number;
  /** The radius of the hole as a share of the radius. */
  readonly innerRadius: number;
  /** The height of the body in units of the radius. */
  readonly height: number;
  /** How far a slice moves out when it is pulled out. */
  readonly explodeDistance: number;
  /** The gap between the slices. */
  readonly gap: number;
  /** The colors of the slices, or undefined for the palette of the theme. */
  readonly colors: readonly Rgba8[] | undefined;
  /** What the label on each slice shows. */
  readonly labels: PieLabels;
  /** How the slices take the light. */
  readonly material: Material3D;
  private readonly vertices: (Vertex3D[] | undefined)[];
  private readonly sliceMeshes: (Mesh3D | undefined)[];
  private exploded = -1;
  private changes = 0;

  /**
   * @param values - A value per slice.
   * @param options - Names, shape, colors, labels and the slice pulled out.
   * @throws RangeError for another number of names than values, or a slice pulled out that does not exist.
   */
  constructor(values: readonly number[], options: Pie3DOptions = {}) {
    const names = options.names;
    if (names && names.length !== values.length) {
      throw new RangeError(`There are ${String(names.length)} names for ${String(values.length)} values.`);
    }
    this.values = [...values];
    this.names = names ? [...names] : values.map((_, i) => String(i + 1));
    this.total = this.values.reduce((sum, value) => sum + (counts(value) ? value : 0), 0);
    this.innerRadius = Math.min(Math.max(options.innerRadius ?? 0, 0), 0.9);
    this.height = options.height ?? 0.3;
    this.explodeDistance = options.explodeDistance ?? 0.15;
    this.gap = options.gap ?? 0.012;
    this.colors = options.colors;
    this.labels = options.labels ?? 'nameAndPercent';
    this.material = options.material ?? { gloss: 0.25, sharpness: 32 };
    this.vertices = values.map(() => undefined);
    this.sliceMeshes = values.map(() => undefined);
    if (options.explodedIndex !== undefined) {
      this.explodedIndex = options.explodedIndex;
    }
  }

  /**
   * The number of the slice that is pulled out, or -1 for none.
   * @throws RangeError when set to a slice that does not exist.
   */
  get explodedIndex(): number {
    return this.exploded;
  }

  set explodedIndex(value: number) {
    if (!Number.isInteger(value) || value < -1 || value >= this.values.length) {
      throw new RangeError(`There is no slice ${String(value)}.`);
    }
    if (value !== this.exploded) {
      this.exploded = value;
      this.changes++;
    }
  }

  /** Grows when the look changes. */
  get version(): number {
    return this.changes;
  }

  /** @internal The surface of each slice, undefined for a value without one; the layout fills them. */
  get meshes(): readonly (Mesh3D | undefined)[] {
    return this.sliceMeshes;
  }

  /** The share of a slice in the whole, from 0 to 1. */
  share(index: number): number {
    const value = this.values[index] ?? Number.NaN;
    return counts(value) && this.total > 0 ? value / this.total : 0;
  }

  /** @internal Places the corners of all slices. The surfaces stay the same objects, only their corners move. */
  layout(palette: readonly Rgba8[]): void {
    const colors = palette.length > 0 ? palette : defaultPalette;
    let start = 0;
    for (let i = 0; i < this.values.length; i++) {
      const value = this.values[i] as number;
      if (!counts(value)) {
        continue;
      }
      const sweep = (value / this.total) * turn;
      const own = this.colors;
      const color = (own && own.length > 0 ? own[i % own.length] : colors[i % colors.length]) as Rgba8;
      const steps = Math.max(2, Math.ceil((sweep / turn) * stepsPerTurn));
      const from = Math.PI / 2 - start;
      const shift = this.direction(from - sweep / 2).times(
        this.lift(sweep) + (i === this.exploded ? this.explodeDistance : 0),
      );
      const corners: Vertex3D[] = [];
      const known = this.vertices[i];
      const triangles: number[] | undefined = known ? undefined : [];
      this.build(corners, triangles, from, from - sweep, steps, shift, color);
      if (!known) {
        this.vertices[i] = corners;
        this.sliceMeshes[i] = new Mesh3D(corners, triangles as number[], { material: this.material });
      } else {
        corners.forEach((corner, k) => {
          known[k] = corner;
        });
      }
      start += sweep;
    }
  }

  /** @internal The place of the label of a slice: the middle of its top, in data units, moved with the slice. */
  labelPoint(index: number): Point3D | undefined {
    return this.topPoint(index, this.innerRadius > 0 ? (this.innerRadius + 1) / 2 : 0.62);
  }

  /** @internal A point on the top of a slice along its middle, in data units, moved with the slice. */
  topPoint(index: number, radius: number): Point3D | undefined {
    if (!counts(this.values[index] ?? Number.NaN) || this.total <= 0) {
      return undefined;
    }
    let start = 0;
    for (let i = 0; i < index; i++) {
      const value = this.values[i] as number;
      start += counts(value) ? (value / this.total) * turn : 0;
    }
    const sweep = ((this.values[index] as number) / this.total) * turn;
    const place = this.direction(Math.PI / 2 - start - sweep / 2).times(
      radius + this.lift(sweep) + (index === this.exploded ? this.explodeDistance : 0),
    );
    return new Point3D(place.x, place.y, this.height / 2);
  }

  /** @internal The label of a slice as `labels` asks. */
  labelText(index: number): string {
    const share = this.share(index);
    const culture = chartText.culture;
    const value = share * 100;
    const percent =
      (share < 0.1
        ? formatFixed(value, 1, culture).replace(new RegExp(`\\${culture.decimalSeparator}0$`), '')
        : formatFixed(value, 0, culture)) + ' %';
    const name = this.names[index] ?? '';
    switch (this.labels) {
      case 'none':
        return '';
      case 'name':
        return name;
      case 'percent':
        return percent;
      case 'value':
        return formatGeneral(this.values[index] as number, 4, culture);
      default:
        return name.length === 0 ? percent : `${name} ${percent}`;
    }
  }

  private direction(angle: number): Point3D {
    return new Point3D(Math.cos(angle), Math.sin(angle), 0);
  }

  // Moving a slice along its middle by d opens a gap of d · sin(sweep / 2) at each cut.
  private lift(sweep: number): number {
    return sweep >= turn - 1e-9
      ? 0
      : Math.min(this.gap / 2 / Math.max(Math.sin(Math.min(sweep, Math.PI) / 2), 1e-3), 0.05);
  }

  // Top, bottom and sides are bands between two rings, each with corners of its own, so that the edges stay sharp in
  // the light. A pie has its inner ring in the middle; a donut adds the inner side.
  private build(
    corners: Vertex3D[],
    triangles: number[] | undefined,
    from: number,
    to: number,
    steps: number,
    shift: Point3D,
    color: Rgba8,
  ): void {
    const top = this.height / 2;
    const bottom = -this.height / 2;
    const inner = this.innerRadius;
    const band = (
      a: number,
      b: number,
      n: number,
      first: Ring,
      firstEnd: Ring,
      second: Ring,
      secondEnd: Ring,
    ): void => {
      addBand(corners, triangles, a, b, n, shift, color, first, firstEnd, second, secondEnd);
    };
    band(from, to, steps, [inner, top], [inner, top], [1, top], [1, top]);
    band(from, to, steps, [1, bottom], [1, bottom], [inner, bottom], [inner, bottom]);
    band(from, to, steps, [1, top], [1, top], [1, bottom], [1, bottom]);
    if (inner > 0) {
      band(from, to, steps, [inner, bottom], [inner, bottom], [inner, top], [inner, top]);
    }
    band(from, from, 1, [inner, top], [inner, bottom], [1, top], [1, bottom]);
    band(to, to, 1, [inner, top], [inner, bottom], [1, top], [1, bottom]);
  }
}

// Two rings of steps + 1 corners, from the angle 'from' to 'to'; a ring may change its radius and height along the way,
// which is what turns a band into a cut face.
function addBand(
  corners: Vertex3D[],
  triangles: number[] | undefined,
  from: number,
  to: number,
  steps: number,
  shift: Point3D,
  color: Rgba8,
  firstStart: Ring,
  firstEnd: Ring,
  secondStart: Ring,
  secondEnd: Ring,
): void {
  const at = corners.length;
  for (const [begin, end] of [
    [firstStart, firstEnd],
    [secondStart, secondEnd],
  ] as const) {
    for (let s = 0; s <= steps; s++) {
      const share = s / steps;
      const angle = from + (to - from) * share;
      const radius = begin[0] + (end[0] - begin[0]) * share;
      const z = begin[1] + (end[1] - begin[1]) * share;
      corners.push({
        position: new Point3D(radius * Math.cos(angle), radius * Math.sin(angle), z).plus(shift),
        color,
      });
    }
  }
  if (!triangles) {
    return;
  }
  const ring = steps + 1;
  for (let s = 0; s < steps; s++) {
    triangles.push(at + s, at + s + 1, at + ring + s + 1, at + s, at + ring + s + 1, at + ring + s);
  }
}
