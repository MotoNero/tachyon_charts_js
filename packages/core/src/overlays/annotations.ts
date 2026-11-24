// Annotations: lines across the plot, bands, boxes, texts, lines, arrows, markers and images at places of the data,
// with labels on plates, icons and dashes, as Annotation, AnnotationAppearance and AnnotationPainter of the .NET
// version.
import type { Axis } from '../axes/axis';
import type { Point } from '../input/primitives';
import { DipRect } from '../layout/chart-layout';
import type { Rgba8 } from '../render/types';
import type { TextFont } from '../text/engine';
import { ChartOverlay, type OverlayCanvas } from './chart-overlay';

const f = Math.fround;
const platePadding = 4;
const plateGap = 4;

/** Where along its line a label stands; `auto` lets the annotation choose. */
export type LabelPlace = 'auto' | 'start' | 'middle' | 'end';
/** On which side of its line a label stands; `auto` lets the annotation choose. */
export type LabelSide = 'auto' | 'before' | 'after';
/** How a label turns: level, along its line, or by an angle. */
export type LabelTurn = 'level' | 'alongLine' | 'angle';
/** A sign before the text of a label. */
export type LabelIcon = 'none' | 'warning' | 'info' | 'arrow' | 'marker';
/** How a line is drawn. */
export type LineDash = 'solid' | 'dashed' | 'dotted';

/** A symbol of a font before the text of a label, such as a Material Symbol. */
export interface AnnotationSymbol {
  /** The glyph. */
  readonly glyph: string;
  /** The font of the glyph. */
  readonly font: TextFont;
  /** The size; 0.9 lines of the label when left out. */
  readonly size?: number;
}

/** How an annotation and its label look; everything left out keeps the plain look. */
export interface AnnotationAppearance {
  /** Where along the line the label stands. */
  readonly labelPlace?: LabelPlace;
  /** On which side of the line the label stands. */
  readonly labelSide?: LabelSide;
  /** The distance of the label from the line beyond the usual gap. */
  readonly labelOffset?: number;
  /** The size of the text. */
  readonly labelSize?: number;
  /** The font of the text. */
  readonly labelFont?: TextFont;
  /** The color of the text. */
  readonly labelColor?: Rgba8;
  /** The color of the plate; a clear color for none. */
  readonly labelFill?: Rgba8;
  /** The color of the frame of the plate. */
  readonly labelBorder?: Rgba8;
  /** The thickness of the frame; 1 by default. */
  readonly labelBorderThickness?: number;
  /** How the label turns. */
  readonly labelTurn?: LabelTurn;
  /** The angle of a turned label in degrees, counterclockwise. */
  readonly labelAngle?: number;
  /** A sign before the text. */
  readonly labelIcon?: LabelIcon;
  /** A symbol of a font before the text, instead of a sign. */
  readonly labelSymbol?: AnnotationSymbol;
  /** The color of the sign or the symbol. */
  readonly labelIconColor?: Rgba8;
  /** How the line is drawn. */
  readonly dash?: LineDash;
  /** The thickness of the line. */
  readonly thickness?: number;
}

// Whether a label keeps the plain look of the annotation.
function isPlainLabel(look: AnnotationAppearance): boolean {
  return (
    (look.labelPlace ?? 'auto') === 'auto' &&
    (look.labelSide ?? 'auto') === 'auto' &&
    (look.labelOffset ?? 0) === 0 &&
    look.labelSize === undefined &&
    look.labelFont === undefined &&
    look.labelColor === undefined &&
    look.labelFill === undefined &&
    look.labelBorder === undefined &&
    (look.labelTurn ?? 'level') === 'level' &&
    (look.labelIcon ?? 'none') === 'none' &&
    look.labelSymbol === undefined
  );
}

const add = (a: Point, b: Point): Point => ({ x: f(a.x + b.x), y: f(a.y + b.y) });
const scaled = (a: Point, factor: number): Point => ({ x: f(a.x * factor), y: f(a.y * factor) });
const dot = (a: Point, b: Point): number => f(f(a.x * b.x) + f(a.y * b.y));

/** @internal Draws a line solid, dashed or dotted. */
export function drawDashedLine(
  canvas: OverlayCanvas,
  a: Point,
  b: Point,
  width: number,
  color: Rgba8,
  dash: LineDash,
): void {
  if (dash === 'solid') {
    canvas.drawLine(a, b, width, color);
    return;
  }
  const length = f(Math.hypot(f(b.x - a.x), f(b.y - a.y)));
  if (length <= 0) {
    return;
  }
  const direction = { x: f(f(b.x - a.x) / length), y: f(f(b.y - a.y) / length) };
  const on = dash === 'dashed' ? f(6 * Math.max(1, width)) : f(Math.max(1.5, width));
  const off = dash === 'dashed' ? f(4 * Math.max(1, width)) : f(3 * Math.max(1, width));
  for (let at = 0; at < length; at = f(at + f(on + off))) {
    canvas.drawLine(
      add(a, scaled(direction, at)),
      add(a, scaled(direction, Math.min(f(at + on), length))),
      width,
      color,
    );
  }
}

// Text turned by more than a quarter would stand on its head; it turns the other way round.
function readable(angle: number): number {
  if (angle > f(f(Math.PI / 2) - f(0.001))) {
    return f(angle - f(Math.PI));
  }
  return angle < f(-f(Math.PI / 2) - f(0.001)) ? f(angle + f(Math.PI)) : angle;
}

