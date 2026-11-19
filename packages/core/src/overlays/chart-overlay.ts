// Things drawn above the series and the surface they draw on (ChartOverlay and OverlayCanvas of the .NET version).
import type { Axis } from '../axes/axis';
import { DipRect, type AxisPlacement, type ChartLayoutResult } from '../layout/chart-layout';
import { glyphStride, meshVertexStride, type CommandList } from '../render/commands';
import { packRgba8, type Rgba8 } from '../render/types';
import type { TextEngine } from '../text/engine';
import type { Point } from '../input/primitives';

const f = Math.fround;
const minimumLineLength = 1e-3;

/** Something drawn above the series, in device-independent units. */
export abstract class ChartOverlay {
  private changes = 0;

  /** Grows with every change that needs a new frame. */
  get version(): number {
    return this.changes;
  }

  /** Draws the overlay. */
  abstract draw(canvas: OverlayCanvas): void;

  /** Asks for a new frame. */
  protected changed(): void {
    this.changes++;
  }
}

/** The colors an overlay draws with, from the chart or its theme. */
export interface OverlayColors {
  /** Marks such as the snapped point; the color of the ticks. */
  readonly accent: Rgba8;
  /** Text; the color of the labels. */
  readonly text: Rgba8;
  /** The background of the chart. */
  readonly background: Rgba8;
  /** The lines of the crosshair. */
  readonly crosshair: Rgba8;
  /** The plate behind a value at an axis. */
  readonly crosshairLabelFill: Rgba8;
  /** The text on that plate. */
  readonly crosshairLabelText: Rgba8;
}

/** The surface of overlays. Coordinates are device-independent units relative to the chart. */
export class OverlayCanvas {
  /** Nothing is drawn outside of it; everywhere when left out. */
  clip: DipRect | undefined;
  private commands: CommandList | undefined;
  private currentLayout: ChartLayoutResult | undefined;
  private scale = 1;
  private width = 0;
  private colorSet: OverlayColors | undefined;
  private size = 11;
  private glyphData = new Float32Array(256 * glyphStride);
  private glyphTotal = 0;
  private shape = new Float32Array(64 * meshVertexStride);

  constructor(private readonly textEngine: TextEngine) {}

  /** The layout of the chart in this frame. */
  get layout(): ChartLayoutResult {
    return this.currentLayout as ChartLayoutResult;
  }

  /** The colors to draw with. */
  get colors(): OverlayColors {
    return this.colorSet as OverlayColors;
  }

  /** The size of the axis labels. */
  get labelSize(): number {
    return this.size;
  }

  /** The glyphs written this frame; the chart draws them after its own text. */
  get glyphs(): Float32Array {
    return this.glyphData;
  }

  /** The number of glyphs written this frame. */
  get glyphCount(): number {
    return this.glyphTotal;
  }

  /** Starts a frame; the chart calls it. */
  begin(
    commands: CommandList,
    layout: ChartLayoutResult,
    scale: number,
    chartWidth: number,
    colors: OverlayColors,
    labelSize: number,
  ): void {
    this.commands = commands;
    this.currentLayout = layout;
    this.scale = scale;
    this.width = chartWidth;
    this.colorSet = colors;
    this.size = labelSize;
    this.glyphTotal = 0;
    this.clip = undefined;
  }

  /** The height of a line of text. */
  lineHeight(size: number): number {
    return this.textEngine.lineHeight(size);
  }

  /** The width of a text. */
  measureWidth(text: string, size: number): number {
    return this.textEngine.measureWidth(text, size);
  }

  /** Writes a text with its baseline at `baseline`. */
  drawText(text: string, x: number, baseline: number, size: number, color: Rgba8): void {
    const needed = (this.glyphTotal + text.length) * glyphStride;
    if (needed > this.glyphData.length) {
      const grown = new Float32Array(Math.max(this.glyphData.length * 2, needed));
      grown.set(this.glyphData.subarray(0, this.glyphTotal * glyphStride));
      this.glyphData = grown;
    }
    this.glyphTotal += this.textEngine.layout(
      text,
      f(x * this.scale),
      f(baseline * this.scale),
      { size: f(size * this.scale), color },
      this.glyphData,
      this.glyphTotal,
    );
  }

  /** The position of a value along an axis, `undefined` for an axis not in the layout. */
  positionOf(axis: Axis, value: number): number | undefined {
    const placement = this.placementOf(axis);
    return placement ? transformOf(placement).toPixel(value) : undefined;
  }

  /** The place of a data point. */
  pointOf(xAxis: Axis, yAxis: Axis, x: number, y: number): Point | undefined {
    const along = this.positionOf(xAxis, x);
    const across = this.positionOf(yAxis, y);
    return along === undefined || across === undefined ? undefined : { x: f(along), y: f(across) };
  }

  /** The value of an axis at a position along it. */
  valueAt(axis: Axis, position: number): number | undefined {
    const placement = this.placementOf(axis);
    return placement ? transformOf(placement).toData(position) : undefined;
  }

  /** The pane at a position. */
  paneAt(position: Point): DipRect | undefined {
    return this.layout.panes.find(
      (pane) => position.y >= pane.y && position.y <= pane.bottom && position.x >= pane.x && position.x <= pane.right,
    );
  }

  /** Fills a rectangle, cut to the clip. */
  fillRectangle(area: DipRect, color: Rgba8): void {
    let target = area;
    const clip = this.clip;
    if (clip) {
      const left = Math.max(area.x, clip.x);
      const top = Math.max(area.y, clip.y);
      const right = Math.min(area.right, clip.right);
      const bottom = Math.min(area.bottom, clip.bottom);
      if (right <= left || bottom <= top) {
        return;
      }
      target = new DipRect(left, top, right - left, bottom - top);
    }
    this.commands?.fillRectangle(target.toPixels(this.scale), color);
  }

