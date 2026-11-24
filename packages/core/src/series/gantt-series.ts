// Gantt charts: tasks in rows over time, rows in groups that collapse, milestones and dependencies, as GanttData,
// GanttSeries, GanttOverlay, GanttModifier and GanttCharts of the .NET version. Times are absolute in the unit of the
// time axis; the rows run down a category axis.
import type { Axis } from '../axes/axis';
import { CategoryAxis } from '../axes/category-axis';
import { DateTimeAxis } from '../axes/date-time-axis';
import type { ChartBuilder } from '../fluent/chart-builder';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import { ZoomPanModifier } from '../input/navigation-modifiers';
import type { Point, PointerInputEvent } from '../input/primitives';
import type { ChartLayoutResult, DipRect } from '../layout/chart-layout';
import { chartText } from '../locale/culture';
import { formatGeneral } from '../locale/format';
import { roundHalfEven } from '../numerics/nice';
import { DoubleRange } from '../numerics/range';
import type { LinearAxisTransform } from '../numerics/transform';
import { ChartOverlay, type OverlayCanvas } from '../overlays/chart-overlay';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import { packRgba8, type Rgba8 } from '../render/types';
import { addRectangle } from './candle-series';
import { originOf } from './line-series';
import { addFringe, Mesh } from './ribbon-series';

const f = Math.fround;
const milestoneRadius = 6;

/** A row of a Gantt chart, in a group or not. */
export interface GanttRow {
  /** The name. */
  readonly name: string;
  /** The group, whose line stands above its first row. */
  readonly group?: string;
}

/** A task: a bar from start to end in a row, or a milestone where they are equal. */
export interface GanttTask {
  /** The row. */
  readonly row: number;
  /** The start in the unit of the time axis. */
  readonly start: number;
  /** The end, at or after the start. */
  readonly end: number;
  /** The label. */
  readonly label?: string;
  /** The color; the palette by row when left out. */
  readonly color?: Rgba8;
}

/** A line of a Gantt chart: a group or a row. */
export interface GanttLine {
  /** The name of the row or the group. */
  readonly name: string;
  /** The group of a row, or the group itself. */
  readonly group: string | undefined;
  /** The row, -1 for a group. */
  readonly row: number;
  /** Whether the line stands for a group. */
  readonly isGroup: boolean;
  /** Whether the group is collapsed. */
  readonly isCollapsed: boolean;
}

/** The tasks and lines of one version of a Gantt chart, ordered for drawing. */
export interface GanttState {
  /** The version of the data. */
  readonly version: number;
  /** The lines from the top. */
  readonly lines: readonly GanttLine[];
  /** The tasks. */
  readonly tasks: readonly GanttTask[];
  /** The tasks of each row by their start. */
  readonly byRow: readonly (readonly number[])[];
  /** The longest task of each row. */
  readonly longest: readonly number[];
  /** Whether a row has milestones. */
  readonly hasMilestones: readonly boolean[];
  /** The dependencies as pairs of tasks. */
  readonly links: readonly (readonly [number, number])[];
  /** The line of each row, -1 when its group is collapsed. */
  readonly lineOfRow: readonly number[];
  /** The span of each group line, 0 to 0 for rows. */
  readonly groupSpans: readonly (readonly [number, number])[];
}

const isMilestone = (task: GanttTask): boolean => task.end <= task.start;