/** @internal Draws a label on a plate beside a line from `from` to `to`, as AnnotationPainter.Label of the .NET version. */
export function drawAnnotationLabel(
  canvas: OverlayCanvas,
  text: string,
  from: Point,
  to: Point,
  look: AnnotationAppearance,
  color: Rgba8,
  place: LabelPlace,
  side: LabelSide,
  defaultSize?: number,
  defaultFill?: Rgba8,
): void {
  const size = look.labelSize ?? defaultSize ?? canvas.labelSize;
  const font = look.labelFont;
  const along = { x: f(to.x - from.x), y: f(to.y - from.y) };
  const lengthSquared = dot(along, along);
  const alongLength = f(Math.sqrt(lengthSquared));
  const direction = lengthSquared > 0 ? { x: f(along.x / alongLength), y: f(along.y / alongLength) } : { x: 1, y: 0 };
  const before = { x: direction.y, y: f(-direction.x) };
  const chosenSide = (look.labelSide ?? 'auto') === 'auto' ? side : look.labelSide;
  const normal = chosenSide === 'before' ? before : { x: f(-before.x), y: f(-before.y) };
  const chosenPlace = (look.labelPlace ?? 'auto') === 'auto' ? place : look.labelPlace;
  let t = 1;
  if (chosenPlace === 'start') {
    t = 0;
  } else if (chosenPlace === 'middle') {
    t = 0.5;
  }
  const anchor = add(from, scaled(along, t));
  // The text reads from the left or from below; the angle turns clockwise on the screen.
  let angle = 0;
  if (look.labelTurn === 'alongLine') {
    angle = readable(f(Math.atan2(direction.y, direction.x)));
  } else if (look.labelTurn === 'angle') {
    angle = f((-(look.labelAngle ?? 0) * Math.PI) / 180);
  }
  const u = { x: f(Math.cos(angle)), y: f(Math.sin(angle)) };
  const v = { x: f(-f(Math.sin(angle))), y: f(Math.cos(angle)) };
  let height = f(canvas.lineHeight(size, font) + 2);
  const symbol = look.labelSymbol;
  const symbolSize = symbol ? (symbol.size ?? f(height * f(0.9))) : 0;
  height = Math.max(height, f(symbolSize + 2));
  let icon = 0;
  if (symbol) {
    icon = f(symbolSize + 2);
  } else if ((look.labelIcon ?? 'none') !== 'none') {
    icon = f(height * f(0.8));
  }
  const width = f(f(canvas.measureWidth(text, size, font) + platePadding * 2) + icon);
  const halfWidth = f(width / 2);
  const halfHeight = f(height / 2);
  // The middle of the plate: beside the line by half its extent across it, and along it from the chosen end.
  const reach = (towards: Point): number =>
    f(f(Math.abs(dot(towards, u)) * halfWidth) + f(Math.abs(dot(towards, v)) * halfHeight));
  const offset = f(f(plateGap + f(look.labelOffset ?? 0)) + reach(normal));
  let alongFromEnd = 0;
  if (t === 0) {
    alongFromEnd = f(reach(direction) + plateGap);
  } else if (t === 1) {
    alongFromEnd = f(-f(reach(direction) + plateGap));
  }
  let center = add(add(anchor, scaled(normal, offset)), scaled(direction, alongFromEnd));
  center = keepInside(canvas, center, reach({ x: 1, y: 0 }), reach({ x: 0, y: 1 }));
  const corner = (x: number, y: number): Point => add(add(center, scaled(u, x)), scaled(v, y));
  const fill = look.labelFill ?? defaultFill ?? color;
  const clip = canvas.clip;
  canvas.clip = undefined;
  const corners = [
    corner(-halfWidth, -halfHeight),
    corner(halfWidth, -halfHeight),
    corner(halfWidth, halfHeight),
    corner(-halfWidth, halfHeight),
  ];
  if (fill.a > 0) {
    canvas.fillPolygon(corners, fill);
  }
  const border = look.labelBorder;
  if (border) {
    for (let i = 0; i < corners.length; i++) {
      canvas.drawLine(
        corners[i] as Point,
        corners[(i + 1) % corners.length] as Point,
        look.labelBorderThickness ?? 1,
        border,
      );
    }
  }
  const ink = look.labelColor ?? (fill.a > 0 ? canvas.colors.background : color);
  const iconMiddle = corner(f(f(-halfWidth + platePadding) + f(icon / 2)), 0);
  if (symbol) {
    // A symbol fills its em above the baseline, centered on its middle.
    canvas.drawTurnedText(
      symbol.glyph,
      iconMiddle,
      angle,
      symbolSize,
      look.labelIconColor ?? ink,
      f(symbolSize / 2),
      symbol.font,
    );
  } else if (icon > 0) {
    drawIcon(
      canvas,
      look.labelIcon ?? 'none',
      iconMiddle,
      f(icon * f(0.8)),
      u,
      v,
      look.labelIconColor ?? ink,
      fill.a > 0 ? { ...fill, a: 255 } : canvas.colors.background,
    );
  }
  const textMiddle = corner(f(icon / 2), 0);
  if (angle === 0) {
    const textWidth = canvas.measureWidth(text, size, font);
    canvas.drawText(text, textMiddle.x - textWidth / 2, textMiddle.y + height / 2 - height * 0.28, size, ink, font);
  } else {
    canvas.drawTurnedText(text, textMiddle, angle, size, ink, undefined, font);
  }
  canvas.clip = clip;
}

