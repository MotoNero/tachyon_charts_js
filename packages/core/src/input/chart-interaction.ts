// What modifiers do to a chart: hit tests on its layout and changes of its axes (ChartInteraction and ZoomHistory of the
// .NET version). JavaScript has one thread per page, so changes run at once unless a dispatcher is given.
import type { Axis } from '../axes/axis';
import { ColorAxis } from '../axes/color-axis';
import type { AxisPlacement, DipRect } from '../layout/chart-layout';
import type { DoubleRange } from '../numerics/range';
import type { ChartSurface } from '../pipeline/chart-surface';
import type { Point } from './primitives';

/** The directions of the data a navigation applies to. */
export type ChartDirection = 'x' | 'y' | 'both';

/** A pane under a position, with the axes that navigate in it. */
export interface PaneHit {
  /** The pane in device-independent units. */
  readonly bounds: DipRect;
  /** The vertical axes of the pane. */
  readonly axes: readonly Axis[];
}

/** An edit other than navigation, such as a drawing, that the history undoes in the same order. */
export interface ChartEdit {
  /** Takes the edit back. */
  undo(): void;
  /** Makes the edit again. */
  redo(): void;
}

interface AxisState {
  readonly axis: Axis;
  readonly range: DoubleRange;
  readonly isAutoRange: boolean;
}

interface Step {
  readonly axes?: readonly AxisState[];
  readonly edit?: ChartEdit;
}

// Core knows no DOM types; browsers, workers and Node all have performance.now, other hosts get Date.now.
const now = (): number => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

/**
 * Remembers the ranges of all axes before navigation, and other edits, for undo and redo in one order. Navigation steps
 * in quick succession, such as wheel notches or the moves of one drag, count as one.
 */
export class ZoomHistory {
  private readonly undoSteps: Step[] = [];
  private readonly redoSteps: Step[] = [];
  private lastRecord = Number.NEGATIVE_INFINITY;
  /** The number of steps kept. */
  capacity = 100;
  /** Navigation within this many milliseconds of the last counts as the same step. */
  mergeWindow = 400;
  /** The time in milliseconds; tests replace it. */
  clock: () => number = now;

  /** Whether there is something to undo. */
  get canUndo(): boolean {
    return this.undoSteps.length > 0;
  }

  /** Whether there is something to redo. */
  get canRedo(): boolean {
    return this.redoSteps.length > 0;
  }

  /** Remembers the ranges of the axes of a chart before it navigates. */
  record(chart: ChartSurface): void {
    const time = this.clock();
    const isNewStep = this.undoSteps.length === 0 || time - this.lastRecord > this.mergeWindow;
    this.lastRecord = time;
    if (isNewStep) {
      this.push({ axes: capture(chart) });
    }
  }

  /** Remembers an edit; the next navigation is a step of its own. */
  recordEdit(edit: ChartEdit): void {
    this.push({ edit });
    this.lastRecord = Number.NEGATIVE_INFINITY;
  }

  /** Undoes the last step; returns whether there was one. */
  undo(chart: ChartSurface): boolean {
    return this.move(chart, this.undoSteps, this.redoSteps, true);
  }

  /** Redoes the last undone step; returns whether there was one. */
  redo(chart: ChartSurface): boolean {
    return this.move(chart, this.redoSteps, this.undoSteps, false);
  }

  /** Forgets all steps. */
  clear(): void {
    this.undoSteps.length = 0;
    this.redoSteps.length = 0;
  }

  private push(step: Step): void {
    this.undoSteps.push(step);
    this.redoSteps.length = 0;
    if (this.undoSteps.length > this.capacity) {
      this.undoSteps.shift();
    }
  }

  private move(chart: ChartSurface, from: Step[], to: Step[], isUndo: boolean): boolean {
    const step = from.pop();
    if (!step) {
      return false;
    }
    this.lastRecord = Number.NEGATIVE_INFINITY;
    if (step.edit) {
      if (isUndo) {
        step.edit.undo();
      } else {
        step.edit.redo();
      }
      to.push(step);
      return true;
    }
    to.push({ axes: capture(chart) });
    for (const item of step.axes ?? []) {
      item.axis.visibleRange = item.range;
      item.axis.isAutoRange = item.isAutoRange;
    }
    return true;
  }
}

function capture(chart: ChartSurface): AxisState[] {
  return [...chart.horizontalAxes, ...chart.panes.flatMap((pane) => pane.axes)].map((axis) => ({
    axis,
    range: axis.visibleRange,
    isAutoRange: axis.isAutoRange,
  }));
}

function contains(bounds: DipRect, position: Point): boolean {
  return position.x >= bounds.x && position.x <= bounds.right && position.y >= bounds.y && position.y <= bounds.bottom;
}

function toData(axis: Axis, bounds: DipRect, pixel: number): number {
  return axis.isHorizontal
    ? axis.createTransform(bounds.x, bounds.width).toData(pixel)
    : axis.createTransform(bounds.y, bounds.height).toData(pixel);
}

function panAxis(axis: Axis, bounds: DipRect, distance: number): void {
  // Both ends by pixels: on a nonlinear axis, the same distance is another amount of values at each end.
  const [start, length] = axis.isHorizontal ? [bounds.x, bounds.width] : [bounds.y, bounds.height];
  axis.showRange(toData(axis, bounds, start - distance), toData(axis, bounds, start + length - distance));
}

