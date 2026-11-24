// Two cursors that measure the distance between two places of the data, as MeasureCursorModifier and
// MeasureCursorOverlay of the .NET version.
import type { Axis } from '../axes/axis';
import type { ChartInteraction, PaneHit } from '../input/chart-interaction';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import { InputModifiers, type KeyInputEvent, type Point, type PointerInputEvent } from '../input/primitives';
import type { DipRect } from '../layout/chart-layout';
import { invariantCulture } from '../locale/culture';
import { formatGeneral } from '../locale/format';
import type { Rgba8 } from '../render/types';
import { ChartOverlay, type OverlayCanvas } from './chart-overlay';

/** The places of two measuring cursors and what lies between them. */
export class MeasureResult {
  /**
   * @param x1 - The X value of the first cursor.
   * @param y1 - The Y value of the first cursor.
   * @param x2 - The X value of the second cursor.
   * @param y2 - The Y value of the second cursor.
   */
  constructor(
    /** The X value of the first cursor. */
    readonly x1: number,
    /** The Y value of the first cursor. */
    readonly y1: number,
    /** The X value of the second cursor. */
    readonly x2: number,
    /** The Y value of the second cursor. */
    readonly y2: number,
  ) {}

  /** The distance in X. */
  get deltaX(): number {
    return this.x2 - this.x1;
  }

  /** The distance in Y. */
  get deltaY(): number {
    return this.y2 - this.y1;
  }

  /** The frequency of the distance in X; `undefined` when it is 0. */
  get frequency(): number | undefined {
    return this.deltaX === 0 ? undefined : 1 / this.deltaX;
  }

  /** The slope between the cursors; `undefined` when they share their X. */
  get slope(): number | undefined {
    return this.deltaX === 0 ? undefined : this.deltaY / this.deltaX;
  }
}

/** @internal Draws the two cursors and the distances beside them. */
export class MeasureCursorOverlay extends ChartOverlay {
  /** The color of the first cursor. */
  firstColor: Rgba8 = { r: 240, g: 130, b: 90, a: 255 };
  /** The color of the second cursor. */
  secondColor: Rgba8 = { r: 110, g: 210, b: 130, a: 255 };
  private xAxis: Axis | undefined;
  private yAxis: Axis | undefined;
  private shown: MeasureResult | undefined;

  /** The result on show. */
  get result(): MeasureResult | undefined {
    return this.shown;
  }

  /** Shows a result on two axes. */
  show(xAxis: Axis, yAxis: Axis, result: MeasureResult): void {
    this.xAxis = xAxis;
    this.yAxis = yAxis;
    this.shown = result;
    this.changed();
  }

  /** Hides the cursors. */
  hide(): void {
    if (this.shown) {
      this.shown = undefined;
      this.changed();
    }
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const result = this.shown;
    const xAxis = this.xAxis;
    const yAxis = this.yAxis;
    if (!result || !xAxis || !yAxis) {
      return;
    }
    const x1 = canvas.positionOf(xAxis, result.x1);
    const y1 = canvas.positionOf(yAxis, result.y1);
    const x2 = canvas.positionOf(xAxis, result.x2);
    const y2 = canvas.positionOf(yAxis, result.y2);
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
      return;
    }
    const plot = canvas.layout.plotArea;
    canvas.clip = plot;
    drawCursor(canvas, plot, x1, y1, this.firstColor);
    drawCursor(canvas, plot, x2, y2, this.secondColor);
    canvas.clip = undefined;
    const g5 = (value: number): string => formatGeneral(value, 5, invariantCulture);
    const lines = [
      `ΔX ${g5(result.deltaX)}`,
      `ΔY ${g5(result.deltaY)}`,
      result.frequency === undefined ? undefined : `1/ΔX ${g5(result.frequency)}`,
      result.slope === undefined ? undefined : `ΔY/ΔX ${g5(result.slope)}`,
    ];
    const left = Math.max(x1, x2) + 8;
    let top = Math.min(y1, y2);
    const height = canvas.lineHeight(canvas.labelSize) + 4;
    for (const line of lines) {
      if (line !== undefined) {
        canvas.drawLabel(line, left, top, canvas.colors.accent, canvas.colors.background);
        top += height;
      }
    }
  }
}

function drawCursor(canvas: OverlayCanvas, plot: DipRect, x: number, y: number, color: Rgba8): void {
  const f = Math.fround;
  canvas.drawLine({ x: f(x), y: f(plot.y) }, { x: f(x), y: f(plot.bottom) }, 1, color);
  canvas.drawLine({ x: f(plot.x), y: f(y) }, { x: f(plot.right), y: f(y) }, 1, color);
}