function keepInside(canvas: OverlayCanvas, center: Point, halfWidth: number, halfHeight: number): Point {
  const width = f(canvas.chartWidth);
  const height = f(canvas.chartHeight);
  const x =
    width > f(halfWidth * 2) + 4
      ? Math.min(Math.max(center.x, f(halfWidth + 2)), f(f(width - halfWidth) - 2))
      : center.x;
  const y =
    height > f(halfHeight * 2) + 4
      ? Math.min(Math.max(center.y, f(halfHeight + 2)), f(f(height - halfHeight) - 2))
      : center.y;
  return { x, y };
}

// The signs, drawn from triangles in the frame of the label.
function drawIcon(
  canvas: OverlayCanvas,
  icon: LabelIcon,
  middle: Point,
  size: number,
  u: Point,
  v: Point,
  color: Rgba8,
  cut: Rgba8,
): void {
  const half = f(size / 2);
  const at = (x: number, y: number): Point => add(add(middle, scaled(u, f(x))), scaled(v, f(y)));
  switch (icon) {
    case 'warning': {
      canvas.fillPolygon([at(0, -half), at(half, half), at(-half, half)], color);
      // An exclamation mark cut out of the triangle.
      const line = Math.max(f(1.2), f(size / 8));
      canvas.drawLine(at(0, f(-half * f(0.25))), at(0, f(half * f(0.4))), line, cut);
      canvas.drawLine(at(0, f(half * f(0.58))), at(0, f(half * f(0.75))), line, cut);
      break;
    }
    case 'info': {
      const steps = 24;
      const disc: Point[] = [];
      for (let i = 0; i < steps; i++) {
        const turn = f(f(i * f(Math.PI * 2)) / steps);
        disc.push(at(f(f(Math.cos(turn)) * half), f(f(Math.sin(turn)) * half)));
      }
      canvas.fillPolygon(disc, color);
      // An "i" cut out of the disc.
      const stroke = Math.max(f(1.2), f(size / 7));
      canvas.drawLine(at(0, f(-half * f(0.12))), at(0, f(half * f(0.6))), stroke, cut);
      canvas.drawLine(at(0, f(-half * f(0.55))), at(0, f(-half * f(0.35))), stroke, cut);
      break;
    }
    case 'arrow':
      canvas.drawLine(at(-half, 0), at(0, 0), Math.max(f(1.5), f(size / 5)), color);
      canvas.fillPolygon([at(0, f(-half * f(0.7))), at(half, 0), at(0, f(half * f(0.7)))], color);
      break;
    case 'marker': {
      const side = f(half * f(0.8));
      canvas.fillPolygon([at(-side, -side), at(side, -side), at(side, side), at(-side, side)], color);
      break;
    }
    default:
      break;
  }
}

