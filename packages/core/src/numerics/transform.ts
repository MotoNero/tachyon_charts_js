// Maps data values of an axis to pixel positions and back (LinearAxisTransform of the .NET version).
import type { DoubleRange } from './range';
import type { AxisScaling } from './scaling';

/**
 * A mapping that is linear after an optional scale. The pixel positions may run backwards, as usual for vertical
 * axes. A range of a single value maps to the middle of the pixels, so that a single point stays visible.
 */
export class LinearAxisTransform {
  private readonly dataOrigin: number;
  private readonly pixelOrigin: number;
  /** Pixels per unit of the data after the scale; 0 for a range of one value. */
  readonly pixelsPerUnit: number;

  /**
   * @throws RangeError when the range is empty or too long to be finite, or a pixel position is not finite.
   */
  constructor(
    data: DoubleRange,
    pixelAtMin: number,
    pixelAtMax: number,
    private readonly scaling?: AxisScaling,
  ) {
    const min = scaling ? scaling.forward(data.min) : data.min;
    const max = scaling ? scaling.forward(data.max) : data.max;
    const length = max - min;
    if (data.isEmpty || !Number.isFinite(length) || !Number.isFinite(min)) {
      throw new RangeError(`The range [${String(data.min)}, ${String(data.max)}] cannot be mapped.`);
    }
    if (!Number.isFinite(pixelAtMin) || !Number.isFinite(pixelAtMax)) {
      throw new RangeError('The pixel positions must be finite.');
    }
    this.dataOrigin = min;
    if (length > 0) {
      this.pixelOrigin = pixelAtMin;
      this.pixelsPerUnit = (pixelAtMax - pixelAtMin) / length;
    } else {
      this.pixelOrigin = pixelAtMin / 2 + pixelAtMax / 2;
      this.pixelsPerUnit = 0;
    }
  }

  /** Whether the mapping has no nonlinear scale. */
  get isLinear(): boolean {
    return this.scaling === undefined;
  }

  /** A data value as a pixel position; NaN stays NaN. */
  toPixel(value: number): number {
    return this.toPixelLinear(this.scaling ? this.scaling.forward(value) : value);
  }

  /** A value already in the linear space of the scale as a pixel position. */
  toPixelLinear(value: number): number {
    return this.pixelOrigin + (value - this.dataOrigin) * this.pixelsPerUnit;
  }

  /** A pixel position as a data value. */
  toData(pixel: number): number {
    const value =
      this.pixelsPerUnit === 0 ? this.dataOrigin : this.dataOrigin + (pixel - this.pixelOrigin) / this.pixelsPerUnit;
    return this.scaling ? this.scaling.inverse(value) : value;
  }

  /** Many data values as pixel positions. */
  toPixels(values: ArrayLike<number>, pixels: Float32Array | Float64Array): void {
    if (values.length !== pixels.length) {
      throw new RangeError('The arrays must have the same length.');
    }
    for (let i = 0; i < values.length; i++) {
      pixels[i] = this.toPixel(values[i] as number);
    }
  }
}
