// An axis with named places at 0, 1, 2 and so on (CategoryAxis of the .NET version).
import { DoubleRange } from '../numerics/range';
import { Axis, emptyTicks, type AxisPosition, type AxisTick, type TextMeasurer, type TickSet } from './axis';

const labelGap = 8;
const minimumAngle = 1;

/** An axis with named places. Without room for all names it shows every n-th one. */
export class CategoryAxis extends Axis {
  private names: readonly string[] = [];
  private rotation = 0;

  constructor(id: string, position: AxisPosition, categories: readonly string[]) {
    super(id, position);
    this.categories = categories;
  }

  /** The names of the places 0, 1, 2 and so on; setting them shows all. */
  get categories(): readonly string[] {
    return this.names;
  }

  set categories(value: readonly string[]) {
    this.names = value;
    if (value.length > 0) {
      this.visibleRange = new DoubleRange(-0.5, value.length - 0.5);
    }
    this.changed();
  }

  /**
   * The rotation of the labels in degrees, up to 90 in both directions. Negative angles lift the end of the text, and
   * rotated labels end at their tick.
   */
  override get labelRotation(): number {
    return this.rotation;
  }

  override set labelRotation(value: number) {
    if (!(Math.abs(value) <= 90)) {
      throw new RangeError(`The rotation must be at most 90 degrees, not ${String(value)}.`);
    }
    this.rotation = value;
    this.changed();
  }

  override measureLabelHeight(measurer: TextMeasurer): number {
    const angle = (Math.abs(this.rotation) * Math.PI) / 180;
    return this.longest(measurer) * Math.sin(angle) + measurer.lineHeight * Math.cos(angle);
  }

  generateTicks(length: number, measurer: TextMeasurer): TickSet {
    const range = this.visibleRange;
    if (this.names.length === 0 || length <= 0) {
      return emptyTicks;
    }
    const first = Math.max(Math.trunc(Math.ceil(range.min)), 0);
    const last = Math.min(Math.trunc(Math.floor(range.max)), this.names.length - 1);
    const perPlace = length / (range.max - range.min);
    const step = Math.max(Math.trunc(Math.ceil(this.neededSpace(measurer) / perPlace)), 1);
    const major: AxisTick[] = [];
    // Multiples of the step, so that a label keeps its place while the view moves.
    for (let i = Math.trunc((first + step - 1) / step) * step; i <= last; i += step) {
      major.push({ value: i, label: this.names[i] ?? '' });
    }
    return { major, minor: [], step };
  }

  private longest(measurer: TextMeasurer): number {
    let longest = 0;
    for (const name of this.names) {
      longest = Math.max(longest, measurer.measureWidth(name));
    }
    return longest;
  }

  private neededSpace(measurer: TextMeasurer): number {
    if (!this.isHorizontal) {
      return measurer.lineHeight * 1.2;
    }
    const angle = Math.abs(this.rotation);
    return angle < minimumAngle
      ? this.longest(measurer) + labelGap
      : Math.min((measurer.lineHeight * 1.2) / Math.sin((angle * Math.PI) / 180), this.longest(measurer) + labelGap);
  }
}