function sameRect(a: DipRect, b: DipRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Something marked on a chart at places of its data or of the plot. */
export abstract class Annotation extends ChartOverlay {
  /** Called while an edit changes the annotation. */
  onEdited: ((annotation: Annotation) => void) | undefined;
  /** Called when an edit ends. */
  onEditFinished: ((annotation: Annotation) => void) | undefined;
  /** Whether the edit modifier may move and resize the annotation. */
  isEditable = false;
  private colorValue: Rgba8 = { r: 240, g: 190, b: 90, a: 255 };
  private look: AnnotationAppearance = {};
  private bounds: DipRect | undefined;
  private handles: DipRect[] = [];
  private hot = false;

  /**
   * @param xAxis - The horizontal axis of the data, if the annotation has a place along it.
   * @param yAxis - The vertical axis of the data, if the annotation has a place along it.
   */
  constructor(
    /** The horizontal axis of the data, if any. */
    readonly xAxis: Axis | undefined,
    /** The vertical axis of the data, if any. */
    readonly yAxis: Axis | undefined,
  ) {
    super();
  }

  /** The color. */
  get color(): Rgba8 {
    return this.colorValue;
  }

  set color(value: Rgba8) {
    this.colorValue = value;
    this.changed();
  }

  /** How the annotation and its label look. */
  get appearance(): AnnotationAppearance {
    return this.look;
  }

  set appearance(value: AnnotationAppearance) {
    this.look = value;
    this.changed();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + (this.xAxis?.version ?? 0) + (this.yAxis?.version ?? 0);
  }

  /** The area of the last frame in device-independent units, if drawn. */
  get lastBounds(): DipRect | undefined {
    return this.bounds;
  }

  /** @internal Whether the pointer rests on the annotation, which then shows its handles. */
  get isHot(): boolean {
    return this.hot;
  }

  set isHot(value: boolean) {
    if (value !== this.hot) {
      this.hot = value;
      this.changed();
    }
  }

  /** Whether a position lies on the annotation, within a tolerance. */
  contains(position: Point, tolerance: number): boolean {
    const bounds = this.bounds;
    return (
      bounds !== undefined &&
      position.x >= bounds.x - tolerance &&
      position.x <= bounds.right + tolerance &&
      position.y >= bounds.y - tolerance &&
      position.y <= bounds.bottom + tolerance
    );
  }

  /** Moves the annotation by distances in the units of its axes. */
  abstract move(deltaX: number, deltaY: number): void;

  /** Changes the size by distances in the units of its axes; false for annotations without a size. */
  resize(_deltaX: number, _deltaY: number): boolean {
    return false;
  }

  /** @internal The handle at a position, -1 for none. */
  handleAt(position: Point, tolerance: number): number {
    return this.handles.findIndex(
      (area) =>
        position.x >= area.x - tolerance &&
        position.x <= area.right + tolerance &&
        position.y >= area.y - tolerance &&
        position.y <= area.bottom + tolerance,
    );
  }

  /** Moves a handle by distances in the units of the axes. */
  moveHandle(_handle: number, _deltaX: number, _deltaY: number): void {
    // Annotations without handles stay as they are.
  }

  /** The state an edit can return to with {@link Annotation.restore}. */
  capture(): unknown {
    return undefined;
  }

  /** Returns to a state of {@link Annotation.capture}. */
  restore(_state: unknown): void {
    // Annotations without a state stay as they are.
  }

  /** @internal Tells the listener that an edit changed the annotation. */
  notifyEdited(): void {
    this.onEdited?.(this);
  }

  /** @internal Tells the listener that an edit ended. */
  notifyEditFinished(): void {
    this.onEditFinished?.(this);
  }

  /** Sets the areas of the handles of the last frame. */
  protected setHandles(...areas: DipRect[]): void {
    if (areas.length !== this.handles.length || areas.some((area, i) => !sameRect(area, this.handles[i] as DipRect))) {
      this.handles = areas;
    }
  }

  /** Draws the handles at points while the annotation is editable and the pointer rests on it. */
  protected drawHandles(canvas: OverlayCanvas, points: readonly Point[]): void {
    if (!this.isEditable || !this.hot) {
      return;
    }
    const half = 4;
    for (const point of points) {
      const square = new DipRect(point.x - half, point.y - half, half * 2, half * 2);
      canvas.fillRectangle(square, canvas.colors.background);
      canvas.drawRectangle(square, this.colorValue);
    }
  }

  /** A place of the data in device-independent units of the chart. */
  protected toChart(canvas: OverlayCanvas, x: number, y: number): Point {
    const alongX = this.xAxis ? (canvas.positionOf(this.xAxis, x) ?? x) : x;
    const alongY = this.yAxis ? (canvas.positionOf(this.yAxis, y) ?? y) : y;
    // With the X axis down, X goes up and down on the screen and Y across.
    return this.isTurned ? { x: f(alongY), y: f(alongX) } : { x: f(alongX), y: f(alongY) };
  }

  /** Whether the X axis runs up and down. */
  protected get isTurned(): boolean {
    return this.xAxis?.isHorizontal === false || this.yAxis?.isHorizontal === true;
  }

  /** Draws a line across the plot at a value of an axis, with its label. */
  protected drawAcross(canvas: OverlayCanvas, axis: Axis, value: number, label: string | undefined): void {
    const plot = canvas.layout.plotArea;
    const at = canvas.positionOf(axis, value);
    if (at === undefined) {
      return;
    }
    canvas.clip = plot;
    const from = axis.isHorizontal ? { x: f(at), y: f(plot.y) } : { x: f(plot.x), y: f(at) };
    const to = axis.isHorizontal ? { x: f(at), y: f(plot.bottom) } : { x: f(plot.right), y: f(at) };
    drawDashedLine(canvas, from, to, this.look.thickness ?? 1, this.colorValue, this.look.dash ?? 'solid');
    this.setBounds(
      axis.isHorizontal ? new DipRect(at, plot.y, 1, plot.height) : new DipRect(plot.x, at, plot.width, 1),
    );
    if (label === undefined) {
      return;
    }
    if (!isPlainLabel(this.look)) {
      drawAnnotationLabel(
        canvas,
        label,
        from,
        to,
        this.look,
        this.colorValue,
        axis.isHorizontal ? 'start' : 'end',
        'before',
      );
      return;
    }
    // A label at the top of an upright line, at the right end of a level one.
    const width = canvas.measureWidth(label, canvas.labelSize) + 8;
    if (axis.isHorizontal) {
      canvas.drawLabel(label, at + 4, plot.y + 4, this.colorValue, canvas.colors.background);
    } else {
      canvas.drawLabel(
        label,
        plot.right - width - 4,
        at - canvas.lineHeight(canvas.labelSize) - 3,
        this.colorValue,
        canvas.colors.background,
      );
    }
  }

  /** Draws the edges of an area in the dash of the appearance. */
  protected drawEdges(canvas: OverlayCanvas, area: DipRect, width: number, color: Rgba8): void {
    const a = { x: f(area.x), y: f(area.y) };
    const b = { x: f(area.right), y: f(area.y) };
    const c = { x: f(area.right), y: f(area.bottom) };
    const d = { x: f(area.x), y: f(area.bottom) };
    const dash = this.look.dash ?? 'solid';
    drawDashedLine(canvas, a, b, width, color, dash);
    drawDashedLine(canvas, b, c, width, color, dash);
    drawDashedLine(canvas, c, d, width, color, dash);
    drawDashedLine(canvas, d, a, width, color, dash);
  }

  /** Keeps the area of the frame for hit tests. */
  protected setBounds(bounds: DipRect): void {
    if (!this.bounds || !sameRect(this.bounds, bounds)) {
      this.bounds = bounds;
    }
  }
}

/** @internal The area between two points. */
export function spanOf(a: Point, b: Point): DipRect {
  return new DipRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(f(a.x - b.x)), Math.abs(f(a.y - b.y)));
}