/** @internal The first task of a row that may reach the time. */
export function firstVisibleTask(state: GanttState, row: number, time: number): number {
  const tasks = state.byRow[row] as readonly number[];
  const from = time - (state.longest[row] as number);
  let low = 0;
  let high = tasks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((state.tasks[tasks[middle] as number] as GanttTask).start < from) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** The rows, tasks and dependencies of a Gantt chart. */
export class GanttData {
  private readonly rowList: GanttRow[] = [];
  private readonly taskList: GanttTask[] = [];
  private readonly linkList: [number, number][] = [];
  private readonly collapsed = new Set<string>();
  private changes = 0;
  private state: GanttState | undefined;

  /** Grows with every change. */
  get version(): number {
    return this.changes;
  }

  /** The number of tasks. */
  get count(): number {
    return this.taskList.length;
  }

  /** The rows. */
  get rows(): readonly GanttRow[] {
    return this.rowList;
  }

  /** A task. */
  at(index: number): GanttTask {
    const task = this.taskList[index];
    if (!task) {
      throw new RangeError('There is no such task.');
    }
    return task;
  }

  /** Adds a row and returns its number. */
  addRow(name: string, group?: string): number {
    this.rowList.push(group === undefined ? { name } : { name, group });
    this.changes++;
    return this.rowList.length - 1;
  }

  /**
   * Adds a task and returns its number.
   * @throws RangeError for times that are not finite, an end before the start or a row that does not exist.
   */
  add(task: GanttTask): number {
    if (!Number.isFinite(task.start) || !Number.isFinite(task.end) || task.end < task.start) {
      throw new RangeError('A task needs a finite start and an end at or after it.');
    }
    if (!(task.row >= 0 && task.row < this.rowList.length)) {
      throw new RangeError(`There is no row ${String(task.row)}.`);
    }
    this.taskList.push(task);
    this.changes++;
    return this.taskList.length - 1;
  }

  /**
   * Adds a dependency: the second task follows the first.
   * @throws RangeError when a task does not exist.
   */
  link(from: number, to: number): void {
    if (!(from >= 0 && to >= 0 && from < this.taskList.length && to < this.taskList.length)) {
      throw new RangeError('Both tasks of a dependency must exist.');
    }
    this.linkList.push([from, to]);
    this.changes++;
  }

  /** Collapses a group to its line, or opens it. */
  setCollapsed(group: string, isCollapsed: boolean): void {
    const changed = isCollapsed ? !this.collapsed.has(group) : this.collapsed.has(group);
    if (isCollapsed) {
      this.collapsed.add(group);
    } else {
      this.collapsed.delete(group);
    }
    if (changed) {
      this.changes++;
    }
  }

  /** Whether a group is collapsed. */
  isCollapsed(group: string): boolean {
    return this.collapsed.has(group);
  }

  /** The state of the current version.  */
  get current(): GanttState {
    if (this.state?.version !== this.changes) {
      this.state = this.createState();
    }
    return this.state;
  }

  private createState(): GanttState {
    const rows = this.rowList;
    const tasks = [...this.taskList];
    const byRow: number[][] = rows.map(() => []);
    const longest = rows.map(() => 0);
    const hasMilestones = rows.map(() => false);
    tasks.forEach((task, i) => {
      (byRow[task.row] as number[]).push(i);
      longest[task.row] = Math.max(longest[task.row] as number, task.end - task.start);
      hasMilestones[task.row] ||= isMilestone(task);
    });
    for (const list of byRow) {
      list.sort((a, b) => (tasks[a] as GanttTask).start - (tasks[b] as GanttTask).start);
    }
    // A group gets a line of its own above its first row; a collapsed group hides its rows.
    const lines: GanttLine[] = [];
    const spans: (readonly [number, number])[] = [];
    const lineOfRow: number[] = [];
    let current: string | undefined;
    rows.forEach((row, r) => {
      const group = row.group;
      if (group !== undefined && group !== current) {
        lines.push({ name: group, group, row: -1, isGroup: true, isCollapsed: this.collapsed.has(group) });
        spans.push(spanOf(rows, tasks, group));
      }
      current = group;
      if (group !== undefined && this.collapsed.has(group)) {
        lineOfRow[r] = -1;
        return;
      }
      lineOfRow[r] = lines.length;
      lines.push({ name: row.name, group, row: r, isGroup: false, isCollapsed: false });
      spans.push([0, 0]);
    });
    return {
      version: this.changes,
      lines,
      tasks,
      byRow,
      longest,
      hasMilestones,
      links: [...this.linkList],
      lineOfRow,
      groupSpans: spans,
    };
  }
}

function spanOf(rows: readonly GanttRow[], tasks: readonly GanttTask[], group: string): readonly [number, number] {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const task of tasks) {
    if (rows[task.row]?.group === group) {
      start = Math.min(start, task.start);
      end = Math.max(end, task.end);
    }
  }
  return Number.isFinite(start) ? [start, end] : [0, 0];
}