const appliesToX = (direction: ChartDirection): boolean => direction !== 'y';
const appliesToY = (direction: ChartDirection): boolean => direction !== 'x';

const interactions = new WeakMap<ChartSurface, ChartInteraction>();

/** @internal The latest interaction made for a chart, for an overview that moves the chart. */
export function interactionOf(chart: ChartSurface): ChartInteraction | undefined {
  return interactions.get(chart);
}

/** Connects modifiers with a chart: hit tests read its last layout, changes go to its axes. */
export class ChartInteraction {
  /** The undo history of navigation and edits. */
  readonly history = new ZoomHistory();

  /**
   * @param chart - The chart.
   * @param dispatch - Runs a change where the chart lives, such as in a render worker; at once when left out.
   */
  constructor(
    /** The chart. */
    readonly chart: ChartSurface,
    private readonly dispatch: (change: () => void) => void = (change) => {
      change();
    },
  ) {
    interactions.set(chart, this);
  }

  /** Runs a change of the chart. */
  run(change: () => void): void {
    this.dispatch(change);
  }

  /** The pane under a position, `undefined` outside all panes or before the first frame. */
  hitPane(position: Point): PaneHit | undefined {
    const layout = this.chart.currentLayout;
    const index = layout ? layout.panes.findIndex((pane) => contains(pane, position)) : -1;
    if (!layout || index < 0) {
      return undefined;
    }
    const axes = (this.chart.panes[index]?.axes ?? []).filter((axis) => !(axis instanceof ColorAxis));
    return { bounds: layout.panes[index] as DipRect, axes };
  }

  /** The axis under a position. */
  hitAxis(position: Point): AxisPlacement | undefined {
    return this.chart.currentLayout?.axes.find((placement) => contains(placement.bounds, position));
  }

  /** Zooms around a position, so that the data under it stays there; a factor below 1 zooms in. */
  zoom(pane: PaneHit, position: Point, factor: number, direction: ChartDirection): void {
    this.run(() => {
      this.history.record(this.chart);
      if (appliesToX(direction)) {
        for (const axis of this.chart.horizontalAxes) {
          axis.zoomAround(toData(axis, pane.bounds, position.x), factor);
        }
      }
      if (appliesToY(direction)) {
        for (const axis of pane.axes) {
          axis.zoomAround(toData(axis, pane.bounds, position.y), factor);
        }
      }
    });
  }

  /** Moves the data by a distance, so that it follows the pointer. */
  pan(pane: PaneHit, delta: Point, direction: ChartDirection): void {
    this.run(() => {
      this.history.record(this.chart);
      if (appliesToX(direction)) {
        for (const axis of this.chart.horizontalAxes) {
          panAxis(axis, pane.bounds, delta.x);
        }
      }
      if (appliesToY(direction)) {
        for (const axis of pane.axes) {
          panAxis(axis, pane.bounds, delta.y);
        }
      }
    });
  }

  /** Moves one axis by a distance in device-independent units. */
  panAxis(placement: AxisPlacement, distance: number): void {
    this.run(() => {
      this.history.record(this.chart);
      panAxis(placement.axis, placement.bounds, distance);
    });
  }

  /** Scales one axis around a position along it. */
  zoomAxis(placement: AxisPlacement, position: number, factor: number): void {
    this.run(() => {
      this.history.record(this.chart);
      placement.axis.zoomAround(toData(placement.axis, placement.bounds, position), factor);
    });
  }

  /** Lets an axis follow the data again. */
  autoRange(axis: Axis): void {
    this.run(() => {
      this.history.record(this.chart);
      axis.isAutoRange = true;
    });
  }

  /** Lets the horizontal axes and the axes of a pane follow the data again. */
  autoRangePane(pane: PaneHit): void {
    this.run(() => {
      this.history.record(this.chart);
      for (const axis of [...this.chart.horizontalAxes, ...pane.axes]) {
        axis.isAutoRange = true;
      }
    });
  }

  /** Shows the data inside an area of a pane. */
  zoomTo(pane: PaneHit, area: DipRect, direction: ChartDirection): void {
    this.run(() => {
      this.history.record(this.chart);
      if (appliesToX(direction)) {
        for (const axis of this.chart.horizontalAxes) {
          axis.showRange(toData(axis, pane.bounds, area.x), toData(axis, pane.bounds, area.right));
        }
      }
      if (appliesToY(direction)) {
        for (const axis of pane.axes) {
          axis.showRange(toData(axis, pane.bounds, area.y), toData(axis, pane.bounds, area.bottom));
        }
      }
    });
  }

  /** Undoes the last navigation or edit. */
  undo(): void {
    this.run(() => {
      this.history.undo(this.chart);
    });
  }

  /** Redoes the last undone navigation or edit. */
  redo(): void {
    this.run(() => {
      this.history.redo(this.chart);
    });
  }

  /** The value of the first horizontal axis at a position. */
  xValueAt(position: Point): number {
    const layout = this.chart.currentLayout;
    const axis = this.chart.horizontalAxes[0];
    return layout && axis ? toData(axis, layout.plotArea, position.x) : 0;
  }

  /** Shows or hides the preview of a zoom. */
  showZoomRectangle(area: DipRect | undefined): void {
    this.run(() => {
      this.chart.zoomRectangle = area;
    });
  }
}