  /** Draws the outline of a rectangle, one unit wide. */
  drawRectangle(area: DipRect, color: Rgba8): void {
    this.fillRectangle(new DipRect(area.x, area.y, area.width, 1), color);
    this.fillRectangle(new DipRect(area.x, area.bottom - 1, area.width, 1), color);
    this.fillRectangle(new DipRect(area.x, area.y, 1, area.height), color);
    this.fillRectangle(new DipRect(area.right - 1, area.y, 1, area.height), color);
  }

  /** Draws a line; along the pixel grid as a rectangle, slanted as a polygon with smooth edges. */
  drawLine(from: Point, to: Point, width: number, color: Rgba8): void {
    const dx = f(to.x - from.x);
    const dy = f(to.y - from.y);
    const length = f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
    if (length < minimumLineLength) {
      return;
    }
    if (dx === 0 || dy === 0) {
      const left = Math.min(from.x, to.x);
      const top = Math.min(from.y, to.y);
      this.fillRectangle(
        dx === 0 ? new DipRect(left, top, width, Math.abs(dy)) : new DipRect(left, top, Math.abs(dx), width),
        color,
      );
      return;
    }
    const nx = f(f(f(-dy) / length) * f(width / 2));
    const ny = f(f(dx / length) * f(width / 2));
    this.fillPolygon(
      [
        { x: f(from.x + nx), y: f(from.y + ny) },
        { x: f(to.x + nx), y: f(to.y + ny) },
        { x: f(to.x - nx), y: f(to.y - ny) },
        { x: f(from.x - nx), y: f(from.y - ny) },
      ],
      color,
    );
  }

  /** Fills a convex shape: a slanted edge fades out over one pixel, an edge along the grid stays sharp. */
  fillPolygon(corners: readonly Point[], color: Rgba8): void {
    if (corners.length < 3 || !this.commands) {
      return;
    }
    const needed = ((corners.length - 2) * 3 + corners.length * 6) * meshVertexStride;
    if (this.shape.length < needed) {
      this.shape = new Float32Array(Math.max(this.shape.length * 2, needed));
    }
    const scale = f(this.scale);
    const points = corners.map((corner) => ({ x: f(corner.x * scale), y: f(corner.y * scale) }));
    let middleX = 0;
    let middleY = 0;
    for (const point of points) {
      middleX = f(middleX + point.x);
      middleY = f(middleY + point.y);
    }
    middleX = f(middleX / points.length);
    middleY = f(middleY / points.length);
    const solid = packRgba8(color);
    const clear = packRgba8({ ...color, a: 0 });
    const words = new Uint32Array(this.shape.buffer);
    let count = 0;
    const add = (x: number, y: number, word: number): void => {
      const at = count * meshVertexStride;
      this.shape[at] = x;
      this.shape[at + 1] = y;
      words[at + 2] = word;
      count++;
    };
    const first = points[0] as Point;
    for (let i = 1; i < points.length - 1; i++) {
      const [b, c] = [points[i] as Point, points[i + 1] as Point];
      add(first.x, first.y, solid);
      add(b.x, b.y, solid);
      add(c.x, c.y, solid);
    }
    for (let i = 0; i < points.length; i++) {
      const a = points[i] as Point;
      const b = points[(i + 1) % points.length] as Point;
      const alongX = f(b.x - a.x);
      const alongY = f(b.y - a.y);
      if (Math.abs(alongX) < 0.01 || Math.abs(alongY) < 0.01) {
        continue;
      }
      const length = f(Math.sqrt(f(f(alongY * alongY) + f(alongX * alongX))));
      let nx = f(alongY / length);
      let ny = f(-alongX / length);
      const towardsX = f(f(f(a.x + b.x) / 2) - middleX);
      const towardsY = f(f(f(a.y + b.y) / 2) - middleY);
      if (f(f(nx * towardsX) + f(ny * towardsY)) < 0) {
        nx = -nx;
        ny = -ny;
      }
      add(a.x, a.y, solid);
      add(b.x, b.y, solid);
      add(f(b.x + nx), f(b.y + ny), clear);
      add(a.x, a.y, solid);
      add(f(b.x + nx), f(b.y + ny), clear);
      add(f(a.x + nx), f(a.y + ny), clear);
    }
    this.commands.fillMesh(this.shape, count);
  }

  /** Writes a text on a plate that stays inside the chart; returns the plate. */
  drawLabel(text: string, x: number, y: number, background: Rgba8, foreground: Rgba8): DipRect {
    const padding = 4;
    const margin = 2;
    const width = this.measureWidth(text, this.size) + padding * 2;
    const height = this.lineHeight(this.size) + 2;
    const left = Math.max(Math.min(x, this.width - width - margin), margin);
    const plate = new DipRect(left, y, width, height);
    const clip = this.clip;
    this.clip = undefined;
    this.fillRectangle(plate, background);
    this.clip = clip;
    this.drawText(text, left + padding, y + height - height * 0.28, this.size, foreground);
    return plate;
  }

  private placementOf(axis: Axis): AxisPlacement | undefined {
    return this.layout.axes.find((placement) => placement.axis === axis);
  }
}

function transformOf(placement: AxisPlacement): ReturnType<Axis['createTransform']> {
  const { axis, bounds } = placement;
  return axis.isHorizontal
    ? axis.createTransform(bounds.x, bounds.width)
    : axis.createTransform(bounds.y, bounds.height);
}