// Groups show whether they are open; tasks of a group stand indented.
function nameOf(line: GanttLine): string {
  if (line.isGroup) {
    return (line.isCollapsed ? '+ ' : '− ') + line.name;
  }
  return line.group === undefined ? line.name : '   ' + line.name;
}

/** The names of the lines of a Gantt chart, as its category axis shows them. */
export function ganttLineNames(data: GanttData): string[] {
  return data.current.lines.map(nameOf);
}

/** Tasks as bars in rows over time, groups as thin bars over their span, milestones as diamonds. */
export class GanttSeries extends ChartSeries {
  private readonly mesh = new Mesh();
  private palette: readonly Rgba8[] = [
    { r: 76, g: 201, b: 240, a: 255 },
    { r: 247, g: 37, b: 133, a: 255 },
    { r: 255, g: 190, b: 11, a: 255 },
    { r: 6, g: 214, b: 160, a: 255 },
    { r: 131, g: 56, b: 236, a: 255 },
  ];
  private height = 0.6;
  private hovered = -1;
  private appearance = 0;
  private built = -1;
  private linesVersion = -1;
  private builtFrame: SeriesFrame | undefined;

  /**
   * @param data - The tasks.
   * @param xAxis - The time axis.
   * @param yAxis - The category axis of the lines.
   */
  constructor(
    /** The tasks. */
    readonly data: GanttData,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** The height of a bar as a share of a line; 0.6 by default. */
  get barHeight(): number {
    return this.height;
  }

  set barHeight(value: number) {
    if (!(value > 0 && value <= 1)) {
      throw new RangeError('The bar height must lie above 0 and up to 1.');
    }
    this.height = value;
    this.appearance++;
  }

  /** The task under the pointer, -1 for none. */
  get hoveredTask(): number {
    return this.hovered;
  }

  set hoveredTask(value: number) {
    if (value !== this.hovered) {
      this.hovered = value;
      this.appearance++;
    }
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.palette[0] as Rgba8;
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.data.version + this.appearance;
  }

  /** {@inheritDoc ChartSeries.onPalette} */
  override onPalette(palette: readonly Rgba8[]): void {
    this.palette = [...palette];
    this.appearance++;
  }

  /** @internal The color of a task. */
  colorOf(task: GanttTask): Rgba8 {
    return task.color && task.color.a > 0 ? task.color : (this.palette[task.row % this.palette.length] as Rgba8);
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(axis: 'x' | 'y'): DoubleRange | undefined {
    const state = this.data.current;
    if (state.tasks.length === 0) {
      return undefined;
    }
    if (axis === 'y') {
      return new DoubleRange(-0.5, Math.max(state.lines.length - 0.5, 0.5));
    }
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const task of state.tasks) {
      start = Math.min(start, task.start);
      end = Math.max(end, task.end);
    }
    const origin = originOf(this.xAxis);
    // Some room on both sides, so that the first and last bar and a milestone at the end show whole.
    const room = Math.max((end - start) * 0.03, 1);
    return new DoubleRange(start - origin - room, end - origin + room);
  }

  /** @internal The line at a position of the layout, -1 for none. */
  findLine(layout: ChartLayoutResult, y: number): number {
    const lines = this.transforms(layout)?.lines;
    if (!lines) {
      return -1;
    }
    const line = roundHalfEven(lines.toData(y));
    return line >= 0 && line < this.data.current.lines.length ? line : -1;
  }

  /** @internal The task at a position of the layout, -1 for none. */
  findTask(layout: ChartLayoutResult, position: Point): number {
    const line = this.findLine(layout, position.y);
    const transforms = this.transforms(layout);
    if (line < 0 || !transforms) {
      return -1;
    }
    const state = this.data.current;
    const entry = state.lines[line] as GanttLine;
    if (entry.isGroup || Math.abs(transforms.lines.toData(position.y) - line) > this.height / 2) {
      return -1;
    }
    const origin = originOf(this.xAxis);
    const at = transforms.time.toData(position.x) + origin;
    const reach = Math.abs(transforms.time.toData(position.x + milestoneRadius) - transforms.time.toData(position.x));
    const tasks = state.byRow[entry.row] as readonly number[];
    let found = -1;
    for (
      let i = firstVisibleTask(state, entry.row, at - reach);
      i < tasks.length && (state.tasks[tasks[i] as number] as GanttTask).start <= at + reach;
      i++
    ) {
      const task = state.tasks[tasks[i] as number] as GanttTask;
      const start = isMilestone(task) ? task.start - reach : task.start;
      const end = isMilestone(task) ? task.start + reach : task.end;
      if (at >= start && at <= end) {
        found = tasks[i] as number;
      }
    }
    return found;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(_device: RenderDevice, frame: SeriesFrame): void {
    if (this.version === this.built && frame === this.builtFrame) {
      return;
    }
    const state = this.data.current;
    const axis = this.yAxis;
    if (state.version !== this.linesVersion && axis instanceof CategoryAxis) {
      // New or collapsed lines: the axis shows their names; the visible range stays where it was.
      const range = axis.visibleRange;
      const isSameCount = axis.categories.length === state.lines.length;
      axis.categories = state.lines.map(nameOf);
      if (isSameCount) {
        axis.visibleRange = range;
      }
      this.linesVersion = state.version;
    }
    this.mesh.clear();
    const bounds = frame.bounds;
    const top = frame.y.toData(bounds.y);
    const bottom = frame.y.toData(f(bounds.y + bounds.height));
    const first = Math.max(0, Math.floor(Math.min(top, bottom)));
    const last = Math.min(state.lines.length - 1, Math.ceil(Math.max(top, bottom)));
    const origin = originOf(this.xAxis);
    const left = frame.x.toData(bounds.x) + origin;
    const right = frame.x.toData(f(bounds.x + bounds.width)) + origin;
    const from = Math.min(left, right);
    const to = Math.max(left, right);
    const half = f((Math.abs(frame.y.pixelsPerUnit) * this.height) / 2);
    for (let line = first; line <= last; line++) {
      const center = f(frame.y.toPixel(line));
      const entry = state.lines[line] as GanttLine;
      if (entry.isGroup) {
        this.addGroup(frame, state.groupSpans[line] as readonly [number, number], origin, center, half);
        continue;
      }
      this.addRow(frame, state, entry.row, from, to, origin, center, half);
    }
    this.built = this.version;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.mesh.count > 0) {
      commands.fillMesh(this.mesh.data, this.mesh.count, frame.bounds);
    }
  }

  private transforms(layout: ChartLayoutResult): { time: LinearAxisTransform; lines: LinearAxisTransform } | undefined {
    let time: LinearAxisTransform | undefined;
    let lines: LinearAxisTransform | undefined;
    for (const placement of layout.axes) {
      const bounds = placement.bounds;
      if (placement.axis === this.xAxis) {
        time = this.xAxis.createTransform(bounds.x, bounds.width);
      } else if (placement.axis === this.yAxis) {
        lines = this.yAxis.createTransform(bounds.y, bounds.height);
      }
    }
    return time && lines ? { time, lines } : undefined;
  }

  private addGroup(
    frame: SeriesFrame,
    span: readonly [number, number],
    origin: number,
    center: number,
    half: number,
  ): void {
    if (span[1] <= span[0]) {
      return;
    }
    const a = f(frame.x.toPixel(span[0] - origin));
    const b = f(frame.x.toPixel(span[1] - origin));
    const thin = Math.max(2, f(half * f(0.35)));
    addRectangle(this.mesh, Math.min(a, b), f(center - thin), Math.max(a, b), f(center + thin), {
      r: 150,
      g: 160,
      b: 175,
      a: 200,
    });
  }

  // The tasks of a row in the visible time; bars thinner than a pixel that touch the previous one extend it.
  private addRow(
    frame: SeriesFrame,
    state: GanttState,
    row: number,
    from: number,
    to: number,
    origin: number,
    center: number,
    half: number,
  ): void {
    const tasks = state.byRow[row] as readonly number[];
    let mergeStart = Number.NaN;
    let mergeEnd = Number.NaN;
    let mergeColor: Rgba8 = { r: 0, g: 0, b: 0, a: 0 };
    for (
      let i = firstVisibleTask(state, row, from);
      i < tasks.length && (state.tasks[tasks[i] as number] as GanttTask).start <= to;
      i++
    ) {
      const task = state.tasks[tasks[i] as number] as GanttTask;
      if (task.end < from) {
        continue;
      }
      let color = this.colorOf(task);
      if (tasks[i] === this.hovered) {
        color = {
          r: color.r + Math.trunc((255 - color.r) / 3),
          g: color.g + Math.trunc((255 - color.g) / 3),
          b: color.b + Math.trunc((255 - color.b) / 3),
          a: color.a,
        };
      }
      const start = f(frame.x.toPixel(task.start - origin));
      if (isMilestone(task)) {
        this.addDiamond(start, center, Math.min(f(milestoneRadius * f(frame.dpiScale)), f(half + 2)), color);
        continue;
      }
      const exact = f(frame.x.toPixel(task.end - origin));
      const end = Math.max(exact, f(start + 1));
      if (!Number.isNaN(mergeEnd) && f(exact - start) < 1 && start <= f(mergeEnd + 1)) {
        mergeEnd = Math.max(mergeEnd, end);
        continue;
      }
      this.flush(mergeStart, mergeEnd, center, half, mergeColor);
      mergeStart = start;
      mergeEnd = end;
      mergeColor = color;
    }
    this.flush(mergeStart, mergeEnd, center, half, mergeColor);
  }

  private flush(start: number, end: number, center: number, half: number, color: Rgba8): void {
    if (!Number.isNaN(start)) {
      addRectangle(this.mesh, start, f(center - half), end, f(center + half), color);
    }
  }

  private addDiamond(x: number, y: number, radius: number, color: Rgba8): void {
    const top = { x, y: f(y - radius), color };
    const right = { x: f(x + radius), y, color };
    const bottom = { x, y: f(y + radius), color };
    const left = { x: f(x - radius), y, color };
    const packed = packRgba8(color);
    for (const corner of [top, right, bottom, top, bottom, left]) {
      this.mesh.add(corner.x, corner.y, packed);
    }
    addFringe(this.mesh, top, right, x, y);
    addFringe(this.mesh, right, bottom, x, y);
    addFringe(this.mesh, bottom, left, x, y);
    addFringe(this.mesh, left, top, x, y);
  }
}

const labelSize = 11;
const mostLabels = 1000;
const shortestLabel = 24;
const mostLinks = 2000;

// A duration as days, hours and minutes, or hours, minutes and seconds below a day.
function durationOf(axis: Axis, length: number): string {
  if (axis instanceof DateTimeAxis) {
    const nanoseconds = { milliseconds: 1e6, ticks: 100, nanoseconds: 1 }[axis.resolution];
    const seconds = Math.trunc((length * nanoseconds) / 1e9);
    const pad = (value: number): string => String(value).padStart(2, '0');
    const days = Math.trunc(seconds / 86_400);
    const hours = Math.trunc((seconds % 86_400) / 3600);
    const minutes = Math.trunc((seconds % 3600) / 60);
    return days >= 1
      ? `${String(days)}.${pad(hours)}:${pad(minutes)} d`
      : `${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}`;
  }
  return formatGeneral(length, 6, chartText.culture);
}

/** @internal The labels inside the bars, beside milestones, the arrows of dependencies and the task under the pointer. */
export class GanttOverlay extends ChartOverlay {
  constructor(private readonly series: GanttSeries) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.series.version + chartText.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const series = this.series;
    const state = series.data.current;
    const origin = originOf(series.xAxis);
    const pane = canvas.layout.panes[0];
    // Labels belong level inside the bars and arrows run right, down and right: a turned chart shows neither.
    if (!series.xAxis.isHorizontal || !pane) {
      this.drawHover(canvas, state, origin);
      return;
    }
    canvas.clip = pane;
    const line = canvas.lineHeight(labelSize);
    // Only the visible lines and times, found like the bars of the series.
    const topLine = canvas.valueAt(series.yAxis, pane.y) ?? 0;
    const bottomLine = canvas.valueAt(series.yAxis, pane.bottom) ?? 0;
    const leftTime = canvas.valueAt(series.xAxis, pane.x) ?? 0;
    const rightTime = canvas.valueAt(series.xAxis, pane.right) ?? 0;
    const first = Math.max(0, Math.floor(Math.min(topLine, bottomLine)));
    const last = Math.min(state.lines.length - 1, Math.ceil(Math.max(topLine, bottomLine)));
    const from = Math.min(leftTime, rightTime) + origin;
    const to = Math.max(leftTime, rightTime) + origin;
    const leftPixel = canvas.positionOf(series.xAxis, leftTime) ?? 0;
    const rightPixel = canvas.positionOf(series.xAxis, rightTime) ?? 0;
    const perUnit = rightTime !== leftTime ? Math.abs((rightPixel - leftPixel) / (rightTime - leftTime)) : 0;
    let labels = 0;
    for (let index = first; index <= last && labels < mostLabels; index++) {
      labels = this.drawRow(
        canvas,
        state,
        state.lines[index] as GanttLine,
        from,
        to,
        perUnit,
        origin,
        line,
        pane,
        labels,
      );
    }
    this.drawLinks(canvas, state, origin);
    canvas.clip = undefined;
    this.drawHover(canvas, state, origin);
  }