/**
 * Measures with two cursors: a drag with the primary button while a key is held, Alt by default, places them; a drag
 * near a cursor moves it; Escape hides them.
 */
export class MeasureCursorModifier extends ChartModifier {
  /** The priority, below the crosshair and above zooming. */
  static readonly defaultPriority = 23;
  /** The keys that must be held; Alt by default. */
  modifierKey: number = InputModifiers.alt;
  /** How far beside a cursor a press still takes it, in device-independent units; 6 by default. */
  grabDistance = 6;
  /** Called when the measurement changes. */
  onChanged: ((result: MeasureResult | undefined) => void) | undefined;
  private readonly overlay = new MeasureCursorOverlay();
  private pane: PaneHit | undefined;
  private current: MeasureResult | undefined;
  private pointerId = 0;
  private isDragging = false;
  private movesFirst = false;

  constructor() {
    super(MeasureCursorModifier.defaultPriority);
  }

  /** The measurement; `undefined` while there are no cursors. */
  get result(): MeasureResult | undefined {
    return this.current;
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
    const interaction = this.interaction;
    const pane =
      input.kind === 'pressed' && input.changedButton === 'primary' && input.modifiers === this.modifierKey
        ? interaction?.hitPane(input.position)
        : undefined;
    if (!interaction || !pane || pane.axes.length === 0) {
      return 'ignored';
    }
    this.pane = pane;
    const [x, y] = this.toValues(interaction, input.position);
    const result = this.current;
    if (result && this.isNear(interaction, x, result.x1)) {
      this.movesFirst = true;
    } else if (result && this.isNear(interaction, x, result.x2)) {
      this.movesFirst = false;
    } else {
      this.movesFirst = false;
      this.publish(new MeasureResult(x, y, x, y));
    }
    this.isDragging = true;
    this.pointerId = input.pointerId;
    return 'capture';
  }

  /** {@inheritDoc ChartModifier.onKey} */
  override onKey(input: KeyInputEvent): ModifierResult {
    if (!this.current || input.key !== 'Escape' || input.kind !== 'pressed') {
      return 'ignored';
    }
    this.publish(undefined);
    return 'handled';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.isDragging = false;
  }

  private toValues(interaction: ChartInteraction, position: Point): [number, number] {
    const pane = this.pane as PaneHit;
    const axis = pane.axes[0] as Axis;
    return [interaction.xValueAt(position), axis.createTransform(pane.bounds.y, pane.bounds.height).toData(position.y)];
  }

  // Whether a value lies within the grab distance of a cursor, measured along the first horizontal axis.
  private isNear(interaction: ChartInteraction, x: number, cursor: number): boolean {
    const layout = interaction.chart.currentLayout;
    const axis = interaction.chart.horizontalAxes[0];
    const placement = layout?.axes.find((item) => item.axis === axis);
    if (!layout || !axis || !placement) {
      return false;
    }
    const transform = axis.createTransform(placement.bounds.x, placement.bounds.width);
    const start = layout.plotArea.x;
    const reach = transform.toData(start + this.grabDistance) - transform.toData(start);
    return Math.abs(reach) >= Math.abs(x - cursor);
  }

  private continueDrag(input: PointerInputEvent): ModifierResult {
    switch (input.kind) {
      case 'moved': {
        const interaction = this.interaction;
        const result = this.current;
        if (interaction && result) {
          const [x, y] = this.toValues(interaction, input.position);
          this.publish(
            this.movesFirst
              ? new MeasureResult(x, y, result.x2, result.y2)
              : new MeasureResult(result.x1, result.y1, x, y),
          );
        }
        return 'handled';
      }
      case 'released':
      case 'canceled':
        this.isDragging = false;
        return 'release';
      default:
        return 'handled';
    }
  }

  private publish(result: MeasureResult | undefined): void {
    this.current = result;
    const interaction = this.interaction;
    if (interaction) {
      const overlay = this.overlay;
      const xAxis = interaction.chart.horizontalAxes[0];
      const yAxis = this.pane?.axes[0];
      interaction.run(() => {
        if (result && xAxis && yAxis) {
          overlay.show(xAxis, yAxis, result);
        } else {
          overlay.hide();
        }
      });
    }
    this.onChanged?.(result);
  }
}
