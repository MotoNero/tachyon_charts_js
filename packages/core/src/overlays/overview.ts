// An overview chart that shows and moves the window another chart shows, as OverviewModifier and OverviewOverlay of
// the .NET version.
import type { Axis } from '../axes/axis';
import { interactionOf, type ChartInteraction } from '../input/chart-interaction';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import type { PointerInputEvent } from '../input/primitives';
import { DipRect } from '../layout/chart-layout';
import { ChartGroup } from '../pipeline/chart-group';
import { ChartOverlay, type OverlayCanvas } from './chart-overlay';

/** Shades what lies outside the window of the other chart and frames the window. */
export class OverviewOverlay extends ChartOverlay {
  private box: { left: number; right: number } | undefined;

  /** @param targetAxis - The axis whose visible range is the window; none while there is no other chart. */
  constructor(private readonly targetAxis: () => Axis | undefined) {
    super();
  }

  /** The window of the last frame in device-independent units, `undefined` before. */
  get window(): { readonly left: number; readonly right: number } | undefined {
    return this.box;
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + (this.targetAxis()?.version ?? 0);
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const plot = canvas.layout.plotArea;
    const target = this.targetAxis();
    const axis = canvas.layout.axes.find((placement) => placement.axis.isHorizontal)?.axis;
    if (!target || !axis) {
      return;
    }
    const range = target.visibleRange;
    const first = canvas.positionOf(axis, range.min);
    const second = canvas.positionOf(axis, range.max);
    if (first === undefined || second === undefined) {
      return;
    }
    const clamp = (value: number): number => Math.min(Math.max(value, plot.x), plot.right);
    const left = clamp(Math.min(first, second));
    const right = clamp(Math.max(first, second));
    this.box = { left, right };
    canvas.clip = plot;
    const shade = { ...canvas.colors.background, a: 170 };
    canvas.fillRectangle(new DipRect(plot.x, plot.y, left - plot.x, plot.height), shade);
    canvas.fillRectangle(new DipRect(right, plot.y, plot.right - right, plot.height), shade);
    canvas.drawRectangle(new DipRect(left, plot.y, Math.max(right - left, 2), plot.height), canvas.colors.accent);
    canvas.clip = undefined;
  }
}

type Drag = 'none' | 'move' | 'leftEdge' | 'rightEdge';

/**
 * Lets an overview chart move the window of another chart: dragging the window moves it, dragging an edge scales it,
 * a press beside the window centers it there.
 */
export class OverviewModifier extends ChartModifier {
  /** The priority, above zooming and panning. */
  static readonly defaultPriority = 40;
  /** How far beside an edge a press still takes the edge, in device-independent units; 6 by default. */
  edgeDistance = 6;
  /** The overlay that shows the window. */
  readonly overlay: OverviewOverlay;
  private drag: Drag = 'none';
  private lastValue = 0;
  private pointerId = 0;

  /** @param target - The interaction of the chart whose window the overview moves. */
  constructor(private readonly target: () => ChartInteraction | undefined) {
    super(OverviewModifier.defaultPriority);
    this.overlay = new OverviewOverlay(() => this.target()?.chart.horizontalAxes[0]);
  }

  /** An overview of the first chart of a group, found again when the chart leaves the group. */
  static of(group: string): OverviewModifier {
    let found: ChartInteraction | undefined;
    return new OverviewModifier(() => {
      const target = ChartGroup.get(group);
      if (found?.chart.group !== target) {
        const first = target.firstChart;
        found = first ? interactionOf(first) : undefined;
      }
      return found;
    });
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
    if (this.drag !== 'none') {
      return input.pointerId === this.pointerId ? this.continueDrag(input) : 'ignored';
    }
    const interaction = this.interaction;
    const target = this.target();
    const window = this.overlay.window;
    if (
      input.kind !== 'pressed' ||
      input.changedButton !== 'primary' ||
      !interaction ||
      !target ||
      !window ||
      !interaction.hitPane(input.position)
    ) {
      return 'ignored';
    }
    const x = input.position.x;
    const value = interaction.xValueAt(input.position);
    if (Math.abs(x - window.left) <= this.edgeDistance) {
      this.drag = 'leftEdge';
    } else if (Math.abs(x - window.right) <= this.edgeDistance) {
      this.drag = 'rightEdge';
    } else {
      this.drag = 'move';
      if (x < window.left || x > window.right) {
        centerAt(target, value);
      }
    }
    this.lastValue = value;
    this.pointerId = input.pointerId;
    return 'capture';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.drag = 'none';
  }

  private continueDrag(input: PointerInputEvent): ModifierResult {
    switch (input.kind) {
      case 'moved': {
        const interaction = this.interaction;
        const target = this.target();
        if (interaction && target) {
          const value = interaction.xValueAt(input.position);
          this.apply(target, value);
          this.lastValue = value;
        }
        return 'handled';
      }
      case 'released':
      case 'canceled':
        this.drag = 'none';
        return 'release';
      default:
        return 'handled';
    }
  }

  private apply(target: ChartInteraction, value: number): void {
    const drag = this.drag;
    const delta = value - this.lastValue;
    target.run(() => {
      target.history.record(target.chart);
      const axis = target.chart.horizontalAxes[0];
      if (!axis) {
        return;
      }
      const range = axis.visibleRange;
      if (drag === 'move') {
        axis.panBy(delta);
      } else if (drag === 'leftEdge') {
        axis.showRange(Math.min(value, range.max), range.max);
      } else {
        axis.showRange(range.min, Math.max(value, range.min));
      }
    });
  }
}

function centerAt(target: ChartInteraction, value: number): void {
  target.run(() => {
    target.history.record(target.chart);
    const axis = target.chart.horizontalAxes[0];
    if (axis) {
      axis.panBy(value - axis.visibleRange.center);
    }
  });
}