  // Rows whose longest task is too narrow for any label are skipped as a whole, except for milestones.
  private drawRow(
    canvas: OverlayCanvas,
    state: GanttState,
    entry: GanttLine,
    from: number,
    to: number,
    perUnit: number,
    origin: number,
    line: number,
    pane: DipRect,
    labels: number,
  ): number {
    if (
      entry.isGroup ||
      ((state.longest[entry.row] as number) * perUnit < shortestLabel && state.hasMilestones[entry.row] !== true)
    ) {
      return labels;
    }
    const tasks = state.byRow[entry.row] as readonly number[];
    let count = labels;
    for (
      let k = firstVisibleTask(state, entry.row, from);
      k < tasks.length && (state.tasks[tasks[k] as number] as GanttTask).start <= to && count < mostLabels;
      k++
    ) {
      const task = state.tasks[tasks[k] as number] as GanttTask;
      if (isMilestone(task) || (task.end - task.start) * perUnit >= shortestLabel) {
        count += this.drawLabel(canvas, state, task, origin, line, pane) ? 1 : 0;
      }
    }
    return count;
  }

  private drawLabel(
    canvas: OverlayCanvas,
    state: GanttState,
    task: GanttTask,
    origin: number,
    line: number,
    pane: DipRect,
  ): boolean {
    const label = task.label ?? '';
    const place = this.place(canvas, state, task.row, task.start - origin);
    if (label.length === 0 || !place) {
      return false;
    }
    const width = canvas.measureWidth(label, labelSize);
    // A milestone has its name beside the diamond.
    if (isMilestone(task)) {
      const at = place.x + 9 + width > pane.right ? place.x - 9 - width : place.x + 9;
      canvas.drawText(label, roundHalfEven(at), roundHalfEven(place.y + line * 0.35), labelSize, canvas.colors.text);
      return true;
    }
    const right = canvas.positionOf(this.series.xAxis, task.end - origin) ?? 0;
    if (right - place.x < width + 8 || right < pane.x || place.x > pane.right) {
      return false;
    }
    canvas.drawText(
      label,
      roundHalfEven(Math.max(place.x, pane.x) + 4),
      roundHalfEven(place.y + line * 0.35),
      labelSize,
      { r: 255, g: 255, b: 255, a: 235 },
    );
    return true;
  }

