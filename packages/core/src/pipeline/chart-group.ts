// Charts that show the same X range side by side, as ChartGroup of the .NET version: zooming one zooms all, their
// plots line up, and a crosshair in one shows its line in all.
import type { Axis } from '../axes/axis';
import type { CrosshairModifier } from '../input/cursor-modifiers';
import { DoubleRange } from '../numerics/range';
import type { ChartSurface } from './chart-surface';

interface Member {
  readonly chart: ChartSurface;
  readonly axis: Axis;
  stamp: number;
  left: number;
  right: number;
  readonly sharesAxisWidth: boolean;
}

const registry = new Map<string, ChartGroup>();

/** Charts whose first horizontal axes show the same range, with plots of the same width and coupled crosshairs. */
export class ChartGroup {
  /** Whether zooming one chart zooms all; true by default. */
  synchronizesRange = true;
  /** Whether the plots of all charts start and end at the same places; true by default. */
  synchronizesAxisWidth = true;
  /** Called when a crosshair of the group moves, with its X value, `undefined` when it is hidden. */
  onCursorMoved: ((x: number | undefined) => void) | undefined;
  private readonly members: Member[] = [];
  private readonly crosshairs = new Map<CrosshairModifier, (x: number | undefined) => void>();
  private range = DoubleRange.empty;
  private left = 0;
  private right = 0;

  /**
   * The group of a name, made on first use; charts with the same group name belong together.
   * @throws RangeError for an empty name.
   */
  static get(name: string): ChartGroup {
    if (name.length === 0) {
      throw new RangeError('A group needs a name.');
    }
    let group = registry.get(name);
    if (!group) {
      group = new ChartGroup();
      registry.set(name, group);
    }
    return group;
  }

  /** The charts of the group. */
  get charts(): readonly ChartSurface[] {
    return this.members.map((member) => member.chart);
  }

  /** @internal The first chart, which an overview follows. */
  get firstChart(): ChartSurface | undefined {
    return this.members[0]?.chart;
  }

  /**
   * Adds a chart with its first horizontal axis, or with another axis that then keeps its own width.
   * @throws RangeError for a chart without horizontal axis.
   */
  add(chart: ChartSurface, axis?: Axis): void {
    const shared = axis ?? chart.horizontalAxes[0];
    if (!shared) {
      throw new RangeError('The chart has no horizontal axis.');
    }
    if (this.members.some((member) => member.chart === chart)) {
      return;
    }
    if (this.synchronizesRange && !this.range.isEmpty) {
      shared.visibleRange = this.range;
    }
    this.members.push({ chart, axis: shared, stamp: shared.version, left: 0, right: 0, sharesAxisWidth: !axis });
    chart.setGroup(this);
  }

  /** Removes a chart; false when it is not in the group. */
  remove(chart: ChartSurface): boolean {
    const index = this.members.findIndex((member) => member.chart === chart);
    if (index < 0) {
      return false;
    }
    this.members.splice(index, 1);
    chart.setGroup(undefined);
    chart.setPlotInsets(0, 0);
    return true;
  }

  /** Lets a crosshair show its line in all other charts of the group. */
  connect(crosshair: CrosshairModifier): void {
    if (!this.crosshairs.has(crosshair)) {
      const listener = (x: number | undefined): void => {
        this.moved(crosshair, x);
      };
      this.crosshairs.set(crosshair, listener);
      crosshair.movedListeners.add(listener);
    }
  }

  /** Ends what {@link ChartGroup.connect} began. */
  disconnect(crosshair: CrosshairModifier): void {
    const listener = this.crosshairs.get(crosshair);
    if (listener) {
      crosshair.movedListeners.delete(listener);
      this.crosshairs.delete(crosshair);
    }
  }

  /** Shows the line of all crosshairs at an X value, as if a pointer were there; hides them for `undefined`. */
  showCursor(x: number | undefined): void {
    this.moved(undefined, x);
  }

  /** @internal Takes the range of an axis that changed since the last frame over to all others. */
  onFrameStarting(chart: ChartSurface): void {
    if (!this.synchronizesRange) {
      return;
    }
    const member = this.members.find((item) => item.chart === chart);
    if (!member || member.axis.version === member.stamp) {
      return;
    }
    member.stamp = member.axis.version;
    this.range = member.axis.visibleRange;
    for (const other of this.members) {
      if (other !== member && !other.axis.visibleRange.equals(this.range)) {
        other.axis.visibleRange = this.range;
        other.stamp = other.axis.version;
        other.chart.invalidate();
      }
    }
  }

  /** @internal Takes the room a chart needs beside its plot and gives all charts the largest. */
  onMeasured(chart: ChartSurface, left: number, right: number): void {
    if (!this.synchronizesAxisWidth) {
      return;
    }
    const member = this.members.find((item) => item.chart === chart);
    if (!member?.sharesAxisWidth) {
      return;
    }
    member.left = left;
    member.right = right;
    const sharing = this.members.filter((item) => item.sharesAxisWidth);
    const requiredLeft = Math.max(...sharing.map((item) => item.left));
    const requiredRight = Math.max(...sharing.map((item) => item.right));
    if (requiredLeft === this.left && requiredRight === this.right) {
      chart.setPlotInsets(this.left, this.right);
      return;
    }
    this.left = requiredLeft;
    this.right = requiredRight;
    for (const other of sharing) {
      other.chart.setPlotInsets(this.left, this.right);
    }
  }

  private moved(source: CrosshairModifier | undefined, x: number | undefined): void {
    this.onCursorMoved?.(x);
    for (const crosshair of this.crosshairs.keys()) {
      const interaction = crosshair.interaction;
      const axis = interaction?.chart.horizontalAxes[0];
      if (crosshair === source || !interaction || !axis) {
        continue;
      }
      const overlay = crosshair.overlay;
      interaction.run(() => {
        if (x === undefined) {
          overlay.hide();
        } else {
          overlay.showAt(axis, x);
        }
      });
    }
  }
}
