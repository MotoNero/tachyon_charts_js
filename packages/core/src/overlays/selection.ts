// Selecting points with a rectangle, a lasso or a click while a key is held, and marking them, as SelectionModifier
// and SelectionOverlay of the .NET version.
import type { ChartInteraction } from '../input/chart-interaction';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import { InputModifiers, type KeyInputEvent, type Point, type PointerInputEvent } from '../input/primitives';
import { DipRect } from '../layout/chart-layout';
import type { SelectedPoint, SeriesSelection } from '../pipeline/chart-surface';
import type { Rgba8 } from '../render/types';
import { ChartOverlay, type OverlayCanvas } from './chart-overlay';

const markerSize = 3;
const maximumMarkers = 50_000;

/** How a selection takes points: the nearest to a click, those in a rectangle, or those in a drawn outline. */
export type SelectionMode = 'point' | 'rectangle' | 'lasso';

/** Marks selected points with small squares and shows the outline while it is drawn. */
export class SelectionOverlay extends ChartOverlay {
  /** The color of the marks; a warm yellow by default. */
  color: Rgba8 = { r: 255, g: 215, b: 90, a: 255 };
  private points: SelectedPoint[] = [];
  private outline: readonly Point[] = [];

  /** @internal The number of marked points, at most 50 000. */
  get markedPoints(): number {
    return this.points.length;
  }

  /** Marks points; of more than 50 000 every n-th, so that marking stays fast. */
  setPoints(points: readonly SelectedPoint[]): void {
    const count = points.length;
    const step =
      Math.max(Math.trunc(count / maximumMarkers), 1) +
      (count % maximumMarkers !== 0 && count > maximumMarkers ? 1 : 0);
    this.points = [];
    for (let i = 0; i < count; i += step) {
      this.points.push(points[i] as SelectedPoint);
    }
    this.changed();
  }

  /** Shows an outline in device-independent units; none when empty. */
  setOutline(outline: readonly Point[]): void {
    this.outline = outline;
    this.changed();
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    canvas.clip = canvas.layout.plotArea;
    for (const { series, x, y } of this.points) {
      const point = canvas.pointOf(series.xAxis, series.yAxis, x, y);
      if (point) {
        canvas.drawRectangle(
          new DipRect(point.x - markerSize, point.y - markerSize, markerSize * 2, markerSize * 2),
          this.color,
        );
      }
    }
    const outline = this.outline;
    for (let i = 1; i < outline.length; i++) {
      canvas.drawLine(outline[i - 1] as Point, outline[i] as Point, 1.5, canvas.colors.accent);
    }
    if (outline.length > 2) {
      canvas.drawLine(outline[outline.length - 1] as Point, outline[0] as Point, 1.5, canvas.colors.accent);
    }
    canvas.clip = undefined;
  }
}

function rectangleOutline(a: Point, b: Point): Point[] {
  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
}

/**
 * Selects points with the primary button while a key is held, Shift by default: by a rectangle, a lasso or a click;
 * Escape takes the selection back or stops the outline.
 */
export class SelectionModifier extends ChartModifier {
  /** The priority, below the crosshair and above zooming. */
  static readonly defaultPriority = 22;
  /** How points are taken; by a rectangle by default. */
  mode: SelectionMode = 'rectangle';
  /** The keys that must be held; Shift by default. */
  modifierKey: number = InputModifiers.shift;
  /** How far from a click a point is still found, in device-independent units; 10 by default. */
  clickDistance = 10;
  /** Called when the selection changes. */
  onSelectionChanged: ((selection: readonly SeriesSelection[]) => void) | undefined;
  /** The overlay that marks the points. */
  readonly overlay = new SelectionOverlay();
  private current: readonly SeriesSelection[] = [];
  private outline: Point[] = [];
  private start: Point = { x: 0, y: 0 };
  private pointerId = 0;
  private isDragging = false;
  private isCanceled = false;

  constructor() {
    super(SelectionModifier.defaultPriority);
  }

  /** The selected points of each series. */
  get selection(): readonly SeriesSelection[] {
    return this.current;
  }

  /** Takes the selection back. */
  clear(): void {
    this.current = [];
    const overlay = this.overlay;
    this.interaction?.run(() => {
      overlay.setPoints([]);
    });
    this.onSelectionChanged?.(this.current);
  }

  /** {@inheritDoc ChartModifier.onAttached} */
  protected override onAttached(interaction: ChartInteraction): void {
    interaction.run(() => {
      interaction.chart.addOverlay(this.overlay);
    });
  }

  /** {@inheritDoc ChartModifier.onDetached} */
  protected override onDetached(interaction: ChartInteraction): void {
    interaction.run(() => {
      interaction.chart.removeOverlay(this.overlay);
    });
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    if (this.isDragging) {
      return input.pointerId === this.pointerId ? this.continueDrag(input) : 'ignored';
    }
    if (
      input.kind !== 'pressed' ||
      input.changedButton !== 'primary' ||
      input.modifiers !== this.modifierKey ||
      !this.interaction?.hitPane(input.position)
    ) {
      return 'ignored';
    }
    this.isDragging = true;
    this.isCanceled = false;
    this.pointerId = input.pointerId;
    this.start = input.position;
    this.outline = [input.position];
    return 'capture';
  }

  /** {@inheritDoc ChartModifier.onKey} */
  override onKey(input: KeyInputEvent): ModifierResult {
    if (input.key !== 'Escape' || input.kind !== 'pressed') {
      return 'ignored';
    }
    if (!this.isDragging && this.current.length > 0) {
      this.clear();
      return 'handled';
    }
    if (!this.isDragging || this.isCanceled) {
      return 'ignored';
    }
    this.isCanceled = true;
    this.showOutline([]);
    return 'handled';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.isDragging = false;
    this.showOutline([]);
  }

  private continueDrag(input: PointerInputEvent): ModifierResult {
    switch (input.kind) {
      case 'moved':
        if (!this.isCanceled) {
          this.outline.push(input.position);
          let shape: Point[] = [];
          if (this.mode === 'rectangle') {
            shape = rectangleOutline(this.start, input.position);
          } else if (this.mode === 'lasso') {
            shape = [...this.outline];
          }
          this.showOutline(shape);
        }
        return 'handled';
      case 'released':
        this.isDragging = false;
        this.showOutline([]);
        if (!this.isCanceled) {
          this.finish(input.position);
        }
        return 'release';
      case 'canceled':
        this.isDragging = false;
        this.showOutline([]);
        return 'release';
      default:
        return 'handled';
    }
  }

  private showOutline(outline: readonly Point[]): void {
    const overlay = this.overlay;
    this.interaction?.run(() => {
      overlay.setOutline(outline);
    });
  }

  private finish(end: Point): void {
    const interaction = this.interaction;
    if (!interaction) {
      return;
    }
    const chart = interaction.chart;
    let selection: SeriesSelection[] = [];
    if (this.mode === 'point') {
      const hit = chart.hitTest(end, this.clickDistance, 'nearest');
      if (hit) {
        selection = [{ series: hit.series, indices: [hit.index] }];
      }
    } else {
      const polygon = this.mode === 'rectangle' ? rectangleOutline(this.start, end) : this.outline;
      selection = polygon.length >= 3 ? chart.selectPoints(polygon) : [];
    }
    this.current = selection;
    const points = chart.readPoints(selection);
    const overlay = this.overlay;
    interaction.run(() => {
      overlay.setPoints(points);
    });
    this.onSelectionChanged?.(selection);
  }
}