const pointArea = (point: Point): DipRect => new DipRect(point.x, point.y, 0, 0);

/** A level line across the plot at a value of a vertical axis, with a label. */
export class HorizontalLineAnnotation extends Annotation {
  /** The label, if any. */
  label: string | undefined;
  private value = 0;

  /** @param yAxis - The vertical axis. */
  constructor(yAxis: Axis) {
    super(undefined, yAxis);
  }

  /** The value of the line. */
  get y(): number {
    return this.value;
  }

  set y(value: number) {
    this.value = value;
    this.changed();
  }

  /** {@inheritDoc Annotation.move} */
  move(_deltaX: number, deltaY: number): void {
    this.y = this.value + deltaY;
  }

  /** {@inheritDoc Annotation.capture} */
  override capture(): unknown {
    return this.value;
  }

  /** {@inheritDoc Annotation.restore} */
  override restore(state: unknown): void {
    this.y = state as number;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    this.drawAcross(canvas, this.yAxis as Axis, this.value, this.label);
  }
}

/** An upright line across the plot at a value of a horizontal axis, with a label. */
export class VerticalLineAnnotation extends Annotation {
  /** The label, if any. */
  label: string | undefined;
  private value = 0;

  /** @param xAxis - The horizontal axis. */
  constructor(xAxis: Axis) {
    super(xAxis, undefined);
  }

  /** The value of the line. */
  get x(): number {
    return this.value;
  }

  set x(value: number) {
    this.value = value;
    this.changed();
  }

  /** {@inheritDoc Annotation.move} */
  move(deltaX: number): void {
    this.x = this.value + deltaX;
  }

  /** {@inheritDoc Annotation.capture} */
  override capture(): unknown {
    return this.value;
  }

  /** {@inheritDoc Annotation.restore} */
  override restore(state: unknown): void {
    this.x = state as number;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    this.drawAcross(canvas, this.xAxis as Axis, this.value, this.label);
  }
}

/** A rectangle between two corners in the data, filled and framed, with a label. */
export class BoxAnnotation extends Annotation {
  /** The fill. */
  fill: Rgba8 = { r: 240, g: 190, b: 90, a: 40 };
  /** The label, if any. */
  label: string | undefined;
  private corners: [number, number, number, number] = [0, 0, 0, 0];

  /** The first corner. */
  get first(): { x: number; y: number } {
    return { x: this.corners[0], y: this.corners[1] };
  }

  /** The second corner. */
  get second(): { x: number; y: number } {
    return { x: this.corners[2], y: this.corners[3] };
  }

  /** Sets both corners. */
  setCorners(x1: number, y1: number, x2: number, y2: number): void {
    this.corners = [x1, y1, x2, y2];
    this.changed();
  }

  /** {@inheritDoc Annotation.move} */
  move(deltaX: number, deltaY: number): void {
    const [x1, y1, x2, y2] = this.corners;
    this.setCorners(x1 + deltaX, y1 + deltaY, x2 + deltaX, y2 + deltaY);
  }

  /** {@inheritDoc Annotation.resize} */
  override resize(deltaX: number, deltaY: number): boolean {
    const [x1, y1, x2, y2] = this.corners;
    this.setCorners(x1, y1, x2 + deltaX, y2 + deltaY);
    return true;
  }

  /** {@inheritDoc Annotation.moveHandle} */
  override moveHandle(handle: number, deltaX: number, deltaY: number): void {
    let [x1, y1, x2, y2] = this.corners;
    switch (handle) {
      case 0:
        x1 += deltaX;
        y1 += deltaY;
        break;
      case 1:
        x2 += deltaX;
        y1 += deltaY;
        break;
      case 2:
        x2 += deltaX;
        y2 += deltaY;
        break;
      case 3:
        x1 += deltaX;
        y2 += deltaY;
        break;
      case 4:
        x1 += deltaX;
        break;
      case 5:
        x2 += deltaX;
        break;
      case 6:
        y1 += deltaY;
        break;
      case 7:
        y2 += deltaY;
        break;
      default:
        return;
    }
    this.setCorners(x1, y1, x2, y2);
  }

  /** {@inheritDoc Annotation.capture} */
  override capture(): unknown {
    return [...this.corners];
  }

