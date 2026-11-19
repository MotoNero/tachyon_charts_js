// The types a series and the hit test share; without imports, so that neither depends on the other.

/** How a hit test measures: the nearest point on the screen, or the nearest in X whatever its Y, for a cursor line. */
export type HitTestMode = 'nearest' | 'nearestX';

/** A point a series found. */
export interface FoundPoint {
  /** The number of the point in its source. */
  readonly index: number;
  /** The X value, relative to the origin of a time axis. */
  readonly x: number;
  /** The Y value. */
  readonly y: number;
}
