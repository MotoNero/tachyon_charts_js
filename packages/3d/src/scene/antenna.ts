// The gain of an antenna over azimuth and elevation as a shape around the center, as AntennaPattern3D of the .NET
// version: the distance from the center is the gain in dB above the floor, and the axes count in the same dB.
import { Colormap, formatFixed, invariantCulture, type Rgba8 } from '@tachyon-charts/core';
import { Point3D } from './matrix';
import { Mesh3D, type Vertex3D } from './mesh';
import type { Material3D } from './surface';

const tolerance = 1e-6;
const fullCircle = 360;
const pole = 90;
const halfPower = 3;
const markReach = 1.15;
const ringLift = 1.02;
const ringSteps = 48;
const none: Rgba8 = { r: 0, g: 0, b: 0, a: 0 };

/** The main lobe of an antenna: its direction in degrees, its gain in dB and its widths at half power in degrees. */
export interface AntennaLobe {
  /** The azimuth of the peak. */
  readonly azimuth: number;
  /** The elevation of the peak. */
  readonly elevation: number;
  /** The gain of the peak. */
  readonly gain: number;
  /** The width around the azimuth where the gain is at most 3 dB below the peak. */
  readonly azimuthWidth: number;
  /** The width along the elevation where the gain is at most 3 dB below the peak. */
  readonly elevationWidth: number;
}

/** A cut through a pattern: angles in degrees and gains above the floor, ready for a polar chart. */
export interface AntennaCut {
  /** The angles. */
  readonly angles: number[];
  /** The gains above the floor. */
  readonly values: number[];
}

/** The options of an antenna pattern. */
export interface AntennaPattern3DOptions {
  /** The colors from the floor to the peak; Viridis by default. */
  readonly colormap?: Colormap;
  /** How the shape takes the light. */
  readonly material?: Material3D;
  /** How many dB below the peak the floor lies; 40 by default. Weaker directions shrink to the center. */
  readonly dynamicRange?: number;
}

function toPoint(azimuth: number, elevation: number, radius: number): Point3D {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return new Point3D(radius * Math.cos(e) * Math.cos(a), radius * Math.cos(e) * Math.sin(a), radius * Math.sin(e));
}

function toTurn(angle: number): number {
  return ((angle % fullCircle) + fullCircle) % fullCircle;
}

// How far from the peak the values fall below a level, between two measured angles.
function side(
  angles: readonly number[],
  values: readonly number[],
  peak: number,
  direction: number,
  isRound: boolean,
  level: number,
): number {
  let index = peak;
  let reach = 0;
  for (let i = 1; i < angles.length; i++) {
    let next = index + direction;
    if (isRound) {
      next = (next + angles.length) % angles.length;
    } else if (next < 0 || next >= angles.length) {
      return Number.NaN;
    }
    const step = toTurn(direction * ((angles[next] as number) - (angles[index] as number)));
    const here = values[index] as number;
    const there = values[next] as number;
    if (there < level) {
      return reach + (step * (here - level)) / (here - there);
    }
    index = next;
    reach += step;
  }
  return Number.NaN;
}

function findNearest(angles: readonly number[], count: number, angle: number, isRound: boolean): number {
  let best = Infinity;
  let found = 0;
  for (let i = 0; i < count; i++) {
    let distance = Math.abs((angles[i] as number) - angle);
    distance = isRound ? Math.abs(((distance + fullCircle / 2) % fullCircle) - fullCircle / 2) : distance;
    if (distance < best) {
      best = distance;
      found = i;
    }
  }
  return found;
}

/**
 * The gain of an antenna over azimuth and elevation as a shape around the center: the distance from the center is the
 * gain in dB above the floor, and the axes count in the same dB.
 */
export class AntennaPattern3D {
  /** The azimuths in degrees. */
  readonly azimuths: readonly number[];
  /** The elevations in degrees. */
  readonly elevations: readonly number[];
  /** The gains in dB, a row per elevation with a value per azimuth. */
  readonly gains: readonly (readonly number[])[];
  /** The colors from the floor to the peak. */
  readonly colormap: Colormap;
  /** How the shape takes the light. */
  readonly material: Material3D;
  /** How many dB below the peak the floor lies. */
  readonly dynamicRange: number;
  /** The shape does not change. */
  readonly version = 0;
  private readonly columns: number;
  private readonly isRound: boolean;
  private lobe: AntennaLobe | undefined;

