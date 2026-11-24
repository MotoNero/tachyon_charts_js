// Drawing tools of technical analysis: trend lines, Fibonacci retracements and extensions, channels, pitchforks,
// Elliott waves, XABCD patterns, head and shoulders and the brush, placed with the pointer, moved, saved and loaded,
// as Drawing, DrawingLayer, DrawingShapes, DrawingJson, DrawingModifier and DrawingTools of the .NET version.
import type { Axis } from '../axes/axis';
import type { ChartBuilder } from '../fluent/chart-builder';
import type { ChartEdit, ChartInteraction } from '../input/chart-interaction';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import type { KeyInputEvent, Point, PointerInputEvent } from '../input/primitives';
import { DipRect, type ChartLayoutResult } from '../layout/chart-layout';
import { chartText, invariantCulture } from '../locale/culture';
import { formatFixed, formatGeneral } from '../locale/format';
import { roundHalfEven } from '../numerics/nice';
import type { LinearAxisTransform } from '../numerics/transform';
import type { Rgba8 } from '../render/types';
import { originOf } from '../series/line-series';
import { parseColor } from '../render/types';
import { ChartOverlay, type OverlayCanvas } from './chart-overlay';

const f = Math.fround;

// A color as the themes write it: #RRGGBB, with the opacity last when it is not full.
function formatColor(color: Rgba8): string {
  const hex = (value: number): string => value.toString(16).toUpperCase().padStart(2, '0');
  const rgb = `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
  return color.a === 255 ? rgb : rgb + hex(color.a);
}
const handleSize = 4;
const labelSize = 11;

/** The kinds of drawings, in the order of the number keys 1 to 9. */
export const drawingKinds = [
  'trendLine',
  'fibonacciRetracement',
  'fibonacciExtension',
  'trendChannel',
  'pitchfork',
  'elliottWave',
  'xabcd',
  'headAndShoulders',
  'brush',
] as const;

/** A kind of drawing. */
export type DrawingKind = (typeof drawingKinds)[number];

/** A point of a drawing in the units of the data: absolute times on a time axis. */
export interface DrawingPoint {
  /** The X value. */
  readonly x: number;
  /** The Y value. */
  readonly y: number;
}

/** The number of points a kind needs; 0 for any number from two, as the brush. */
export function drawingPointCount(kind: DrawingKind): number {
  switch (kind) {
    case 'trendLine':
    case 'fibonacciRetracement':
      return 2;
    case 'fibonacciExtension':
    case 'trendChannel':
    case 'pitchfork':
      return 3;
    case 'elliottWave':
      return 6;
    case 'xabcd':
      return 5;
    case 'headAndShoulders':
      return 7;
    default:
      return 0;
  }
}

function checkPoints(points: readonly DrawingPoint[]): DrawingPoint[] {
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new RangeError('The points of a drawing must be finite.');
  }
  return points.map((point) => ({ x: point.x, y: point.y }));
}

/** A drawing: its kind, its points, color and thickness. */
export class Drawing {
  /** The color; amber by default. */
  color: Rgba8 = { r: 255, g: 190, b: 11, a: 255 };
  /** The thickness of its lines; 1.5 by default. */
  thickness = 1.5;
  private pointList: DrawingPoint[];

  /**
   * @param kind - The kind.
   * @param points - The points, as many as the kind needs, at least two.
   * @throws RangeError for a wrong number of points or a point that is not finite.
   */
  constructor(
    /** The kind. */
    readonly kind: DrawingKind,
    points: readonly DrawingPoint[],
  ) {
    const needed = drawingPointCount(kind);
    if ((needed > 0 && points.length !== needed) || points.length < 2) {
      throw new RangeError(
        `A ${kind} needs ${needed > 0 ? String(needed) : 'two or more'} points, not ${String(points.length)}.`,
      );
    }
    this.pointList = checkPoints(points);
  }

  /** The points. */
  get points(): readonly DrawingPoint[] {
    return this.pointList;
  }

  /** @internal Replaces the points. */
  setPoints(points: readonly DrawingPoint[]): void {
    this.pointList = checkPoints(points);
  }
}

/** @internal A line of a drawing on the screen. */
export interface DrawingSegment {
  readonly from: Point;
  readonly to: Point;
  readonly isFaint: boolean;
}

interface DrawingLabel {
  readonly text: string;
  readonly position: Point;
}

type DrawingBand = readonly [Point, Point, Point, Point];

const retracement = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const extension = [0, 0.618, 1, 1.272, 1.618, 2.618];

const add = (a: Point, b: Point): Point => ({ x: f(a.x + b.x), y: f(a.y + b.y) });
const sub = (a: Point, b: Point): Point => ({ x: f(a.x - b.x), y: f(a.y - b.y) });
const mul = (a: Point, s: number): Point => ({ x: f(a.x * s), y: f(a.y * s) });
const half = (a: Point, b: Point): Point => ({ x: f(f(a.x + b.x) / 2), y: f(f(a.y + b.y) / 2) });

function placementTransform(layout: ChartLayoutResult, axis: Axis): LinearAxisTransform | undefined {
  const placement = layout.axes.find((item) => item.axis === axis);
  if (!placement) {
    return undefined;
  }
  const bounds = placement.bounds;
  return axis.isHorizontal
    ? axis.createTransform(bounds.x, bounds.width)
    : axis.createTransform(bounds.y, bounds.height);
}

/** The drawings of a chart: drawn above the plot, saved as JSON and loaded again. */
export class DrawingLayer extends ChartOverlay {
  /** The color of new drawings. */
  color: Rgba8 = { r: 255, g: 190, b: 11, a: 255 };
  /** Called when the pointer completes a drawing. */
  onCompleted: ((drawing: Drawing) => void) | undefined;
  private drawingList: Drawing[] = [];
  private chosen: Drawing | undefined;
  private activeTool: DrawingKind | undefined;
  private draftPoints: DrawingPoint[] = [];
  private previewPoint: DrawingPoint | undefined;

  /**
   * @param xAxis - The axis of the X values.
   * @param yAxis - The axis of the Y values.
   */
  constructor(
    /** The axis of the X values. */
    readonly xAxis: Axis,
    /** The axis of the Y values. */
    readonly yAxis: Axis,
  ) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + chartText.version + this.xAxis.version + this.yAxis.version;
  }

  /** The drawings. */
  get drawings(): readonly Drawing[] {
    return this.drawingList;
  }

  /** The tool the pointer draws with; none when left out. */
  get tool(): DrawingKind | undefined {
    return this.activeTool;
  }

  set tool(value: DrawingKind | undefined) {
    this.activeTool = value;
    this.draftPoints = [];
    this.previewPoint = undefined;
    this.touch();
  }

  /** The chosen drawing, shown with its points. */
  get selected(): Drawing | undefined {
    return this.chosen;
  }

  set selected(value: Drawing | undefined) {
    this.chosen = value;
    this.touch();
  }

  /** @internal The points placed so far with the tool. */
  get draft(): readonly DrawingPoint[] {
    return this.draftPoints;
  }

  /** Adds a drawing. */
  add(drawing: Drawing): void {
    this.drawingList = [...this.drawingList, drawing];
    this.touch();
  }

  /** Removes a drawing; false when it is not there. */
  remove(drawing: Drawing): boolean {
    const removed = this.drawingList.includes(drawing);
    this.drawingList = this.drawingList.filter((item) => item !== drawing);
    if (this.chosen === drawing) {
      this.chosen = undefined;
    }
    this.touch();
    return removed;
  }

  /** Removes all drawings. */
  clear(): void {
    this.drawingList = [];
    this.chosen = undefined;
    this.touch();
  }

  /** The drawings as JSON, as the .NET version writes them. */
  save(): string {
    return writeDrawings(this.drawingList);
  }

  /**
   * Replaces the drawings by those of JSON written by {@link DrawingLayer.save}.
   * @throws SyntaxError for text that is no list of drawings or holds an incomplete one.
   */
  load(json: string): void {
    this.drawingList = [...readDrawings(json)];
    this.chosen = undefined;
    this.touch();
  }

  /** @internal Asks for a new frame. */
  touch(): void {
    this.changed();
  }

  /** @internal Sets the points placed so far and the point under the pointer. */
  setDraft(points: readonly DrawingPoint[], preview: DrawingPoint | undefined): void {
    this.draftPoints = [...points];
    this.previewPoint = preview;
    this.touch();
  }

  /** @internal Tells the listener that a drawing is complete. */
  notifyCompleted(drawing: Drawing): void {
    this.onCompleted?.(drawing);
  }

  /** @internal A point of the data on the screen, if the axes are placed. */
  map(layout: ChartLayoutResult, point: DrawingPoint): Point | undefined {
    const x = placementTransform(layout, this.xAxis);
    const y = placementTransform(layout, this.yAxis);
    if (!x || !y) {
      return undefined;
    }
    const alongX = f(x.toPixel(point.x - originOf(this.xAxis)));
    const alongY = f(y.toPixel(point.y - originOf(this.yAxis)));
    // With the X axis down, X goes up and down on the screen and Y across.
    return this.xAxis.isHorizontal ? { x: alongX, y: alongY } : { x: alongY, y: alongX };
  }

  /** @internal A place on the screen as a point of the data. */
  unmap(layout: ChartLayoutResult, position: Point): DrawingPoint | undefined {
    const x = placementTransform(layout, this.xAxis);
    const y = placementTransform(layout, this.yAxis);
    if (!x || !y) {
      return undefined;
    }
    const alongX = this.xAxis.isHorizontal ? position.x : position.y;
    const alongY = this.xAxis.isHorizontal ? position.y : position.x;
    return { x: x.toData(alongX) + originOf(this.xAxis), y: y.toData(alongY) + originOf(this.yAxis) };
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const layout = canvas.layout;
    canvas.clip = layout.plotArea;
    for (const drawing of this.drawingList) {
      this.drawOne(
        canvas,
        layout,
        drawing.kind,
        drawing.points,
        drawing.color,
        drawing.thickness,
        drawing === this.chosen,
      );
    }
    const tool = this.activeTool;
    if (tool !== undefined && this.draftPoints.length > 0) {
      const points = this.previewPoint ? [...this.draftPoints, this.previewPoint] : this.draftPoints;
      this.drawOne(canvas, layout, tool, points, { ...this.color, a: 200 }, 1.5, true);
    }
    canvas.clip = undefined;
  }

  private drawOne(
    canvas: OverlayCanvas,
    layout: ChartLayoutResult,
    kind: DrawingKind,
    points: readonly DrawingPoint[],
    color: Rgba8,
    thickness: number,
    isSelected: boolean,
  ): void {
    const shapes = buildShapes(this, layout, kind, points);
    const area = layout.plotArea;
    for (const band of shapes.bands) {
      const corners = clipPolygon(band, area);
      for (let i = 2; i < corners.length; i++) {
        canvas.fillTriangle(corners[0] as Point, corners[i - 1] as Point, corners[i] as Point, { ...color, a: 28 });
      }
    }
    for (const segment of shapes.segments) {
      const clipped = clipLine(segment.from, segment.to, area);
      if (clipped) {
        canvas.drawLine(
          clipped[0],
          clipped[1],
          segment.isFaint ? 1 : thickness,
          segment.isFaint ? { ...color, a: 150 } : color,
        );
      }
    }
    for (const label of shapes.labels) {
      canvas.drawText(label.text, roundHalfEven(label.position.x), roundHalfEven(label.position.y), labelSize, color);
    }
    if (!isSelected) {
      return;
    }
    for (const point of points) {
      const at = this.map(layout, point);
      if (at) {
        const square = new DipRect(at.x - handleSize, at.y - handleSize, handleSize * 2, handleSize * 2);
        canvas.fillRectangle(square, canvas.colors.background);
        canvas.drawRectangle(square, color);
      }
    }
  }
}

/** @internal The lines, labels and bands of a drawing on the screen. */
export function buildShapes(
  layer: DrawingLayer,
  layout: ChartLayoutResult,
  kind: DrawingKind,
  points: readonly DrawingPoint[],
): { segments: DrawingSegment[]; labels: DrawingLabel[]; bands: DrawingBand[] } {
  const segments: DrawingSegment[] = [];
  const labels: DrawingLabel[] = [];
  const bands: DrawingBand[] = [];
  const result = { segments, labels, bands };
  const at: Point[] = [];
  for (const point of points) {
    const mapped = layer.map(layout, point);
    if (!mapped) {
      return result;
    }
    at.push(mapped);
  }
  const area = layout.plotArea;
  const p = (i: number): DrawingPoint => points[i] as DrawingPoint;
  const a = (i: number): Point => at[i] as Point;
  switch (kind) {
    case 'fibonacciRetracement':
      if (points.length >= 2) {
        levels(layer, layout, p(0), p(1), p(1).x, retracement, false, result);
        segments.push({ from: a(0), to: a(1), isFaint: true });
      }
      break;
    case 'fibonacciExtension':
      if (points.length >= 3) {
        const move = p(1).y - p(0).y;
        const end = p(2).x + (p(1).x - p(0).x);
        levels(layer, layout, p(2), { x: p(2).x, y: p(2).y + move }, end, extension, true, result);
        polyline(at.slice(0, 3), segments, true);
      }
      break;
    case 'trendChannel':
      if (points.length >= 3) {
        channel(a(0), a(1), a(2), result);
      }
      break;
    case 'pitchfork':
      if (points.length >= 3) {
        pitchfork(a(0), a(1), a(2), area, segments);
      }
      break;
    case 'elliottWave':
      polyline(at, segments, false);
      at.forEach((_, i) => {
        name(at, i, String(i), labels);
      });
      break;
    case 'xabcd':
      harmonic(points, at, result);
      break;
    case 'headAndShoulders':
      shoulders(at, area, segments, labels);
      break;
    default:
      polyline(at, segments, false);
      break;
  }
  return result;
}

/** @internal A line cut to an area, or nothing when it lies outside. */
export function clipLine(from: Point, to: Point, area: DipRect): [Point, Point] | undefined {
  let enter = 0;
  let leave = 1;
  const delta = sub(to, from);
  const p = [-delta.x, delta.x, -delta.y, delta.y];
  const q = [from.x - area.x, area.right - from.x, from.y - area.y, area.bottom - from.y];
  for (let i = 0; i < 4; i++) {
    const pi = p[i] as number;
    const qi = q[i] as number;
    if (pi === 0) {
      if (qi < 0) {
        return undefined;
      }
      continue;
    }
    const r = qi / pi;
    if (pi < 0) {
      enter = Math.max(enter, r);
    } else {
      leave = Math.min(leave, r);
    }
  }
  if (enter > leave) {
    return undefined;
  }
  return [add(from, mul(delta, f(enter))), add(from, mul(delta, f(leave)))];
}

function insideEdge(point: Point, edge: number, area: DipRect): boolean {
  switch (edge) {
    case 0:
      return point.x >= area.x;
    case 1:
      return point.x <= area.right;
    case 2:
      return point.y >= area.y;
    default:
      return point.y <= area.bottom;
  }
}

function crossEdge(a: Point, b: Point, edge: number, area: DipRect): Point {
  const delta = sub(b, a);
  let t: number;
  switch (edge) {
    case 0:
      t = (area.x - a.x) / delta.x;
      break;
    case 1:
      t = (area.right - a.x) / delta.x;
      break;
    case 2:
      t = (area.y - a.y) / delta.y;
      break;
    default:
      t = (area.bottom - a.y) / delta.y;
      break;
  }
  return add(a, mul(delta, f(t)));
}

/** @internal A polygon cut to an area, at most eight corners. */
export function clipPolygon(polygon: readonly Point[], area: DipRect): Point[] {
  let current = [...polygon];
  for (let edge = 0; edge < 4 && current.length > 0; edge++) {
    const next: Point[] = [];
    current.forEach((point, i) => {
      const following = current[(i + 1) % current.length] as Point;
      const isIn = insideEdge(point, edge, area);
      const nextIn = insideEdge(following, edge, area);
      if (isIn && next.length < 8) {
        next.push(point);
      }
      if (isIn !== nextIn && next.length < 8) {
        next.push(crossEdge(point, following, edge, area));
      }
    });
    current = next;
  }
  return current;
}

/** @internal The distance of a position from the nearest line. */
export function distanceToSegments(position: Point, segments: readonly DrawingSegment[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const segment of segments) {
    const line = sub(segment.to, segment.from);
    const length = line.x * line.x + line.y * line.y;
    const t =
      length > 0
        ? Math.min(
            Math.max(((position.x - segment.from.x) * line.x + (position.y - segment.from.y) * line.y) / length, 0),
            1,
          )
        : 0;
    best = Math.min(
      best,
      Math.hypot(position.x - (segment.from.x + line.x * t), position.y - (segment.from.y + line.y * t)),
    );
  }
  return best;
}

function polyline(at: readonly Point[], segments: DrawingSegment[], isFaint: boolean): void {
  for (let i = 1; i < at.length; i++) {
    segments.push({ from: at[i - 1] as Point, to: at[i] as Point, isFaint });
  }
}

function percent(ratio: number): string {
  const culture = chartText.culture;
  return formatFixed(ratio * 100, 1, culture).replace(new RegExp(`\\${culture.decimalSeparator}0$`), '');
}

// Each level: a line from the first to the last time, its ratio and price; the bands between levels filled.
function levels(
  layer: DrawingLayer,
  layout: ChartLayoutResult,
  from: DrawingPoint,
  to: DrawingPoint,
  end: number,
  ratios: readonly number[],
  isExtension: boolean,
  result: { segments: DrawingSegment[]; labels: DrawingLabel[]; bands: DrawingBand[] },
): void {
  let previous: Point | undefined;
  let previousEnd: Point = { x: 0, y: 0 };
  for (const ratio of ratios) {
    const price = isExtension ? from.y + (to.y - from.y) * ratio : to.y + (from.y - to.y) * ratio;
    const left = layer.map(layout, { x: from.x, y: price });
    const right = layer.map(layout, { x: end, y: price });
    if (!left || !right) {
      return;
    }
    result.segments.push({ from: left, to: right, isFaint: ratio !== 0 && ratio !== 1 });
    result.labels.push({
      text: `${percent(ratio)} % (${formatGeneral(price, 6, chartText.culture)})`,
      position: { x: f(Math.max(left.x, right.x) + 4), y: f(left.y + 4) },
    });
    if (previous) {
      result.bands.push([previous, previousEnd, right, left]);
    }
    previous = left;
    previousEnd = right;
  }
}

// The line through the first two points and its parallel through the third.
function channel(a: Point, b: Point, c: Point, result: { segments: DrawingSegment[]; bands: DrawingBand[] }): void {
  const slope = b.x !== a.x ? f(f(b.y - a.y) / f(b.x - a.x)) : 0;
  const offset = f(c.y - f(a.y + f(f(c.x - a.x) * slope)));
  const a2 = { x: a.x, y: f(a.y + offset) };
  const b2 = { x: b.x, y: f(b.y + offset) };
  result.segments.push({ from: a, to: b, isFaint: false });
  result.segments.push({ from: a2, to: b2, isFaint: false });
  result.segments.push({ from: half(a, a2), to: half(b, b2), isFaint: true });
  result.bands.push([a, b, b2, a2]);
}

// The median line from the pivot through the middle of the other two, and its parallels through them, to the edge.
function pitchfork(pivot: Point, first: Point, second: Point, area: DipRect, segments: DrawingSegment[]): void {
  const middle = half(first, second);
  const direction = sub(middle, pivot);
  const lengthSquared = f(f(direction.x * direction.x) + f(direction.y * direction.y));
  if (lengthSquared <= 0) {
    return;
  }
  const reach = f(f(Math.sqrt(area.width * area.width + area.height * area.height) / f(Math.sqrt(lengthSquared))) + 1);
  segments.push({ from: pivot, to: add(pivot, mul(direction, reach)), isFaint: false });
  segments.push({ from: first, to: add(first, mul(direction, reach)), isFaint: false });
  segments.push({ from: second, to: add(second, mul(direction, reach)), isFaint: false });
  segments.push({ from: first, to: second, isFaint: true });
}

function harmonic(
  points: readonly DrawingPoint[],
  at: readonly Point[],
  result: { segments: DrawingSegment[]; labels: DrawingLabel[]; bands: DrawingBand[] },
): void {
  polyline(at, result.segments, false);
  const names = ['X', 'A', 'B', 'C', 'D'];
  at.forEach((_, i) => {
    name(at, i, names[i] ?? '', result.labels);
  });
  const p = (i: number): DrawingPoint => points[i] as DrawingPoint;
  const a = (i: number): Point => at[i] as Point;
  if (at.length >= 3) {
    result.segments.push({ from: a(0), to: a(2), isFaint: true });
    result.bands.push([a(0), a(1), a(2), a(2)]);
    ratio(p(1).y - p(2).y, p(1).y - p(0).y, half(a(0), a(2)), result.labels);
  }
  if (at.length >= 5) {
    result.segments.push({ from: a(2), to: a(4), isFaint: true });
    result.bands.push([a(2), a(3), a(4), a(4)]);
    ratio(p(3).y - p(4).y, p(3).y - p(2).y, half(a(2), a(4)), result.labels);
  }
}

// The line through both lows of the neck, across the whole pattern.
function shoulders(at: readonly Point[], area: DipRect, segments: DrawingSegment[], labels: DrawingLabel[]): void {
  polyline(at, segments, false);
  const names = ['', 'LS', '', 'H', '', 'RS', ''];
  at.forEach((_, i) => {
    name(at, i, names[i] ?? '', labels);
  });
  const a = (i: number): Point => at[i] as Point;
  if (at.length >= 7 && a(4).x !== a(2).x) {
    const slope = f(f(a(4).y - a(2).y) / f(a(4).x - a(2).x));
    const left = { x: a(0).x, y: f(a(2).y + f(f(a(0).x - a(2).x) * slope)) };
    const rightX = Math.min(f(area.right), f(a(6).x + f(f(a(6).x - a(0).x) * f(0.2))));
    const right = { x: rightX, y: f(a(2).y + f(f(rightX - a(2).x) * slope)) };
    segments.push({ from: left, to: right, isFaint: true });
  }
}

function ratio(part: number, whole: number, place: Point, labels: DrawingLabel[]): void {
  if (whole !== 0) {
    labels.push({
      text: formatFixed(Math.abs(part / whole), 3, invariantCulture),
      position: add(place, { x: 4, y: 0 }),
    });
  }
}

// A name above a peak and below a trough.
function name(at: readonly Point[], i: number, text: string, labels: DrawingLabel[]): void {
  if (text.length === 0) {
    return;
  }
  const point = at[i] as Point;
  let neighbour = point.y;
  if (i > 0) {
    neighbour = (at[i - 1] as Point).y;
  } else if (i + 1 < at.length) {
    neighbour = (at[i + 1] as Point).y;
  }
  const isPeak = point.y <= neighbour;
  labels.push({ text, position: { x: f(point.x - 4), y: isPeak ? f(point.y - 8) : f(point.y + 16) } });
}

interface DrawingFile {
  version?: number;
  drawings?: { kind?: string; color?: string; thickness?: number; points?: { x?: number; y?: number }[] }[];
}

function pascal(kind: DrawingKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** @internal Writes drawings as the JSON of the .NET version. */
export function writeDrawings(drawings: readonly Drawing[]): string {
  return JSON.stringify(
    {
      version: 1,
      drawings: drawings.map((drawing) => ({
        kind: pascal(drawing.kind),
        color: formatColor(drawing.color),
        thickness: drawing.thickness,
        points: drawing.points.map((point) => ({ x: point.x, y: point.y })),
      })),
    },
    undefined,
    2,
  );
}

/** @internal Reads drawings from the JSON of the .NET version. */
export function readDrawings(json: string): Drawing[] {
  let file: DrawingFile;
  try {
    file = JSON.parse(json) as DrawingFile;
  } catch (error) {
    throw new SyntaxError(`The text is no list of drawings: ${(error as Error).message}`, { cause: error });
  }
  if (!Array.isArray(file.drawings)) {
    throw new SyntaxError('The text holds no drawings.');
  }
  if ((file.version ?? 0) > 1) {
    throw new SyntaxError(`The drawings were saved by a newer version (${String(file.version)}).`);
  }
  return file.drawings.map((item) => {
    const kind = drawingKinds.find((candidate) => candidate.toLowerCase() === (item.kind ?? '').toLowerCase());
    if (!kind) {
      throw new SyntaxError(`A drawing is incomplete: there is no kind "${String(item.kind)}".`);
    }
    try {
      const drawing = new Drawing(
        kind,
        (item.points ?? []).map((point) => ({ x: point.x ?? Number.NaN, y: point.y ?? Number.NaN })),
      );
      drawing.thickness = item.thickness !== undefined && item.thickness > 0 ? item.thickness : 1.5;
      if (item.color !== undefined && item.color.length > 0) {
        drawing.color = parseColor(item.color);
      }
      return drawing;
    } catch (error) {
      throw new SyntaxError(`A drawing is incomplete: ${(error as Error).message}`, { cause: error });
    }
  });
}

function listEdit(layer: DrawingLayer, drawing: Drawing, isAdded: boolean): ChartEdit {
  const apply = (add: boolean): void => {
    if (add) {
      layer.add(drawing);
    } else {
      layer.remove(drawing);
    }
  };
  return {
    undo: () => {
      apply(!isAdded);
    },
    redo: () => {
      apply(isAdded);
    },
  };
}

function pointsEdit(
  layer: DrawingLayer,
  drawing: Drawing,
  before: readonly DrawingPoint[],
  after: readonly DrawingPoint[],
): ChartEdit {
  return {
    undo: () => {
      drawing.setPoints(before);
      layer.touch();
    },
    redo: () => {
      drawing.setPoints(after);
      layer.touch();
    },
  };
}

/**
 * Draws with the tools of a drawing layer: keys 1 to 9 choose a tool, clicks place its points, the brush follows a
 * drag; a drag on a drawing moves it, on a point of the chosen one moves the point; Delete removes the chosen one,
 * Escape or 0 stops the tool.
 */
export class DrawingModifier extends ChartModifier {
  /** The priority, between zooming and the crosshair. */
  static readonly defaultPriority = 30;
  /** How far beside a line or point the pointer still finds it; 6 by default. */
  tolerance = 6;
  /** Whether keys 1 to 9 choose tools and 0 stops; true by default. */
  usesNumberKeys = true;
  private dragged: Drawing | undefined;
  private pointIndex = -1;
  private before: readonly DrawingPoint[] = [];
  private start: DrawingPoint = { x: 0, y: 0 };
  private isBrushing = false;

  /** @param fixedLayer - The layer; the first drawing layer of the chart when left out. */
  constructor(private readonly fixedLayer?: DrawingLayer) {
    super(DrawingModifier.defaultPriority);
  }

  // Found anew each time, so that the modifier keeps working when the chart creates its overlays again.
  private get layer(): DrawingLayer | undefined {
    if (this.fixedLayer) {
      return this.fixedLayer;
    }
    return this.interaction?.chart.overlays.find((overlay): overlay is DrawingLayer => overlay instanceof DrawingLayer);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const interaction = this.interaction;
    const layout = interaction?.chart.currentLayout;
    const layer = this.layer;
    const point = layout && layer ? layer.unmap(layout, input.position) : undefined;
    if (!interaction || !layout || !layer || !point) {
      return 'ignored';
    }
    const tool = layer.tool;
    if (tool !== undefined) {
      return this.create(interaction, layer, tool, input, point);
    }
    if (input.kind === 'pressed' && input.changedButton === 'primary') {
      return this.press(layer, layout, input.position, point);
    }
    if (input.kind === 'moved' && this.dragged) {
      return this.drag(layer, point);
    }
    if ((input.kind === 'released' || input.kind === 'canceled') && this.dragged) {
      return this.finish(interaction, layer);
    }
    return 'ignored';
  }

  /** {@inheritDoc ChartModifier.onKey} */
  override onKey(input: KeyInputEvent): ModifierResult {
    const interaction = this.interaction;
    const layer = this.layer;
    if (input.kind !== 'pressed' || !interaction || !layer) {
      return 'ignored';
    }
    if (input.key === 'Escape' && layer.tool !== undefined) {
      layer.tool = undefined;
      return 'handled';
    }
    const selected = layer.selected;
    if (input.key === 'Delete' && selected) {
      layer.remove(selected);
      interaction.history.recordEdit(listEdit(layer, selected, false));
      return 'handled';
    }
    const digit = /^D(\d)$/.exec(input.key);
    if (digit && this.usesNumberKeys && input.modifiers === 0) {
      const number = Number(digit[1]);
      layer.tool = number === 0 ? undefined : drawingKinds[number - 1];
      return 'handled';
    }
    return 'ignored';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.dragged = undefined;
    this.isBrushing = false;
  }

  private create(
    interaction: ChartInteraction,
    layer: DrawingLayer,
    tool: DrawingKind,
    input: PointerInputEvent,
    point: DrawingPoint,
  ): ModifierResult {
    const draft = layer.draft;
    if (tool === 'brush') {
      if (input.kind === 'pressed' && input.changedButton === 'primary') {
        this.isBrushing = true;
        layer.setDraft([point], undefined);
        return 'capture';
      }
      if (input.kind === 'moved' && this.isBrushing) {
        layer.setDraft([...draft, point], undefined);
        return 'handled';
      }
      if (input.kind === 'released' && this.isBrushing) {
        this.isBrushing = false;
        this.complete(interaction, layer, tool, [...draft, point]);
        return 'release';
      }
      return 'ignored';
    }
    if (input.kind === 'moved') {
      if (draft.length > 0) {
        layer.setDraft(draft, point);
      }
      return 'ignored';
    }
    if (input.kind !== 'pressed' || input.changedButton !== 'primary') {
      return 'ignored';
    }
    const points = [...draft, point];
    if (points.length >= drawingPointCount(tool)) {
      this.complete(interaction, layer, tool, points);
    } else {
      layer.setDraft(points, point);
    }
    return 'handled';
  }

  private complete(
    interaction: ChartInteraction,
    layer: DrawingLayer,
    tool: DrawingKind,
    points: DrawingPoint[],
  ): void {
    layer.tool = undefined;
    if (points.length < 2) {
      return;
    }
    const drawing = new Drawing(tool, points);
    drawing.color = layer.color;
    layer.add(drawing);
    layer.selected = drawing;
    interaction.history.recordEdit(listEdit(layer, drawing, true));
    layer.notifyCompleted(drawing);
  }

  // A press on a point of the selected drawing drags the point; on any line, the whole drawing.
  private press(layer: DrawingLayer, layout: ChartLayoutResult, position: Point, point: DrawingPoint): ModifierResult {
    const selected = layer.selected;
    if (selected) {
      const index = selected.points.findIndex((candidate) => {
        const at = layer.map(layout, candidate);
        return at !== undefined && Math.hypot(at.x - position.x, at.y - position.y) <= this.tolerance;
      });
      if (index >= 0) {
        return this.startDrag(selected, index, point);
      }
    }
    const drawings = layer.drawings;
    for (let i = drawings.length - 1; i >= 0; i--) {
      const drawing = drawings[i] as Drawing;
      const shapes = buildShapes(layer, layout, drawing.kind, drawing.points);
      if (distanceToSegments(position, shapes.segments) <= this.tolerance) {
        layer.selected = drawing;
        return this.startDrag(drawing, -1, point);
      }
    }
    if (layer.selected) {
      layer.selected = undefined;
    }
    return 'ignored';
  }

  private startDrag(drawing: Drawing, index: number, point: DrawingPoint): ModifierResult {
    this.dragged = drawing;
    this.pointIndex = index;
    this.before = drawing.points;
    this.start = point;
    return 'capture';
  }

  private drag(layer: DrawingLayer, point: DrawingPoint): ModifierResult {
    const drawing = this.dragged as Drawing;
    const moved =
      this.pointIndex >= 0
        ? this.before.map((candidate, i) => (i === this.pointIndex ? point : candidate))
        : this.before.map((candidate) => ({
            x: candidate.x + (point.x - this.start.x),
            y: candidate.y + (point.y - this.start.y),
          }));
    drawing.setPoints(moved);
    layer.touch();
    return 'handled';
  }

  private finish(interaction: ChartInteraction, layer: DrawingLayer): ModifierResult {
    const drawing = this.dragged as Drawing;
    this.dragged = undefined;
    const after = drawing.points;
    if (JSON.stringify(after) !== JSON.stringify(this.before)) {
      interaction.history.recordEdit(pointsEdit(layer, drawing, this.before, after));
    }
    return 'release';
  }
}

/** Describes a drawing layer on the first axes of the chart and the modifier that draws with it. */
export function drawings(builder: ChartBuilder, created?: (layer: DrawingLayer) => void): ChartBuilder {
  let layer: DrawingLayer | undefined;
  return builder
    .addOverlay((chart) => {
      // The same layer again when the chart creates its overlays anew, so that no drawing is lost.
      const xAxis = chart.horizontalAxes[0] as Axis;
      const yAxis = chart.panes[0]?.axes[0] as Axis;
      if (layer?.xAxis !== xAxis) {
        layer = new DrawingLayer(xAxis, yAxis);
        created?.(layer);
      }
      return layer;
    })
    .addModifier(() => new DrawingModifier());
}