  private place(canvas: OverlayCanvas, state: GanttState, row: number, time: number): Point | undefined {
    const line = state.lineOfRow[row] ?? -1;
    return line < 0 ? undefined : canvas.pointOf(this.series.xAxis, this.series.yAxis, time, line);
  }

  // From the end of the first task right, down or up to the line of the second, and right into its start.
  private drawLinks(canvas: OverlayCanvas, state: GanttState, origin: number): void {
    const color = { ...canvas.colors.text, a: 170 };
    let drawn = 0;
    for (const [fromIndex, toIndex] of state.links) {
      const from = state.tasks[fromIndex] as GanttTask;
      const to = state.tasks[toIndex] as GanttTask;
      const start = drawn < mostLinks ? this.place(canvas, state, from.row, from.end - origin) : undefined;
      const end = start ? this.place(canvas, state, to.row, to.start - origin) : undefined;
      if (!start || !end) {
        continue;
      }
      const bend = f(Math.max(start.x + 6, end.x - 6));
      const a = { x: f(start.x), y: f(start.y) };
      const b = { x: bend, y: f(start.y) };
      const c = { x: bend, y: f(end.y) };
      const d = { x: f(end.x), y: f(end.y) };
      canvas.drawLine(a, b, 1, color);
      canvas.drawLine(b, c, 1, color);
      canvas.drawLine(c, d, 1, color);
      canvas.fillTriangle(d, { x: f(d.x - 5), y: f(d.y - 3) }, { x: f(d.x - 5), y: f(d.y + 3) }, color);
      drawn++;
    }
  }