  /**
   * @param azimuths - The azimuths in degrees; a full circle closes over the seam.
   * @param elevations - The elevations in degrees, from -90 to 90 at most.
   * @param gains - A row per elevation with a gain in dB per azimuth.
   * @param options - Colors, material and dynamic range.
   * @throws RangeError when the gains do not have a row per elevation and a column per azimuth.
   */
  constructor(
    azimuths: readonly number[],
    elevations: readonly number[],
    gains: readonly (readonly number[])[],
    options: AntennaPattern3DOptions = {},
  ) {
    if (gains.length !== elevations.length || gains.some((row) => row.length !== azimuths.length)) {
      throw new RangeError('The gains need one row per elevation and one column per azimuth.');
    }
    this.azimuths = [...azimuths];
    this.elevations = [...elevations];
    this.gains = gains.map((row) => [...row]);
    this.colormap = options.colormap ?? Colormap.builtIn('viridis');
    this.material = options.material ?? {};
    this.dynamicRange = options.dynamicRange ?? 40;
    let columns = azimuths.length;
    let isRound = false;
    if (azimuths.length >= 2) {
      const span = (azimuths[azimuths.length - 1] as number) - (azimuths[0] as number);
      isRound = span + span / (azimuths.length - 1) >= fullCircle - tolerance;
      columns -= span >= fullCircle - tolerance ? 1 : 0;
    }
    this.columns = columns;
    this.isRound = isRound;
  }

  /** The gain at the center of the shape in dB. */
  get floor(): number {
    return this.mainLobe.gain - this.dynamicRange;
  }

  /** The main lobe. */
  get mainLobe(): AntennaLobe {
    this.lobe ??= this.findLobe();
    return this.lobe;
  }

  /** @internal The distance from the center that the axes need to reach. */
  get reach(): number {
    return Number.isFinite(this.mainLobe.gain) ? this.dynamicRange * markReach * ringLift : 1;
  }

  /** @internal The end of the mark over the peak. */
  get markTip(): Point3D {
    const lobe = this.mainLobe;
    return toPoint(lobe.azimuth, lobe.elevation, this.dynamicRange * markReach);
  }

  /** @internal The text at the mark. */
  get lobeText(): string {
    const lobe = this.mainLobe;
    const one = (value: number): string => formatFixed(value, 1, invariantCulture);
    return `${one(lobe.gain)} dB, ${one(lobe.azimuthWidth)}° × ${one(lobe.elevationWidth)}°`;
  }

  /** @internal The top of the scale. */
  get peakText(): string {
    return `${upToOne(this.mainLobe.gain)} dB`;
  }

  /** @internal The bottom of the scale. */
  get floorText(): string {
    return `${upToOne(this.floor)} dB`;
  }