  /** {@inheritDoc Annotation.restore} */
  override restore(state: unknown): void {
    const [x1, y1, x2, y2] = state as [number, number, number, number];
    this.setCorners(x1, y1, x2, y2);
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const [x1, y1, x2, y2] = this.corners;
    const a = this.toChart(canvas, x1, y1);
    const b = this.toChart(canvas, x2, y1);
    const c = this.toChart(canvas, x2, y2);
    const d = this.toChart(canvas, x1, y2);
    const area = spanOf(a, c);
    canvas.clip = canvas.layout.plotArea;
    canvas.fillRectangle(area, this.fill);
    const look = this.appearance;
    if (look.thickness === undefined && (look.dash ?? 'solid') === 'solid') {
      canvas.drawRectangle(area, this.color);
    } else {
      this.drawEdges(canvas, area, look.thickness ?? 1, this.color);
    }
    this.setBounds(area);
    if (this.label !== undefined && this.label.length > 0) {
      const top = f(area.y);
      drawAnnotationLabel(
        canvas,
        this.label,
        { x: f(area.x), y: top },
        { x: f(area.right), y: top },
        look,
        this.color,
        'start',
        'after',
      );
    }
    this.setHandles(
      pointArea(a),
      pointArea(b),
      pointArea(c),
      pointArea(d),
      spanOf(a, d),
      spanOf(b, c),
      spanOf(a, b),
      spanOf(d, c),
    );
    this.drawHandles(canvas, [a, b, c, d]);
  }
}

/** A band across the plot between two values of one axis, with a label. */
export class BandAnnotation extends Annotation {
  /** The label, if any. */
  label: string | undefined;
  private range: [number, number] = [0, 0];

  /** @param axis - The axis of the values: horizontal for an upright band, vertical for a level one. */
  constructor(private readonly axis: Axis) {
    super(axis.isHorizontal ? axis : undefined, axis.isHorizontal ? undefined : axis);
  }

  /** The first value. */
  get start(): number {
    return this.range[0];
  }

  /** The second value. */
  get end(): number {
    return this.range[1];
  }

  /** Sets both values. */
  setRange(start: number, end: number): void {
    this.range = [start, end];
    this.changed();
  }

  /** {@inheritDoc Annotation.move} */
  move(deltaX: number, deltaY: number): void {
    const delta = this.axis.isHorizontal ? deltaX : deltaY;
    this.setRange(this.range[0] + delta, this.range[1] + delta);
  }

  /** {@inheritDoc Annotation.resize} */
  override resize(deltaX: number, deltaY: number): boolean {
    this.setRange(this.range[0], this.range[1] + (this.axis.isHorizontal ? deltaX : deltaY));
    return true;
  }

  /** {@inheritDoc Annotation.moveHandle} */
  override moveHandle(handle: number, deltaX: number, deltaY: number): void {
    const delta = this.axis.isHorizontal ? deltaX : deltaY;
    if (handle === 0) {
      this.setRange(this.range[0] + delta, this.range[1]);
    } else if (handle === 1) {
      this.setRange(this.range[0], this.range[1] + delta);
    }
  }

  /** {@inheritDoc Annotation.capture} */
  override capture(): unknown {
    return [...this.range];
  }

  /** {@inheritDoc Annotation.restore} */
  override restore(state: unknown): void {
    const [start, end] = state as [number, number];
    this.setRange(start, end);
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const plot = canvas.layout.plotArea;
    const axis = this.axis;
    const first = canvas.positionOf(axis, this.range[0]);
    const second = canvas.positionOf(axis, this.range[1]);
    if (first === undefined || second === undefined) {
      return;
    }
    const low = Math.min(first, second);
    const length = Math.abs(second - first);
    const area = axis.isHorizontal
      ? new DipRect(low, plot.y, length, plot.height)
      : new DipRect(plot.x, low, plot.width, length);
    canvas.clip = plot;
    canvas.fillRectangle(area, this.color);
    const look = this.appearance;
    const edge = look.thickness;
    if (edge !== undefined) {
      const opaque = { ...this.color, a: 255 };
      const dash = look.dash ?? 'solid';
      for (const at of [first, second]) {
        const from = axis.isHorizontal ? { x: f(at), y: f(plot.y) } : { x: f(plot.x), y: f(at) };
        const to = axis.isHorizontal ? { x: f(at), y: f(plot.bottom) } : { x: f(plot.right), y: f(at) };
        drawDashedLine(canvas, from, to, edge, opaque, dash);
      }
    }
    this.setBounds(area);
    if (this.label !== undefined && this.label.length > 0) {
      const top = f(area.y);
      drawAnnotationLabel(
        canvas,
        this.label,
        { x: f(area.x), y: top },
        { x: f(area.right), y: top },
        look,
        { ...this.color, a: 255 },
        'start',
        'after',
      );
    }
    // The edges of the start and the end, each as a line across the plot.
    this.setHandles(
      axis.isHorizontal ? new DipRect(first, plot.y, 0, plot.height) : new DipRect(plot.x, first, plot.width, 0),
      axis.isHorizontal ? new DipRect(second, plot.y, 0, plot.height) : new DipRect(plot.x, second, plot.width, 0),
    );
    const middle = axis.isHorizontal ? f(plot.y + plot.height / 2) : f(plot.x + plot.width / 2);
    this.drawHandles(
      canvas,
      axis.isHorizontal
        ? [
            { x: f(first), y: middle },
            { x: f(second), y: middle },
          ]
        : [
            { x: middle, y: f(first) },
            { x: middle, y: f(second) },
          ],
    );
  }
}

/** A text at a place of the data. */
export class TextAnnotation extends Annotation {
  /** The text. */
  text = '';
  /** The size of the text; 13 by default. */
  fontSize = 13;
  private place = { x: 0, y: 0 };

  /** The place. */
  get position(): { x: number; y: number } {
    return this.place;
  }

  /** Moves the text to a place. */
  moveTo(x: number, y: number): void {
    this.place = { x, y };
    this.changed();
  }

