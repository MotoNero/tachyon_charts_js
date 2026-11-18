// Reads glyph outlines from the glyf table and flattens them into polylines, as TrueTypeOutlines of the .NET version.
// The .NET version computes in single precision; every operation here rounds to it in the same order, so that the
// outlines and the distance fields built from them are the same bit for bit.
import type { FontFile } from './font';

const f = Math.fround;

/** A point of an outline. */
export interface Point {
  x: number;
  y: number;
}

/** A contour: curves one after the other, each a polyline whose last point is the first of the next. */
export type Contour = Point[][];

const onCurve = 0x01;
const xShort = 0x02;
const yShort = 0x04;
const repeat = 0x08;
const xSameOrPositive = 0x10;
const ySameOrPositive = 0x20;
const argumentsAreWords = 0x0001;
const argumentsAreOffsets = 0x0002;
const hasScale = 0x0008;
const moreComponents = 0x0020;
const hasXYScale = 0x0040;
const hasMatrix = 0x0080;
const maximumCompositeDepth = 6;

/** A 3 × 2 matrix as in System.Numerics: rows (m11, m12), (m21, m22), (m31, m32). */
interface Matrix {
  m11: number;
  m12: number;
  m21: number;
  m22: number;
  m31: number;
  m32: number;
}

function multiply(a: Matrix, b: Matrix): Matrix {
  return {
    m11: f(f(a.m11 * b.m11) + f(a.m12 * b.m21)),
    m12: f(f(a.m11 * b.m12) + f(a.m12 * b.m22)),
    m21: f(f(a.m21 * b.m11) + f(a.m22 * b.m21)),
    m22: f(f(a.m21 * b.m12) + f(a.m22 * b.m22)),
    m31: f(f(f(a.m31 * b.m11) + f(a.m32 * b.m21)) + b.m31),
    m32: f(f(f(a.m31 * b.m12) + f(a.m32 * b.m22)) + b.m32),
  };
}

function transform(x: number, y: number, m: Matrix): Point {
  return { x: f(f(f(x * m.m11) + f(y * m.m21)) + m.m31), y: f(f(f(x * m.m12) + f(y * m.m22)) + m.m32) };
}

interface OutlinePoint extends Point {
  onCurve: boolean;
}

export class Outlines {
  private readonly view: DataView;
  private readonly glyf: number;
  private readonly loca: number;

  /**
   * @param font - The font; it must have glyf and loca tables.
   * @param curveSegments - The straight pieces each curve becomes.
   */
  constructor(
    private readonly font: FontFile,
    private readonly curveSegments: number,
  ) {
    const glyf = font.table('glyf');
    const loca = font.table('loca');
    if (glyf === undefined || loca === undefined) {
      throw new Error('The font has no TrueType outlines.');
    }
    this.view = font.view;
    this.glyf = glyf;
    this.loca = loca;
  }

  /** The contours of a glyph at an em size, y growing downwards, flattened. */
  contours(glyph: number, emSize: number): Contour[] {
    const points: OutlinePoint[][] = [];
    const scale = f(emSize / this.font.unitsPerEm);
    this.collect(glyph, { m11: scale, m12: 0, m21: 0, m22: f(-scale), m31: 0, m32: 0 }, points, 0);
    const contours: Contour[] = [];
    for (const contour of points) {
      const curves = this.buildCurves(contour);
      if (curves.length > 0) {
        contours.push(curves);
      }
    }
    return contours;
  }

  private locate(glyph: number): [number, number] {
    const view = this.view;
    let start: number;
    let end: number;
    if (this.font.isLongLoca) {
      start = view.getUint32(this.loca + glyph * 4);
      end = view.getUint32(this.loca + (glyph + 1) * 4);
    } else {
      start = view.getUint16(this.loca + glyph * 2) * 2;
      end = view.getUint16(this.loca + (glyph + 1) * 2) * 2;
    }
    return [this.glyf + start, end - start];
  }

  private collect(glyph: number, matrix: Matrix, contours: OutlinePoint[][], depth: number): void {
    const [start, length] = this.locate(glyph);
    if (length === 0 || depth > maximumCompositeDepth) {
      return;
    }
    const count = this.view.getInt16(start);
    if (count >= 0) {
      this.collectSimple(start + 10, count, matrix, contours);
    } else {
      this.collectComposite(start + 10, matrix, contours, depth);
    }
  }