  /** The cut at one elevation, around the azimuth. */
  azimuthCut(elevation: number): AntennaCut {
    const row = this.gains[findNearest(this.elevations, this.elevations.length, elevation, false)] as readonly number[];
    const count = this.columns + (this.isRound ? 1 : 0);
    const angles: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const column = i % this.columns;
      angles.push(toTurn(this.azimuths[column] as number));
      values.push(this.aboveFloor(row[column] as number));
    }
    return { angles, values };
  }

  /** The great circle through one azimuth and the two poles. */
  elevationCut(azimuth: number): AntennaCut {
    const front = findNearest(this.azimuths, this.columns, azimuth, true);
    const back = findNearest(this.azimuths, this.columns, azimuth + fullCircle / 2, true);
    const rows = this.elevations.length;
    const angles = new Array<number>(2 * rows);
    const values = new Array<number>(2 * rows);
    for (let i = 0; i < rows; i++) {
      angles[i] = toTurn(this.elevations[i] as number);
      values[i] = this.aboveFloor(this.gain(i, front));
      const turned = rows - 1 - i;
      angles[rows + i] = toTurn(fullCircle / 2 - (this.elevations[turned] as number));
      values[rows + i] = this.aboveFloor(this.gain(turned, back));
    }
    return { angles, values };
  }

  /**
   * @internal Creates the shape. Each pole is one point with the mean of its ring, so that it can neither form a
   * needle nor a hole, and the shape closes over the seam of the azimuth.
   */
  createMesh(): Mesh3D {
    const elevations = this.elevations;
    if (this.columns < 2 || elevations.length < 2 || !Number.isFinite(this.mainLobe.gain)) {
      return new Mesh3D([], [], { material: this.material });
    }
    const first = this.isRound && (elevations[0] as number) <= -pole + tolerance ? 1 : 0;
    const last =
      elevations.length - (this.isRound && (elevations[elevations.length - 1] as number) >= pole - tolerance ? 2 : 1);
    const rows = last - first + 1;
    const vertices: Vertex3D[] = [];
    const indices: number[] = [];
    for (let row = first; row <= last; row++) {
      for (let column = 0; column < this.columns; column++) {
        vertices.push(
          this.createVertex(this.azimuths[column] as number, elevations[row] as number, this.gain(row, column)),
        );
      }
    }
    const columns = this.columns;
    const seam = columns - (this.isRound ? 0 : 1);
    for (let row = 0; row < rows - 1; row++) {
      for (let column = 0; column < seam; column++) {
        const a = row * columns + column;
        const b = row * columns + ((column + 1) % columns);
        indices.push(a, b, b + columns, a, b + columns, a + columns);
      }
    }
    if (this.isRound) {
      this.addCap(vertices, indices, 0, -pole, 0);
      this.addCap(vertices, indices, rows - 1, pole, elevations.length - 1);
    }
    return new Mesh3D(vertices, indices, { material: this.material });
  }

  /** @internal Adds the mark over the peak and the ring through the half-power points, each as pairs of line ends. */
  addMarks(ends: Point3D[]): void {
    const lobe = this.mainLobe;
    if (!Number.isFinite(lobe.gain)) {
      return;
    }
    ends.push(toPoint(lobe.azimuth, lobe.elevation, this.dynamicRange), this.markTip);
    if (!Number.isFinite(lobe.azimuthWidth) || !Number.isFinite(lobe.elevationWidth)) {
      return;
    }
    const radius = (this.dynamicRange - halfPower) * ringLift;
    const ringPoint = (step: number): Point3D => {
      const turn = (2 * Math.PI * step) / ringSteps;
      return toPoint(
        lobe.azimuth + (lobe.azimuthWidth / 2) * Math.cos(turn),
        lobe.elevation + (lobe.elevationWidth / 2) * Math.sin(turn),
        radius,
      );
    };
    for (let i = 0; i < ringSteps; i++) {
      ends.push(ringPoint(i), ringPoint(i + 1));
    }
  }

  private gain(row: number, column: number): number {
    return (this.gains[row] as readonly number[])[column] as number;
  }

  private aboveFloor(gain: number): number {
    return Number.isNaN(gain) ? Number.NaN : Math.max(gain - this.floor, 0);
  }

  private createVertex(azimuth: number, elevation: number, gain: number): Vertex3D {
    const radius = gain === Infinity ? Number.NaN : this.aboveFloor(gain);
    const color = Number.isNaN(radius) ? none : this.colormap.sample(radius / this.dynamicRange);
    return { position: toPoint(azimuth, elevation, radius), color };
  }

  // The first and last row are the ring of the pole itself when measured, otherwise the outermost measured ring.
  private addCap(vertices: Vertex3D[], indices: number[], ring: number, at: number, row: number): void {
    let sum = 0;
    let count = 0;
    for (let column = 0; column < this.columns; column++) {
      const gain = this.gain(row, column);
      if (Number.isFinite(gain)) {
        sum += gain;
        count++;
      }
    }
    const tip = vertices.length;
    vertices.push(this.createVertex(0, at, count > 0 ? sum / count : Number.NaN));
    const columns = this.columns;
    for (let column = 0; column < columns; column++) {
      const a = ring * columns + column;
      const b = ring * columns + ((column + 1) % columns);
      if (at > 0) {
        indices.push(a, b, tip);
      } else {
        indices.push(tip, b, a);
      }
    }
  }

  private findLobe(): AntennaLobe {
    let best = -Infinity;
    let bestRow = -1;
    let bestColumn = -1;
    for (let row = 0; row < this.elevations.length; row++) {
      for (let column = 0; column < this.columns; column++) {
        const gain = this.gain(row, column);
        if (Number.isFinite(gain) && gain > best) {
          best = gain;
          bestRow = row;
          bestColumn = column;
        }
      }
    }
    if (bestRow < 0) {
      return { azimuth: NaN, elevation: NaN, gain: NaN, azimuthWidth: NaN, elevationWidth: NaN };
    }
    const across = (this.gains[bestRow] as readonly number[]).slice(0, this.columns);
    const along = this.elevations.map((_, row) => this.gain(row, bestColumn));
    const level = best - halfPower;
    const azimuths = this.azimuths.slice(0, this.columns);
    return {
      azimuth: this.azimuths[bestColumn] as number,
      elevation: this.elevations[bestRow] as number,
      gain: best,
      azimuthWidth:
        side(azimuths, across, bestColumn, 1, this.isRound, level) +
        side(azimuths, across, bestColumn, -1, this.isRound, level),
      elevationWidth:
        side(this.elevations, along, bestRow, 1, false, level) +
        side(this.elevations, along, bestRow, -1, false, level),
    };
  }
}

// "0.#": at most one decimal.
function upToOne(value: number): string {
  return formatFixed(value, 1, invariantCulture).replace(/\.0$/, '');
}
