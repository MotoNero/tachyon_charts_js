// What all axes share: placement, visible range and its limits (AxisBase of the .NET version).
import { DoubleRange } from '../numerics/range';
import type { AxisScaling } from '../numerics/scaling';
import { LinearAxisTransform } from '../numerics/transform';
import { formatGeneral } from '../locale/format';
import { invariantCulture } from '../locale/culture';

/** The side of the plot area an axis sits on. */
export type AxisPosition = 'left' | 'right' | 'top' | 'bottom';

/** Measures labels; the text engine of the chart implements it. */
export interface TextMeasurer {
  /** The height of a line in device-independent units. */
  readonly lineHeight: number;
  /** The width of a text in device-independent units. */
  measureWidth(text: string): number;
}

/** A labeled tick. */
export interface AxisTick {
  readonly value: number;
  readonly label: string;
}

/** The ticks of an axis for a visible range. */
export interface TickSet {
  readonly major: readonly AxisTick[];
  readonly minor: readonly number[];
  /** The distance of the major ticks in the unit of the axis; 0 for a single tick. */
  readonly step: number;
}

/** A set without ticks. */
export const emptyTicks: TickSet = { major: [], minor: [], step: 0 };

const minimumRelativeLength = 1e-13;
const singleValueMargin = 0.1;

/** An axis. It belongs to the thread that owns the chart. */
export abstract class Axis {
  private range = new DoubleRange(0, 1);
  private limitRange: DoubleRange | undefined;
  private inverted = false;
  private autoRange = true;
  private titleText: string | undefined;
  private crossing: number | undefined;
  private changes = 0;
  /** Whether the axis takes no room and draws nothing, as in polar charts, which use only its range. */
  isHidden = false;

  /**
   * @param id - The identifier series refer to.
   * @param position - The side of the plot area.
   */
  protected constructor(
    readonly id: string,
    readonly position: AxisPosition,
  ) {
    if (typeof id !== 'string' || id === '') {
      throw new RangeError('An axis needs an identifier.');
    }
  }

  /** Grows with every change, to detect outdated layouts. */
  get version(): number {
    return this.changes;
  }

  get isHorizontal(): boolean {
    return this.position === 'top' || this.position === 'bottom';
  }

  /** The title beside the labels. */
  get title(): string | undefined {
    return this.titleText;
  }

  set title(value: string | undefined) {
    if (value !== this.titleText) {
      this.titleText = value;
      this.changes++;
    }
  }

  /**
   * The visible range. Setting it ends the automatic range and keeps it inside the limits: a range that reaches out
   * moves back, a longer one is cut.
   */
  get visibleRange(): DoubleRange {
    return this.range;
  }

  set visibleRange(value: DoubleRange) {
    this.isAutoRange = false;
    this.applyRange(value);
  }

  /** The bounds of zooming and panning. */
  get limits(): DoubleRange | undefined {
    return this.limitRange;
  }

  set limits(value: DoubleRange | undefined) {
    if (value?.isEmpty) {
      throw new RangeError('The limits must not be empty.');
    }
    this.limitRange = value;
    this.changes++;
    this.applyRange(this.range);
  }

  /** Whether the range follows the data through {@link Axis.fitTo}. */
  get isAutoRange(): boolean {
    return this.autoRange;
  }

  set isAutoRange(value: boolean) {
    if (value !== this.autoRange) {
      this.autoRange = value;
      this.changes++;
    }
  }

  /** Whether the axis runs against its usual direction. */
  get isInverted(): boolean {
    return this.inverted;
  }

  set isInverted(value: boolean) {
    if (value !== this.inverted) {
      this.inverted = value;
      this.changes++;
    }
  }

  /**
   * The value of the other axis where this one runs through the plot, such as 0 for axes crossing in the origin;
   * `undefined` keeps it at the edge.
   */
  get crossesAt(): number | undefined {
    return this.crossing;
  }