  /** {@inheritDoc Annotation.move} */
  move(deltaX: number, deltaY: number): void {
    this.moveTo(this.place.x + deltaX, this.place.y + deltaY);
  }

  /** {@inheritDoc Annotation.capture} */
  override capture(): unknown {
    return { ...this.place };
  }

  /** {@inheritDoc Annotation.restore} */
  override restore(state: unknown): void {
    const { x, y } = state as { x: number; y: number };
    this.moveTo(x, y);
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const position = this.toChart(canvas, this.place.x, this.place.y);
    const look = this.appearance;
    if (!isPlainLabel(look)) {
      // From the place to the right: the text stands after it, turned and on a plate as the appearance asks.
      drawAnnotationLabel(
        canvas,
        this.text,
        position,
        { x: f(position.x + 1), y: position.y },
        look,
        this.color,
        'start',
        'before',
        this.fontSize,
        { r: 0, g: 0, b: 0, a: 0 },
      );
      const size = look.labelSize ?? this.fontSize;
      const font = look.labelFont;
      const height = canvas.lineHeight(size, font);
      this.setBounds(
        new DipRect(position.x, position.y - height, canvas.measureWidth(this.text, size, font) + 16, height + 8),
      );
      return;
    }
    canvas.drawText(this.text, position.x, position.y, this.fontSize, this.color);
    const height = canvas.lineHeight(this.fontSize);
    this.setBounds(new DipRect(position.x, position.y - height, canvas.measureWidth(this.text, this.fontSize), height));
  }
}

/** A straight line between two places of the data, with a label. */
export class LineAnnotation extends Annotation {
  /** The thickness; 2 by default. */
  thickness = 2;
  /** The label, if any. */
  label: string | undefined;
  private points: [number, number, number, number] = [0, 0, 0, 0];
  private ends: [Point, Point] | undefined;

  /** The first end. */
  get start(): { x: number; y: number } {
    return { x: this.points[0], y: this.points[1] };
  }

  /** The second end. */
  get end(): { x: number; y: number } {
    return { x: this.points[2], y: this.points[3] };
  }

  /** Sets both ends. */
  setEnds(x1: number, y1: number, x2: number, y2: number): void {
    this.points = [x1, y1, x2, y2];
    this.changed();
  }

  /** {@inheritDoc Annotation.move} */
  move(deltaX: number, deltaY: number): void {
    const [x1, y1, x2, y2] = this.points;
    this.setEnds(x1 + deltaX, y1 + deltaY, x2 + deltaX, y2 + deltaY);
  }

  /** {@inheritDoc Annotation.moveHandle} */
  override moveHandle(handle: number, deltaX: number, deltaY: number): void {
    const [x1, y1, x2, y2] = this.points;
    if (handle === 0) {
      this.setEnds(x1 + deltaX, y1 + deltaY, x2, y2);
    } else if (handle === 1) {
      this.setEnds(x1, y1, x2 + deltaX, y2 + deltaY);
    }
  }

  /** {@inheritDoc Annotation.contains} */
  override contains(position: Point, tolerance: number): boolean {
    // Near the line itself, not anywhere in the rectangle it spans.
    const ends = this.ends;
    if (!ends) {
      return false;
    }
    const [a, b] = ends;
    const alongX = b.x - a.x;
    const alongY = b.y - a.y;
    const length = alongX * alongX + alongY * alongY;
    const share =
      length <= 0 ? 0 : Math.min(Math.max(((position.x - a.x) * alongX + (position.y - a.y) * alongY) / length, 0), 1);
    return (
      Math.hypot(position.x - (a.x + alongX * share), position.y - (a.y + alongY * share)) <= tolerance + this.thickness
    );
  }

  /** {@inheritDoc Annotation.capture} */
  override capture(): unknown {
    return [...this.points];
  }

  /** {@inheritDoc Annotation.restore} */
  override restore(state: unknown): void {
    const [x1, y1, x2, y2] = state as [number, number, number, number];
    this.setEnds(x1, y1, x2, y2);
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const [x1, y1, x2, y2] = this.points;
    const a = this.toChart(canvas, x1, y1);
    const b = this.toChart(canvas, x2, y2);
    this.ends = [a, b];
    canvas.clip = canvas.layout.plotArea;
    const look = this.appearance;
    drawDashedLine(canvas, a, b, look.thickness ?? this.thickness, this.color, look.dash ?? 'solid');
    this.setBounds(spanOf(a, b));
    this.setHandles(pointArea(a), pointArea(b));
    this.drawHandles(canvas, [a, b]);
    if (this.label !== undefined && this.label.length > 0) {
      if (isPlainLabel(look)) {
        canvas.drawLabel(
          this.label,
          b.x + 6,
          b.y - canvas.lineHeight(canvas.labelSize) - 2,
          this.color,
          canvas.colors.background,
        );
      } else {
        drawAnnotationLabel(canvas, this.label, a, b, look, this.color, 'end', 'before');
      }
    }
  }
}

const headLength = 10;
const headWidth = 5;

/** An arrow from a place of the data to another, the tip at the second. */
export class ArrowAnnotation extends Annotation {
  /** The thickness; 2 by default. */
  thickness = 2;
  private points: [number, number, number, number] = [0, 0, 0, 0];

