// Impedances on a Smith chart, as SmithMath, SmithProjection and SmithSeries of the .NET version: an impedance is shown
// at its reflection coefficient, relative to the reference impedance, inside the unit circle.
import type { Axis } from '../axes/axis';
import { DoubleRange } from '../numerics/range';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import { lineGap, type CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuBuffer } from '../render/resources';
import { BufferUsage, type Rgba8 } from '../render/types';

const f = Math.fround;
const outerShare = 0.9;

/** A complex number. */
export interface Complex {
  /** The real part. */
  readonly re: number;
  /** The imaginary part. */
  readonly im: number;
}

/** The usual reference impedance in ohms. */
export const defaultReferenceImpedance = 50;

/** The reflection coefficient of a normalized impedance; 1 for an infinite impedance. */
export function toReflection(impedance: Complex): Complex {
  const { re, im } = impedance;
  const dr = re + 1;
  if (!Number.isFinite(re) || !Number.isFinite(im) || (dr === 0 && im === 0)) {
    return { re: 1, im: 0 };
  }
  // (z - 1) / (z + 1)
  const scale = dr * dr + im * im;
  return { re: ((re - 1) * dr + im * im) / scale, im: (im * dr - (re - 1) * im) / scale };
}

/** The normalized impedance of a reflection coefficient; infinite at 1. */
export function toImpedance(reflection: Complex): Complex {
  const dr = 1 - reflection.re;
  const di = -reflection.im;
  if (dr === 0 && di === 0) {
    return { re: Number.POSITIVE_INFINITY, im: 0 };
  }
  // (1 + r) / (1 - r)
  const nr = 1 + reflection.re;
  const ni = reflection.im;
  const scale = dr * dr + di * di;
  return { re: (nr * dr + ni * di) / scale, im: (ni * dr - nr * di) / scale };
}

/** The standing wave ratio of a reflection coefficient; infinite from a magnitude of 1 on. */
export function toStandingWaveRatio(reflection: Complex): number {
  const size = Math.hypot(reflection.re, reflection.im);
  return size >= 1 ? Number.POSITIVE_INFINITY : (1 + size) / (1 - size);
}

/** Maps reflection coefficients to a pane: the unit circle centered, at 90 % of the shorter side. */
export class SmithProjection {
  /**
   * @param centerX - The middle, horizontally.
   * @param centerY - The middle, vertically.
   * @param radius - The radius of the unit circle.
   */
  constructor(
    /** The middle, horizontally. */
    readonly centerX: number,
    /** The middle, vertically. */
    readonly centerY: number,
    /** The radius of the unit circle. */
    readonly radius: number,
  ) {}

  /** The projection of an area. */
  static fit(x: number, y: number, width: number, height: number): SmithProjection {
    return new SmithProjection(x + width / 2, y + height / 2, (Math.min(width, height) / 2) * outerShare);
  }

  /** The point of a reflection coefficient. */
  toPoint(reflection: Complex): { x: number; y: number } {
    return { x: f(this.centerX + reflection.re * this.radius), y: f(this.centerY - reflection.im * this.radius) };
  }
}

/** A curve of impedances, given by resistance and reactance in ohms, on a Smith chart. */
export class SmithSeries extends ChartSeries {
  private readonly resistance: Float64Array;
  private readonly reactance: Float64Array;
  private points = new Float32Array(0);
  private buffer: GpuBuffer | undefined;
  private stroke: Rgba8 = { r: 240, g: 200, b: 60, a: 255 };
  private width = 1.5;
  private changes = 0;
  private builtVersion = -1;
  private builtFrame: SeriesFrame | undefined;

  /**
   * @param resistance - The resistances in ohms.
   * @param reactance - The reactances in ohms, one per resistance.
   * @param xAxis - The hidden X axis.
   * @param yAxis - The hidden Y axis.
   * @param referenceImpedance - The reference impedance in ohms; 50 by default.
   * @throws RangeError when the numbers differ or the reference is not positive.
   */
  constructor(
    resistance: ArrayLike<number>,
    reactance: ArrayLike<number>,
    xAxis: Axis,
    yAxis: Axis,
    /** The reference impedance in ohms. */
    readonly referenceImpedance = defaultReferenceImpedance,
  ) {
    super(xAxis, yAxis);
    if (!(referenceImpedance > 0)) {
      throw new RangeError('The reference impedance must be positive.');
    }
    if (resistance.length !== reactance.length) {
      throw new RangeError('Each resistance needs a reactance.');
    }
    this.resistance = Float64Array.from(resistance);
    this.reactance = Float64Array.from(reactance);
  }

  /** The number of points. */
  get count(): number {
    return this.resistance.length;
  }

  /** The color of the curve. */
  get color(): Rgba8 {
    return this.stroke;
  }

  set color(value: Rgba8) {
    this.stroke = value;
    this.changes++;
  }

  /** The thickness of the curve in device-independent units; 1.5 by default. */
  get thickness(): number {
    return this.width;
  }

  set thickness(value: number) {
    if (!(value > 0)) {
      throw new RangeError('The thickness must be positive.');
    }
    this.width = value;
    this.changes++;
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.stroke;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.changes;
  }

  /** The impedance of a point in ohms. */
  impedance(index: number): Complex {
    return { re: this.resistance[index] ?? Number.NaN, im: this.reactance[index] ?? Number.NaN };
  }

  /** The reflection coefficient of a point. */
  reflection(index: number): Complex {
    const impedance = this.impedance(index);
    return toReflection({ re: impedance.re / this.referenceImpedance, im: impedance.im / this.referenceImpedance });
  }

  /** Draws the curve anew after the values changed. */
  invalidate(): void {
    this.changes++;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(): DoubleRange | undefined {
    // The axes stay at -1 to 1 and do not follow the values.
    return undefined;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    if (this.builtVersion === this.changes && this.builtFrame === frame) {
      return;
    }
    const bounds = frame.bounds;
    const projection = SmithProjection.fit(bounds.x, bounds.y, bounds.width, bounds.height);
    const count = this.resistance.length;
    if (this.points.length !== count * 2) {
      this.points = new Float32Array(count * 2);
    }
    for (let i = 0; i < count; i++) {
      const resistance = this.resistance[i] as number;
      const reactance = this.reactance[i] as number;
      if (Number.isFinite(resistance) && Number.isFinite(reactance) && resistance >= 0) {
        const point = projection.toPoint(this.reflection(i));
        this.points[i * 2] = point.x;
        this.points[i * 2 + 1] = point.y;
      } else {
        this.points[i * 2] = lineGap;
        this.points[i * 2 + 1] = 0;
      }
    }
    if (count >= 2) {
      if (!this.buffer || this.buffer.sizeInBytes < this.points.byteLength) {
        this.buffer?.dispose();
        this.buffer = device.createBuffer({ sizeInBytes: this.points.byteLength, usage: BufferUsage.vertex });
      }
      this.buffer.write(0, this.points);
    }
    this.builtVersion = this.changes;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    const count = this.resistance.length;
    if (this.buffer && count >= 2) {
      commands.drawPolyline(this.buffer, 0, count, {
        widthInPixels: f(this.width * frame.dpiScale),
        color: this.stroke,
        clip: frame.bounds,
      });
    }
  }

  /** {@inheritDoc ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.buffer?.dispose();
    this.buffer = undefined;
    this.builtVersion = -1;
  }
}
