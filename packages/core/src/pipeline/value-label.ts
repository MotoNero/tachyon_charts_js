// The labels a series shows at its points; without imports, so that series and the marks that draw them share them.

/** Where a value label sits at its point: above it, right of it, or on it. */
export type ValueLabelPlace = 'above' | 'right' | 'center';

/** A value a series shows at a point, in the units of its axes. */
export interface ValueLabel {
  /** The X value of the point. */
  readonly x: number;
  /** The Y value of the point. */
  readonly y: number;
  /** The value to write. */
  readonly value: number;
  /** Where the label sits. */
  readonly place: ValueLabelPlace;
}

/** An area in device-independent units. */
export interface AreaLike {
  /** The left edge. */
  readonly x: number;
  /** The top edge. */
  readonly y: number;
  /** The width. */
  readonly width: number;
  /** The height. */
  readonly height: number;
}

/** @internal At most this many labels per series and frame. */
export const valueLabelLimit = 2000;
