// Modifiers that follow the pointer without taking its input (CursorModifiers of the .NET version).
import type { HitResult } from '../hit-testing/hit-test';
import { CrosshairOverlay, formatHitY } from '../overlays/crosshair-overlay';
import type { Rgba8 } from '../render/types';
import type { ChartInteraction } from './chart-interaction';
import { ChartModifier, type ModifierResult } from './modifier-pipeline';
import type { Point, PointerInputEvent } from './primitives';

/** Shows a crosshair at the pointer. It only observes, so other modifiers keep receiving the input. */
export class CrosshairModifier extends ChartModifier {
  /** The cross the chart draws. */
  readonly overlay = new CrosshairOverlay();
  /** Whether the cross jumps to the nearest point within {@link CrosshairModifier.snapDistance}. */
  snapToData = false;
  /** How far the cross jumps to a point, in device-independent units. */
  snapDistance = 30;
  /** Whether each curve gets a point at the X of the pointer and a box shows the values of all series there. */
  showsValues = false;
  /** How far from the pointer in X a series still shows its value. */
  valueDistance = 40;
  /** Called after every move with the X value under the pointer, `undefined` when the cross is hidden. */
  onMoved: ((x: number | undefined) => void) | undefined;
  /** @internal Listeners besides {@link CrosshairModifier.onMoved}, such as a chart group. */
  readonly movedListeners = new Set<(x: number | undefined) => void>();

  /** Creates the modifier with priority -10, after all that act on the input. */
  constructor() {
    super(-10);
  }

  /** Adds the cross to the chart. */
  protected override onAttached(interaction: ChartInteraction): void {
    interaction.run(() => {
      interaction.chart.addOverlay(this.overlay);
    });
  }

  /** Removes the cross from the chart, or tells the host that no point is shown. */
  protected override onDetached(interaction: ChartInteraction): void {
    interaction.run(() => {
      interaction.chart.removeOverlay(this.overlay);
    });
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const interaction = this.interaction;
    if (!interaction) {
      return 'ignored';
    }
    const overlay = this.overlay;
    if (input.kind === 'exited' || input.kind === 'canceled' || !interaction.hitPane(input.position)) {
      interaction.run(() => {
        overlay.hide();
      });
      this.notifyMoved(undefined);
      return 'ignored';
    }
    const chart = interaction.chart;
    const position = input.position;
    const snapped = this.snapToData ? chart.hitTest(position, this.snapDistance, 'nearest') : undefined;
    const values = this.showsValues ? chart.hitTestAll(position, this.valueDistance, 'nearestX') : [];
    const firstX = chart.horizontalAxes[0];
    const header = this.showsValues && firstX ? firstX.formatCursorValue(interaction.xValueAt(position)) : undefined;
    interaction.run(() => {
      overlay.series = chart.series;
      overlay.show(position, snapped, values, header);
    });
    this.notifyMoved(interaction.xValueAt(position));
    return 'ignored';
  }

  private notifyMoved(x: number | undefined): void {
    this.onMoved?.(x);
    for (const listener of this.movedListeners) {
      listener(x);
    }
  }
}

/** The nearest point at the pointer, for a tooltip the host shows. */
export interface TooltipData {
  /** The name of the series, if it has one. */
  readonly seriesName: string | undefined;
  /** The X value as the axis writes cursor values. */
  readonly xText: string;
  /** The Y value as the axis writes cursor values. */
  readonly yText: string;
  /** The X value of the point. */
  readonly x: number;
  /** The Y value of the point. */
  readonly y: number;
  /** The number of the point in its source. */
  readonly index: number;
  /** The color of the series. */
  readonly color: Rgba8;
  /** The position of the pointer. */
  readonly position: Point;
}

/** Finds the nearest point at the pointer and reports it; how it looks is up to the host. */
export class TooltipModifier extends ChartModifier {
  /** How far from the pointer a point is found, in device-independent units. */
  maximumDistance = 30;
  /** Called with the point under the pointer, or `undefined` when there is none. */
  onChanged: ((data: TooltipData | undefined) => void) | undefined;

  /** Creates the modifier with priority -10, after all that act on the input. */
  constructor() {
    super(-10);
  }

  /** Removes the cross from the chart, or tells the host that no point is shown. */
  protected override onDetached(): void {
    this.onChanged?.(undefined);
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.onChanged?.(undefined);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const interaction = this.interaction;
    if (!interaction) {
      return 'ignored';
    }
    const hit: HitResult | undefined =
      input.kind === 'exited' || input.kind === 'canceled'
        ? undefined
        : interaction.chart.hitTest(input.position, this.maximumDistance, 'nearest');
    if (!hit) {
      this.onChanged?.(undefined);
      return 'ignored';
    }
    const series = hit.series;
    this.onChanged?.({
      seriesName: series.name,
      xText: series.xAxis.formatCursorValue(hit.x),
      yText: formatHitY(hit),
      x: hit.x,
      y: hit.y,
      index: hit.index,
      color: series.accentColor,
      position: input.position,
    });
    return 'ignored';
  }
}