  private drawHover(canvas: OverlayCanvas, state: GanttState, origin: number): void {
    const index = this.series.hoveredTask;
    const task = state.tasks[index];
    const place = task ? this.place(canvas, state, task.row, task.start - origin) : undefined;
    if (!task || !place) {
      return;
    }
    const axis = this.series.xAxis;
    const label = task.label ?? '';
    const name = label.length > 0 ? `${label}: ` : '';
    const text = isMilestone(task)
      ? name + axis.formatCursorValue(task.start - origin)
      : `${name}${axis.formatCursorValue(task.start - origin)} – ${axis.formatCursorValue(task.end - origin)} (${durationOf(axis, task.end - task.start)})`;
    canvas.drawLabel(text, place.x, place.y + 12, { ...canvas.colors.background, a: 235 }, canvas.colors.text);
  }
}

/** Follows the pointer over the tasks and collapses or opens a group on a click on its line. */
export class GanttModifier extends ChartModifier {
  constructor() {
    super(ZoomPanModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const chart = this.interaction?.chart;
    const layout = chart?.currentLayout;
    const gantt = chart?.series.find((series) => series instanceof GanttSeries);
    if (!layout || !gantt) {
      return 'ignored';
    }
    if (input.kind === 'exited' || input.kind === 'canceled') {
      gantt.hoveredTask = -1;
      return 'ignored';
    }
    if (input.kind === 'moved') {
      gantt.hoveredTask = gantt.findTask(layout, input.position);
      return 'ignored';
    }
    if (input.kind === 'pressed' && input.changedButton === 'primary') {
      const line = gantt.findLine(layout, input.position.y);
      const entry = gantt.data.current.lines[line];
      if (!entry?.isGroup || input.position.x > layout.plotArea.right) {
        return 'ignored';
      }
      gantt.data.setCollapsed(entry.name, !entry.isCollapsed);
      return 'handled';
    }
    return 'ignored';
  }
}

/** Describes a Gantt chart of the data: the lines on an inverted category axis, the bars, labels and arrows. */
export function gantt(builder: ChartBuilder, data: GanttData, configure?: (series: GanttSeries) => void): ChartBuilder {
  return builder
    .yAxis((a) => a.category(ganttLineNames(data), 'gantt').inverted())
    .addSeries(
      (x, y) => {
        const series = new GanttSeries(data, x, y);
        configure?.(series);
        return series;
      },
      undefined,
      'gantt',
    )
    .addOverlay(
      (chart) => new GanttOverlay(chart.series.find((series) => series instanceof GanttSeries) as GanttSeries),
    )
    .addModifier(() => new GanttModifier());
}
