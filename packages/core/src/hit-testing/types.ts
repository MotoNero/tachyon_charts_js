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

/**
 * An area of the screen that selects points, in physical pixels of the frame: the box around an outline and the
 * outline itself, as SelectionArea of the .NET version.
 */
export class SelectionArea {
  /**
   * @param left - The left edge of the box.
   * @param top - The top edge of the box.
   * @param right - The right edge of the box.
   * @param bottom - The bottom edge of the box.
   * @param polygon - The outline; the whole box when empty.
   */
  constructor(
    /** The left edge of the box. */
    readonly left: number,
    /** The top edge of the box. */
    readonly top: number,
    /** The right edge of the box. */
    readonly right: number,
    /** The bottom edge of the box. */
    readonly bottom: number,
    /** The outline; the whole box when empty. */
    readonly polygon: readonly { readonly x: number; readonly y: number }[] = [],
  ) {}

  /** The box around an outline and the outline. */
  static fromPolygon(outline: readonly { readonly x: number; readonly y: number }[]): SelectionArea {
    let left = Number.MAX_VALUE;
    let top = Number.MAX_VALUE;
    let right = -Number.MAX_VALUE;
    let bottom = -Number.MAX_VALUE;
    for (const point of outline) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
    return new SelectionArea(left, top, right, bottom, outline);
  }

  /** Whether a position lies in the area. */
  contains(x: number, y: number): boolean {
    if (x < this.left || x > this.right || y < this.top || y > this.bottom) {
      return false;
    }
    const outline = this.polygon;
    if (outline.length === 0) {
      return true;
    }
    // Crossing number: an odd count of edges right of the position means inside.
    let inside = false;
    let previous = outline[outline.length - 1] as { readonly x: number; readonly y: number };
    for (const current of outline) {
      if (
        current.y > y !== previous.y > y &&
        x < ((previous.x - current.x) * (y - current.y)) / (previous.y - current.y) + current.x
      ) {
        inside = !inside;
      }
      previous = current;
    }
    return inside;
  }
}
