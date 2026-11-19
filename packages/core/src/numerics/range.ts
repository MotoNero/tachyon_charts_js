/** A closed interval of finite numbers, or the empty range that collects values through {@link DoubleRange.include}. */
export class DoubleRange {
  /** The range without values, the neutral element of {@link DoubleRange.include} and {@link DoubleRange.union}. */
  static readonly empty: DoubleRange = new DoubleRange(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, true);

  /**
   * @param min - The lower bound, finite.
   * @param max - The upper bound, finite and not below `min`.
   * @throws RangeError when a bound is not finite or `min` is above `max`.
   */
  constructor(
    /** The lower end. */
    readonly min: number,
    /** The upper end. */
    readonly max: number,
    isEmpty = false,
  ) {
    if (!isEmpty && (!Number.isFinite(min) || !Number.isFinite(max) || min > max)) {
      throw new RangeError(`The range [${String(min)}, ${String(max)}] is invalid.`);
    }
  }

  /** A range from two bounds in any order. */
  static fromUnordered(first: number, second: number): DoubleRange {
    return first <= second ? new DoubleRange(first, second) : new DoubleRange(second, first);
  }

  /** Whether the range holds no values. */
  get isEmpty(): boolean {
    return this.min > this.max;
  }

  /** The distance between the bounds: 0 for an empty range, infinite when it exceeds the largest number. */
  get length(): number {
    return this.isEmpty ? 0 : this.max - this.min;
  }

  /** The middle of the range, which does not overflow for large bounds. */
  get center(): number {
    if (this.isEmpty) {
      throw new RangeError('An empty range has no center.');
    }
    return this.min / 2 + this.max / 2;
  }

  /** Whether a value lies inside, both ends included. */
  contains(value: number): boolean {
    return value >= this.min && value <= this.max;
  }

  /** The smallest range that also holds the value. NaN and infinite values are gaps and change nothing. */
  include(value: number): DoubleRange {
    if (!Number.isFinite(value)) {
      return this;
    }
    return this.isEmpty
      ? new DoubleRange(value, value)
      : new DoubleRange(Math.min(this.min, value), Math.max(this.max, value));
  }

  /** The smallest range that holds both ranges. */
  union(other: DoubleRange): DoubleRange {
    if (this.isEmpty) {
      return other;
    }
    return other.isEmpty ? this : new DoubleRange(Math.min(this.min, other.min), Math.max(this.max, other.max));
  }

  /** Whether both ranges hold the same values. */
  equals(other: DoubleRange): boolean {
    return (this.isEmpty && other.isEmpty) || (this.min === other.min && this.max === other.max);
  }

  /** The range as "[min, max]", or "empty". */
  toString(): string {
    return this.isEmpty ? '[empty]' : `[${String(this.min)}, ${String(this.max)}]`;
  }
}