  /** The start. */
  get start(): { x: number; y: number } {
    return { x: this.points[0], y: this.points[1] };
  }

  /** The tip. */
  get tip(): { x: number; y: number } {
    return { x: this.points[2], y: this.points[3] };
  }

  /** Sets start and tip. */
  setEnds(x1: number, y1: number, x2: number, y2: number): void {
    this.points = [x1, y1, x2, y2];
    this.changed();
  }

  /** {@inheritDoc Annotation.move} */
  move(deltaX: number, deltaY: number): void {
    const [x1, y1, x2, y2] = this.points;
    this.setEnds(x1 + deltaX, y1 + deltaY, x2 + deltaX, y2 + deltaY);
  }

  /** {@inheritDoc Annotation.resize} */
  override resize(deltaX: number, deltaY: number): boolean {
    const [x1, y1, x2, y2] = this.points;
    this.setEnds(x1, y1, x2 + deltaX, y2 + deltaY);
    return true;
  }

  /** {@inheritDoc Annotation.moveHandle} */
  override moveHandle(handle: number, deltaX: number, deltaY: number): void {
    const [x1, y1, x2, y2] = this.points;
    if (handle === 0) {
      this.setEnds(x1 + deltaX, y1 + deltaY, x2, y2);
    } else if (handle === 1) {
      this.setEnds(x1, y1, x2 + deltaX, y2 + deltaY);
    }
  }

  /** {@inheritDoc Annotation.capture} */
  override capture(): unknown {
    return [...this.points];
  }

  /** {@inheritDoc Annotation.restore} */
  override restore(state: unknown): void {
    const [x1, y1, x2, y2] = state as [number, number, number, number];
    this.setEnds(x1, y1, x2, y2);
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const [x1, y1, x2, y2] = this.points;
    const start = this.toChart(canvas, x1, y1);
    const tip = this.toChart(canvas, x2, y2);
    this.setBounds(spanOf(start, tip));
    this.setHandles(pointArea(start), pointArea(tip));
    this.drawHandles(canvas, [start, tip]);
    const delta = { x: f(tip.x - start.x), y: f(tip.y - start.y) };
    const length = f(Math.sqrt(dot(delta, delta)));
    if (length < 1) {
      return;
    }
    const direction = { x: f(delta.x / length), y: f(delta.y / length) };
    const normal = { x: f(-direction.y * headWidth), y: f(direction.x * headWidth) };
    const neck = {
      x: f(tip.x - f(direction.x * Math.min(headLength, length))),
      y: f(tip.y - f(direction.y * Math.min(headLength, length))),
    };
    canvas.drawLine(start, neck, this.thickness, this.color);
    canvas.fillTriangle(tip, add(neck, normal), { x: f(neck.x - normal.x), y: f(neck.y - normal.y) }, this.color);
  }
}

/** A diamond at a place of the data. */
export class MarkerAnnotation extends Annotation {
  /** The size; 12 by default. */
  size = 12;
  private place = { x: 0, y: 0 };

  /** The place. */
  get position(): { x: number; y: number } {
    return this.place;
  }

  /** Moves the marker to a place. */
  moveTo(x: number, y: number): void {
    this.place = { x, y };
    this.changed();
  }

  /** {@inheritDoc Annotation.move} */
  move(deltaX: number, deltaY: number): void {
    this.moveTo(this.place.x + deltaX, this.place.y + deltaY);
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const center = this.toChart(canvas, this.place.x, this.place.y);
    const half = f(this.size / 2);
    const top = { x: center.x, y: f(center.y - half) };
    const right = { x: f(center.x + half), y: center.y };
    const bottom = { x: center.x, y: f(center.y + half) };
    const left = { x: f(center.x - half), y: center.y };
    canvas.fillTriangle(top, right, bottom, this.color);
    canvas.fillTriangle(top, bottom, left, this.color);
    this.setBounds(new DipRect(center.x - half, center.y - half, this.size, this.size));
  }
}

/** Pixels at a place of the data or of the chart. */
export class ImageAnnotation extends Annotation {
  /** The size it is shown at; its size in pixels when left out. */
  displaySize: { width: number; height: number } | undefined;
  private place = { x: 0, y: 0 };

  /**
   * @param pixels - The pixels, RGBA rows from the top.
   * @param width - The width in pixels.
   * @param height - The height in pixels.
   * @param xAxis - The horizontal axis of the place; the chart in device-independent units when left out.
   * @param yAxis - The vertical axis of the place; the chart when left out.
   */
  constructor(
    private readonly pixels: Uint8Array,
    private readonly width: number,
    private readonly height: number,
    xAxis?: Axis,
    yAxis?: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** The place of the top left corner. */
  get position(): { x: number; y: number } {
    return this.place;
  }

  /** Moves the image to a place. */
  moveTo(x: number, y: number): void {
    this.place = { x, y };
    this.changed();
  }

  /** {@inheritDoc Annotation.move} */
  move(deltaX: number, deltaY: number): void {
    this.moveTo(this.place.x + deltaX, this.place.y + deltaY);
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const corner = this.toChart(canvas, this.place.x, this.place.y);
    const size = this.displaySize ?? { width: this.width, height: this.height };
    const area = new DipRect(corner.x, corner.y, size.width, size.height);
    canvas.drawImage(this, this.pixels, this.width, this.height, area);
    this.setBounds(area);
  }
}