  set crossesAt(value: number | undefined) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new RangeError('The place must be finite.');
    }
    this.crossing = value;
    this.changes++;
  }

  /** The rotation of the labels in degrees; only axes with free text support it. */
  get labelRotation(): number {
    return 0;
  }

  set labelRotation(value: number) {
    throw new Error(`This axis has no rotated labels (${String(value)}).`);
  }

  /** The height the labels of a horizontal axis take up. */
  measureLabelHeight(measurer: TextMeasurer): number {
    return measurer.lineHeight;
  }

  /** The width of a band between the plot and the ticks, such as a color bar. */
  // A getter, not a field: the color axis overrides it with its own width.
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  get bandThickness(): number {
    return 0;
  }

  /** The nonlinear scale of the axis, `undefined` for a linear one. */
  get scaling(): AxisScaling | undefined {
    return undefined;
  }

  /** Applies the range of the data while the range is automatic. Empty data leaves the range alone. */
  fitTo(data: DoubleRange, padding = 0.05): void {
    if (!Number.isFinite(padding) || padding < 0) {
      throw new RangeError(`The padding must not be negative, not ${String(padding)}.`);
    }
    if (this.autoRange && !data.isEmpty) {
      this.applyRange(this.padScaled(data, padding));
    }
  }

  /** The mapping to pixels. Vertical axes grow upwards, against the pixels. */
  createTransform(start: number, length: number): LinearAxisTransform {
    if (!(length >= 0)) {
      throw new RangeError(`The length must not be negative, not ${String(length)}.`);
    }
    const end = start + length;
    return this.isHorizontal !== this.inverted
      ? new LinearAxisTransform(this.range, start, end, this.scaling)
      : new LinearAxisTransform(this.range, end, start, this.scaling);
  }

  /** Scales the visible range around a value, which keeps its place. Limits still apply. */
  zoomAround(anchor: number, factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new RangeError(`The factor must be positive and finite, not ${String(factor)}.`);
    }
    const scaling = this.scaling;
    const center = scaling ? scaling.forward(anchor) : anchor;
    const min = scaling ? scaling.forward(this.range.min) : this.range.min;
    const max = scaling ? scaling.forward(this.range.max) : this.range.max;
    const first = center - (center - min) * factor;
    const second = center + (max - center) * factor;
    this.showRange(scaling ? scaling.inverse(first) : first, scaling ? scaling.inverse(second) : second);
  }

  /** Moves the visible range without changing its length. Limits still apply. */
  panBy(delta: number): void {
    this.showRange(this.range.min + delta, this.range.max + delta);
  }

  /** Shows a range given by its ends in any order, unless it cannot be told apart in doubles or is not finite. */
  showRange(first: number, second: number): void {
    if (!Number.isFinite(first) || !Number.isFinite(second)) {
      return;
    }
    const range = DoubleRange.fromUnordered(first, second);
    const magnitude = Math.max(Math.abs(range.min), Math.abs(range.max));
    if (Number.isFinite(range.length) && range.length > magnitude * minimumRelativeLength) {
      this.visibleRange = range;
    }
  }

  /** A value for a cursor, with more precision than a tick label needs. */
  formatCursorValue(value: number): string {
    return formatGeneral(value, 6, invariantCulture);
  }

  /** The ticks for the visible range at a length in device-independent units. */
  abstract generateTicks(length: number, measurer: TextMeasurer): TickSet;

  /** Brings a range into the domain of the axis. */
  protected normalizeRange(range: DoubleRange): DoubleRange {
    return range;
  }

  /** Marks the axis as changed. */
  protected changed(): void {
    this.changes++;
  }

  /** Sets the range as the axis would, for derived axes that set it on their own. */
  protected setRange(range: DoubleRange): void {
    this.isAutoRange = false;
    this.applyRange(range);
  }

  private static pad(data: DoubleRange, padding: number): DoubleRange {
    // A single value has no length to scale; it gets a margin of its own size.
    const ownSize = data.min !== 0 ? Math.abs(data.min) * singleValueMargin : 1;
    const margin = data.length > 0 ? data.length * padding : ownSize;
    const min = data.min - margin;
    const max = data.max + margin;
    return Number.isFinite(min) && Number.isFinite(max) ? new DoubleRange(min, max) : data;
  }

  // On a nonlinear axis, padding is the same distance on the screen at both ends.
  private padScaled(data: DoubleRange, padding: number): DoubleRange {
    const scaling = this.scaling;
    if (!scaling) {
      return Axis.pad(data, padding);
    }
    const valid = this.normalizeRange(data);
    const padded = Axis.pad(new DoubleRange(scaling.forward(valid.min), scaling.forward(valid.max)), padding);
    return new DoubleRange(scaling.inverse(padded.min), scaling.inverse(padded.max));
  }

  private applyRange(value: DoubleRange): void {
    if (value.isEmpty) {
      throw new RangeError('The visible range must not be empty.');
    }
    let range = this.normalizeRange(value);
    if (this.limitRange) {
      range = Axis.constrain(range, this.limitRange);
    }
    if (!range.equals(this.range)) {
      this.range = range;
      this.changes++;
    }
  }

  private static constrain(range: DoubleRange, limits: DoubleRange): DoubleRange {
    if (range.length >= limits.length) {
      return limits;
    }
    if (range.min < limits.min) {
      return new DoubleRange(limits.min, limits.min + range.length);
    }
    return range.max > limits.max ? new DoubleRange(limits.max - range.length, limits.max) : range;
  }
}