  private collectSimple(offset: number, contourCount: number, matrix: Matrix, contours: OutlinePoint[][]): void {
    const view = this.view;
    const ends: number[] = [];
    for (let i = 0; i < contourCount; i++) {
      ends.push(view.getUint16(offset + i * 2));
    }
    const pointCount = contourCount === 0 ? 0 : (ends.at(-1) ?? 0) + 1;
    let position = offset + contourCount * 2;
    position += 2 + view.getUint16(position);
    const flags = new Uint8Array(pointCount);
    for (let i = 0; i < pointCount; i++) {
      const flag = view.getUint8(position++);
      flags[i] = flag;
      if (flag & repeat) {
        const times = view.getUint8(position++);
        for (let r = 0; r < times; r++) {
          flags[++i] = flag;
        }
      }
    }
    const read = (shortFlag: number, sameFlag: number): Int32Array => {
      const values = new Int32Array(pointCount);
      let value = 0;
      for (let i = 0; i < pointCount; i++) {
        const flag = flags[i] ?? 0;
        if (flag & shortFlag) {
          const delta = view.getUint8(position++);
          value += flag & sameFlag ? delta : -delta;
        } else if (!(flag & sameFlag)) {
          value += view.getInt16(position);
          position += 2;
        }
        values[i] = value;
      }
      return values;
    };
    const xs = read(xShort, xSameOrPositive);
    const ys = read(yShort, ySameOrPositive);
    let first = 0;
    for (const end of ends) {
      const contour: OutlinePoint[] = [];
      for (let i = first; i <= end; i++) {
        const point = transform(xs[i] ?? 0, ys[i] ?? 0, matrix);
        contour.push({ x: point.x, y: point.y, onCurve: ((flags[i] ?? 0) & onCurve) !== 0 });
      }
      contours.push(contour);
      first = end + 1;
    }
  }

  private collectComposite(offset: number, matrix: Matrix, contours: OutlinePoint[][], depth: number): void {
    const view = this.view;
    let flags: number;
    do {
      flags = view.getUint16(offset);
      const component = view.getUint16(offset + 2);
      let dx: number;
      let dy: number;
      if (flags & argumentsAreWords) {
        dx = view.getInt16(offset + 4);
        dy = view.getInt16(offset + 6);
        offset += 8;
      } else {
        dx = view.getInt8(offset + 4);
        dy = view.getInt8(offset + 5);
        offset += 6;
      }
      if (!(flags & argumentsAreOffsets)) {
        // Point matching places a component by outline points, which text fonts do not use.
        dx = dy = 0;
      }
      const next = (): number => {
        const value = f(view.getInt16(offset) / 16384);
        offset += 2;
        return value;
      };
      const local: Matrix = { m11: 1, m12: 0, m21: 0, m22: 1, m31: dx, m32: dy };
      if (flags & hasScale) {
        local.m11 = local.m22 = next();
      } else if (flags & hasXYScale) {
        local.m11 = next();
        local.m22 = next();
      } else if (flags & hasMatrix) {
        local.m11 = next();
        local.m12 = next();
        local.m21 = next();
        local.m22 = next();
      }
      this.collect(component, multiply(local, matrix), contours, depth + 1);
    } while (flags & moreComponents);
  }

  // Two control points in a row imply a point on the curve between them.
  private buildCurves(contour: OutlinePoint[]): Point[][] {
    const curves: Point[][] = [];
    if (contour.length < 2) {
      return curves;
    }
    const startIndex = contour.findIndex((point) => point.onCurve);
    const last = contour.at(-1) as OutlinePoint;
    const firstPoint = contour[0] as OutlinePoint;
    const start = startIndex >= 0 ? (contour[startIndex] as OutlinePoint) : lerpHalf(last, firstPoint);
    const offset = startIndex >= 0 ? startIndex + 1 : 0;
    const steps = startIndex >= 0 ? contour.length - 1 : contour.length;
    let current: Point = start;
    let control: Point | undefined;
    for (let i = 0; i < steps; i++) {
      const point = contour[(offset + i) % contour.length] as OutlinePoint;
      if (point.onCurve) {
        this.addSegment(curves, current, control, point);
        current = point;
        control = undefined;
      } else {
        if (control) {
          const implied = lerpHalf(control, point);
          this.addSegment(curves, current, control, implied);
          current = implied;
        }
        control = point;
      }
    }
    this.addSegment(curves, current, control, start);
    return curves;
  }

  private addSegment(curves: Point[][], from: Point, control: Point | undefined, to: Point): void {
    const dx = f(from.x - to.x);
    const dy = f(from.y - to.y);
    if (f(f(dx * dx) + f(dy * dy)) <= f(1e-8)) {
      return;
    }
    if (!control) {
      curves.push([
        { x: from.x, y: from.y },
        { x: to.x, y: to.y },
      ]);
      return;
    }
    const points: Point[] = [];
    for (let i = 0; i <= this.curveSegments; i++) {
      const t = f(i / this.curveSegments);
      const u = f(1 - t);
      const a = f(u * u);
      const b = f(f(2 * u) * t);
      const c = f(t * t);
      points.push({
        x: f(f(f(a * from.x) + f(b * control.x)) + f(c * to.x)),
        y: f(f(f(a * from.y) + f(b * control.y)) + f(c * to.y)),
      });
    }
    curves.push(points);
  }
}

/** The point halfway between two points: (a · ½) + (b · ½) as System.Numerics computes it. */
function lerpHalf(a: Point, b: Point): Point {
  return { x: f(f(a.x * 0.5) + f(b.x * 0.5)), y: f(f(a.y * 0.5) + f(b.y * 0.5)) };
}
