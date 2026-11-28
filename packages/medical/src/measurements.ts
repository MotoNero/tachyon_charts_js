// Measuring in millimetres on medical images, as MedicalMeasurement, MedicalMeasurementLayer, MedicalMeasurementModifier
// and MedicalToolBar of the .NET version: distances, angles and regions with the statistics of the pixels inside,
// drawn above the image, moved with the pointer, undone with Ctrl+Z, saved as JSON.
import {
  ChartModifier,
  ChartOverlay,
  DipRect,
  type Axis,
  type ChartInteraction,
  type ChartLayoutResult,
  type ChartSurface,
  type DoubleRange,
  type KeyInputEvent,
  type ModifierResult,
  type OverlayCanvas,
  type Point,
  type PointerInputEvent,
  type Rgba8,
} from '@tachyon-charts/core';
import type { ImageSpacing, MedicalWindow } from './medical-image';

/** What a measurement measures. */
export type MedicalMeasurementKind = 'distance' | 'angle' | 'circle' | 'rectangle' | 'freehand';

/** A point of a measurement in millimetres from the top left corner of the image. */
export interface MedicalPoint {
  /** Across, to the right. */
  readonly x: number;
  /** Down. */
  readonly y: number;
}

/** What a measurement found; values that do not apply to its kind are NaN. */
export interface MedicalMeasurementResult {
  /** The length of a distance or the circumference of a region in millimetres. */
  readonly length: number;
  /** The angle in degrees. */
  readonly angle: number;
  /** The area of a region in square millimetres. */
  readonly area: number;
  /** The pixels inside a region. */
  readonly pixelCount: number;
  /** Their mean value. */
  readonly mean: number;
  /** Their standard deviation. */
  readonly standardDeviation: number;
  /** Their lowest value. */
  readonly minimum: number;
  /** Their highest value. */
  readonly maximum: number;
}

/** @internal What measurements read: the image, its slices, its unit and its window. */
export interface MedicalMeasurementSource {
  readonly width: number;
  readonly height: number;
  readonly spacing: ImageSpacing;
  readonly slice: number;
  readonly sliceCount: number;
  readonly sliceDistance: number;
  readonly unit: string;
  read(slice: number, column: number, row: number): number;
  readonly valueRange: DoubleRange;
  readonly window: MedicalWindow;
}

const empty: MedicalMeasurementResult = {
  length: Number.NaN,
  angle: Number.NaN,
  area: Number.NaN,
  pixelCount: 0,
  mean: Number.NaN,
  standardDeviation: Number.NaN,
  minimum: Number.NaN,
  maximum: Number.NaN,
};

const distance = (a: MedicalPoint, b: MedicalPoint): number =>
  Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));

// Sets new points of a measurement, or none, and calculates it again.
let changeMeasurement: (
  measurement: MedicalMeasurement,
  points: readonly MedicalPoint[] | undefined,
  source: MedicalMeasurementSource,
) => void;

/** A measurement on one slice of an image. */
export class MedicalMeasurement {
  private shape: readonly MedicalPoint[];
  private border: readonly MedicalPoint[];
  private found: MedicalMeasurementResult = empty;

  /** @internal Use {@link MedicalMeasurementLayer.add}. */
  constructor(
    /** What it measures. */
    readonly kind: MedicalMeasurementKind,
    points: readonly MedicalPoint[],
    /** The slice it lies on. */
    readonly slice: number,
    /** The name, such as Width; regions of the same name on several slices make a volume. */
    public name: string,
  ) {
    this.shape = validate(kind, points);
    this.border = outlineOf(kind, this.shape);
  }

  /** The points: the ends of a distance, the arms and vertex of an angle, centre and rim of a circle, corners or a path. */
  get points(): readonly MedicalPoint[] {
    return this.shape;
  }

  /** @internal The outline of a region: 96 corners for a circle, 4 for a rectangle, the path for freehand. */
  get outline(): readonly MedicalPoint[] {
    return this.border;
  }

  /** What it found. */
  get result(): MedicalMeasurementResult {
    return this.found;
  }

  /** @internal Whether it encloses pixels. */
  get isRegion(): boolean {
    return this.kind === 'circle' || this.kind === 'rectangle' || this.kind === 'freehand';
  }

  static {
    changeMeasurement = (measurement, points, source) => {
      if (points) {
        const valid = validate(measurement.kind, points);
        measurement.border = outlineOf(measurement.kind, valid);
        measurement.shape = valid;
      }
      measurement.found = calculate(measurement.kind, measurement.shape, measurement.slice, source);
    };
  }
}

function calculate(
  kind: MedicalMeasurementKind,
  points: readonly MedicalPoint[],
  slice: number,
  source: MedicalMeasurementSource,
): MedicalMeasurementResult {
  if (kind === 'distance') {
    return { ...empty, length: distance(points[0] as MedicalPoint, points[1] as MedicalPoint) };
  }
  if (kind === 'angle') {
    return {
      ...empty,
      angle: angleAt(points[0] as MedicalPoint, points[1] as MedicalPoint, points[2] as MedicalPoint),
    };
  }
  const outline = outlineOf(kind, points);
  return {
    ...statistics(outline, slice, source),
    length: circumference(kind, points, outline),
    area: area(kind, points, outline),
  };
}

/** @internal The outline of a region; the points themselves for other kinds. */
export function outlineOf(kind: MedicalMeasurementKind, points: readonly MedicalPoint[]): readonly MedicalPoint[] {
  if (kind === 'circle') {
    const centre = points[0] as MedicalPoint;
    const radius = distance(centre, points[1] as MedicalPoint);
    return Array.from({ length: 96 }, (_, i) => {
      const angle = (2 * Math.PI * i) / 96;
      return { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) };
    });
  }
  if (kind === 'rectangle') {
    const a = points[0] as MedicalPoint;
    const b = points[1] as MedicalPoint;
    return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
  }
  return points;
}

function angleAt(a: MedicalPoint, vertex: MedicalPoint, c: MedicalPoint): number {
  const ux = a.x - vertex.x;
  const uy = a.y - vertex.y;
  const vx = c.x - vertex.x;
  const vy = c.y - vertex.y;
  const lengths = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
  return lengths > 0
    ? (Math.acos(Math.min(Math.max((ux * vx + uy * vy) / lengths, -1), 1)) * 180) / Math.PI
    : Number.NaN;
}

// Exact for a circle and a rectangle; the polygon of an outline otherwise.
function area(kind: MedicalMeasurementKind, points: readonly MedicalPoint[], outline: readonly MedicalPoint[]): number {
  if (kind === 'circle') {
    const radius = distance(points[0] as MedicalPoint, points[1] as MedicalPoint);
    return Math.PI * radius * radius;
  }
  let twice = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[j] as MedicalPoint;
    const b = outline[i] as MedicalPoint;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

function circumference(
  kind: MedicalMeasurementKind,
  points: readonly MedicalPoint[],
  outline: readonly MedicalPoint[],
): number {
  if (kind === 'circle') {
    return 2 * Math.PI * distance(points[0] as MedicalPoint, points[1] as MedicalPoint);
  }
  let length = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    length += distance(outline[j] as MedicalPoint, outline[i] as MedicalPoint);
  }
  return length;
}

// The statistics of the pixels inside; the running mean and sum of squares of Welford stay exact for large values.
function statistics(
  outline: readonly MedicalPoint[],
  slice: number,
  source: MedicalMeasurementSource,
): MedicalMeasurementResult {
  let count = 0;
  let mean = 0;
  let squares = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  forEachInside(outline, slice, source, (value) => {
    count++;
    const delta = value - mean;
    mean += delta / count;
    squares += delta * (value - mean);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  });
  return count === 0
    ? empty
    : { ...empty, pixelCount: count, mean, standardDeviation: Math.sqrt(squares / count), minimum, maximum };
}

/** @internal Visits the values of the pixels whose middles lie inside an outline. */
export function forEachInside(
  outline: readonly MedicalPoint[],
  slice: number,
  source: MedicalMeasurementSource,
  visit: (value: number) => void,
): void {
  const spacing = source.spacing;
  let top = Infinity;
  let bottom = -Infinity;
  for (const point of outline) {
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  const firstRow = Math.max(0, Math.floor(top / spacing.row - 0.5));
  const lastRow = Math.min(source.height - 1, Math.ceil(bottom / spacing.row - 0.5));
  const crossings: number[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    cross(outline, (row + 0.5) * spacing.row, crossings);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const first = Math.max(0, Math.ceil((crossings[k] as number) / spacing.column - 0.5));
      const last = Math.min(source.width - 1, Math.floor((crossings[k + 1] as number) / spacing.column - 0.5));
      for (let column = first; column <= last; column++) {
        const value = source.read(slice, column, row);
        if (Number.isFinite(value)) {
          visit(value);
        }
      }
    }
  }
}

// Where a row crosses the edges of the outline, from left to right.
function cross(outline: readonly MedicalPoint[], y: number, crossings: number[]): void {
  crossings.length = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[j] as MedicalPoint;
    const b = outline[i] as MedicalPoint;
    if ((a.y <= y && y < b.y) || (b.y <= y && y < a.y)) {
      crossings.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
  }
  crossings.sort((p, q) => p - q);
}

function validate(kind: MedicalMeasurementKind, points: readonly MedicalPoint[]): readonly MedicalPoint[] {
  const needed = kind === 'angle' ? 3 : kind === 'freehand' ? -3 : 2;
  if ((needed > 0 && points.length !== needed) || (needed < 0 && points.length < -needed)) {
    throw new RangeError(
      `A ${kind} needs ${needed > 0 ? `exactly ${String(needed)}` : `at least ${String(-needed)}`} points, not ${String(points.length)}.`,
    );
  }
  return points.map((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new RangeError('The points must be finite.');
    }
    return { x: point.x, y: point.y };
  });
}

/** @internal The name a measurement gets when none is given. */
export function defaultName(kind: MedicalMeasurementKind): string {
  return kind === 'distance' ? 'Distance' : kind === 'angle' ? 'Angle' : 'Region';
}

function format(kind: MedicalMeasurementKind, result: MedicalMeasurementResult, unit: string): string {
  if (kind === 'distance') {
    return `${result.length.toFixed(1)} mm`;
  }
  if (kind === 'angle') {
    return `${result.angle.toFixed(1)}°`;
  }
  if (result.pixelCount === 0) {
    return `${result.area.toFixed(1)} mm²`;
  }
  return `${result.area.toFixed(1)} mm²  ${result.mean.toFixed(1)} ± ${result.standardDeviation.toFixed(1)} ${unit}  (${result.minimum.toFixed(0)} to ${result.maximum.toFixed(0)})`;
}

const handleSize = 3;
const color: Rgba8 = { r: 255, g: 214, b: 10, a: 255 };
const selectedColor: Rgba8 = { r: 80, g: 220, b: 255, a: 255 };
const fileVersion = 1;

type ToolButton = MedicalMeasurementKind | 'delete';
const buttons: readonly ToolButton[] = ['distance', 'angle', 'circle', 'rectangle', 'freehand', 'delete'];
const buttonNames: readonly string[] = [
  'Distance (D), click again to stop',
  'Angle (A), click again to stop',
  'Circle (C), click again to stop',
  'Rectangle (R), click again to stop',
  'Freehand (F), click again to stop',
  'Delete the selected measurement (Del)',
];

interface LayerParts {
  readonly source: MedicalMeasurementSource;
  draft(): readonly MedicalPoint[] | undefined;
  setDraft(value: readonly MedicalPoint[] | undefined): void;
  setHovered(value: ToolButton | undefined): void;
}

let createLayer: (source: MedicalMeasurementSource) => MedicalMeasurementLayer;
let layerParts: (layer: MedicalMeasurementLayer) => LayerParts;

/** @internal A layer of measurements on a source. */
export function newMeasurementLayer(source: MedicalMeasurementSource): MedicalMeasurementLayer {
  return createLayer(source);
}

/** @internal What a layer measures. */
export function measurementSourceOf(layer: MedicalMeasurementLayer): MedicalMeasurementSource {
  return layerParts(layer).source;
}

/** The measurements of an image, drawn above it; with the tools of the bar or the keys D, A, C, R and F. */
export class MedicalMeasurementLayer extends ChartOverlay {
  private readonly items: MedicalMeasurement[] = [];
  private readonly labels = new Map<MedicalMeasurement, string>();
  private readonly listeners = new Set<(measurement: MedicalMeasurement) => void>();
  private xAxis: Axis | undefined;
  private yAxis: Axis | undefined;
  private chosen: MedicalMeasurementKind | undefined;
  private toolsShown = false;
  private hover: ToolButton | undefined;
  private drafted: readonly MedicalPoint[] | undefined;
  private picked: MedicalMeasurement | undefined;

  static {
    createLayer = (source) => new MedicalMeasurementLayer(source);
    layerParts = (layer) => ({
      source: layer.source,
      draft: () => layer.drafted,
      setDraft: (value) => {
        layer.drafted = value;
        layer.changed();
      },
      setHovered: (value) => {
        if (layer.hover !== value) {
          layer.hover = value;
          layer.changed();
        }
      },
    });
  }

  private constructor(private readonly source: MedicalMeasurementSource) {
    super();
  }

  /** The measurements. */
  get measurements(): readonly MedicalMeasurement[] {
    return this.items;
  }

  /** The tool a drag draws with; undefined while a drag moves points or sets the window. */
  get tool(): MedicalMeasurementKind | undefined {
    return this.chosen;
  }

  set tool(value: MedicalMeasurementKind | undefined) {
    this.chosen = value;
    this.drafted = undefined;
    this.changed();
  }

  /** Whether the bar of tools shows in the lower left corner of the image. */
  get showsTools(): boolean {
    return this.toolsShown;
  }

  set showsTools(value: boolean) {
    this.toolsShown = value;
    this.changed();
  }

  /** The measurement drawn or touched last with the pointer. */
  get selected(): MedicalMeasurement | undefined {
    return this.picked;
  }

  /** The unit of the values, such as HU. */
  get unit(): string {
    return this.source.unit;
  }

  /** Calls a function whenever a measurement is added, moved or removed; returns a function that stops it. */
  onChanged(listener: (measurement: MedicalMeasurement) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Adds a measurement in millimetres from the top left corner of the image.
   * @param slice - The slice; the one shown when left out.
   * @throws RangeError when the points do not suit the kind or the slice does not exist.
   */
  add(
    kind: MedicalMeasurementKind,
    points: readonly MedicalPoint[],
    slice?: number,
    name?: string,
  ): MedicalMeasurement {
    const index = slice ?? this.source.slice;
    if (!(Number.isInteger(index) && index >= 0 && index < this.source.sliceCount)) {
      throw new RangeError('There is no such slice.');
    }
    const measurement = new MedicalMeasurement(kind, points, index, name ?? defaultName(kind));
    changeMeasurement(measurement, undefined, this.source);
    this.items.push(measurement);
    this.picked = undefined;
    this.notify(measurement);
    return measurement;
  }

  /** Removes a measurement; false when it is not there. */
  remove(measurement: MedicalMeasurement): boolean {
    const index = this.items.indexOf(measurement);
    if (index < 0) {
      return false;
    }
    this.items.splice(index, 1);
    this.labels.delete(measurement);
    if (this.picked === measurement) {
      this.picked = undefined;
    }
    this.notify(measurement);
    return true;
  }

  /** The volume in cubic millimetres of the regions of a name: their areas times the distance of the slices. */
  volume(name: string): number {
    let total = 0;
    for (const measurement of this.items) {
      if (measurement.isRegion && measurement.name === name) {
        total += measurement.result.area;
      }
    }
    return total * this.source.sliceDistance;
  }

  /** The measurements as JSON, to keep and load again. */
  save(): string {
    return JSON.stringify(
      {
        version: fileVersion,
        measurements: this.items.map((measurement) => ({
          kind: measurement.kind,
          slice: measurement.slice,
          name: measurement.name,
          points: measurement.points.map((point) => [point.x, point.y]),
        })),
      },
      undefined,
      2,
    );
  }

  /**
   * Replaces the measurements with those of a JSON text from {@link MedicalMeasurementLayer.save}.
   * @throws SyntaxError when the text is no measurement file or a measurement is invalid; nothing changes then.
   */
  load(json: string): void {
    let file: { version?: unknown; measurements?: unknown };
    try {
      file = JSON.parse(json) as { version?: unknown; measurements?: unknown };
    } catch (error) {
      throw new SyntaxError(
        `The text is no measurement file: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!Array.isArray(file.measurements)) {
      throw new SyntaxError('The text holds no measurements.');
    }
    if (typeof file.version === 'number' && file.version > fileVersion) {
      throw new SyntaxError(`The measurements were saved by a newer version (${String(file.version)}).`);
    }
    const loaded = (file.measurements as unknown[]).map((item) => {
      const entry = item as { kind?: unknown; slice?: unknown; name?: unknown; points?: unknown };
      try {
        const slice = Number(entry.slice);
        if (!(Number.isInteger(slice) && slice >= 0 && slice < this.source.sliceCount)) {
          throw new RangeError('There is no such slice.');
        }
        if (!buttons.includes(entry.kind as ToolButton) || entry.kind === 'delete') {
          throw new RangeError('The kind is unknown.');
        }
        const kind = entry.kind as MedicalMeasurementKind;
        const points = (Array.isArray(entry.points) ? (entry.points as unknown[]) : []).map((pair) => {
          if (!Array.isArray(pair) || pair.length !== 2) {
            throw new RangeError('A point needs two numbers.');
          }
          return { x: Number(pair[0]), y: Number(pair[1]) };
        });
        return new MedicalMeasurement(
          kind,
          points,
          slice,
          typeof entry.name === 'string' ? entry.name : defaultName(kind),
        );
      } catch (error) {
        throw new SyntaxError(`A measurement is invalid: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    });
    this.items.length = 0;
    this.labels.clear();
    this.picked = undefined;
    for (const measurement of loaded) {
      this.insert(measurement, this.items.length);
    }
    this.changed();
  }

  /** @internal Takes the axes of the image from a chart; given to the chart as its overlay. */
  attach(chart: ChartSurface): this {
    this.xAxis = chart.horizontalAxes[0];
    this.yAxis = chart.panes[0]?.axes[0];
    return this;
  }

  /** @internal Puts a measurement back at its place, such as when a removal is undone. */
  insert(measurement: MedicalMeasurement, index: number): void {
    changeMeasurement(measurement, undefined, this.source);
    this.items.splice(Math.min(index, this.items.length), 0, measurement);
    this.picked = measurement;
    this.notify(measurement);
  }

  /** @internal Moves the points of a measurement and selects it. */
  moveTo(measurement: MedicalMeasurement, points: readonly MedicalPoint[]): void {
    changeMeasurement(measurement, points, this.source);
    this.picked = measurement;
    this.notify(measurement);
  }

  /** @internal Selects a measurement, or none. */
  select(measurement: MedicalMeasurement | undefined): void {
    this.picked = measurement;
    this.changed();
  }

  /** @internal The nearest point of a measurement on the slice shown, within reach of the pointer. */
  findPoint(
    layout: ChartLayoutResult,
    position: Point,
    reach: number,
  ): { measurement: MedicalMeasurement; index: number } | undefined {
    let best = reach * reach;
    let found: { measurement: MedicalMeasurement; index: number } | undefined;
    for (const candidate of this.items) {
      if (candidate.slice !== this.source.slice) {
        continue;
      }
      candidate.points.forEach((point, index) => {
        const at = this.map(layout, point);
        if (at) {
          const squared = (at.x - position.x) ** 2 + (at.y - position.y) ** 2;
          if (squared <= best) {
            best = squared;
            found = { measurement: candidate, index };
          }
        }
      });
    }
    return found;
  }

  /** @internal Millimetres to a place on the chart. */
  map(layout: ChartLayoutResult, point: MedicalPoint): Point | undefined {
    const x = this.transform(layout, this.xAxis);
    const y = this.transform(layout, this.yAxis);
    return x && y ? { x: Math.fround(x.toPixel(point.x)), y: Math.fround(y.toPixel(point.y)) } : undefined;
  }

  /** @internal A place on the chart to millimetres. */
  unmap(layout: ChartLayoutResult, position: Point): MedicalPoint | undefined {
    const x = this.transform(layout, this.xAxis);
    const y = this.transform(layout, this.yAxis);
    return x && y ? { x: x.toData(position.x), y: y.toData(position.y) } : undefined;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const layout = canvas.layout;
    canvas.clip = layout.plotArea;
    for (const measurement of this.items) {
      if (measurement.slice === this.source.slice) {
        const shade = measurement === this.picked ? selectedColor : color;
        this.drawShape(canvas, layout, measurement.kind, measurement.points, measurement.outline, shade, true);
        this.drawLabel(canvas, layout, measurement, shade);
      }
    }
    const tool = this.chosen;
    const draft = this.drafted;
    if (tool && draft && draft.length > 0) {
      const outline = (tool === 'circle' || tool === 'rectangle') && draft.length >= 2 ? outlineOf(tool, draft) : draft;
      this.drawShape(canvas, layout, tool, draft, outline, selectedColor, false);
    }
    if (this.toolsShown) {
      drawToolBar(canvas, tool, this.hover, this.picked !== undefined);
    }
    canvas.clip = undefined;
  }

  private transform(
    layout: ChartLayoutResult,
    axis: Axis | undefined,
  ): ReturnType<Axis['createTransform']> | undefined {
    const placement = layout.axes.find((each) => each.axis === axis);
    if (!placement || !axis) {
      return undefined;
    }
    const bounds = placement.bounds;
    return axis.isHorizontal
      ? axis.createTransform(bounds.x, bounds.width)
      : axis.createTransform(bounds.y, bounds.height);
  }

  private drawShape(
    canvas: OverlayCanvas,
    layout: ChartLayoutResult,
    kind: MedicalMeasurementKind,
    points: readonly MedicalPoint[],
    outline: readonly MedicalPoint[],
    shade: Rgba8,
    isFinished: boolean,
  ): void {
    const isClosed = isFinished
      ? kind === 'circle' || kind === 'rectangle' || kind === 'freehand'
      : kind === 'circle' || kind === 'rectangle';
    for (let i = 1; i < outline.length + (isClosed ? 1 : 0); i++) {
      const from = this.map(layout, outline[i - 1] as MedicalPoint);
      const to = this.map(layout, outline[i % outline.length] as MedicalPoint);
      if (from && to) {
        canvas.drawLine(from, to, 1.5, shade);
      }
    }
    for (const point of points) {
      const at = this.map(layout, point);
      if (at) {
        canvas.fillRectangle(new DipRect(at.x - handleSize, at.y - handleSize, handleSize * 2, handleSize * 2), shade);
      }
    }
  }

  // A distance has its label over the middle of the line, an angle below its vertex, a region below its outline.
  private drawLabel(
    canvas: OverlayCanvas,
    layout: ChartLayoutResult,
    measurement: MedicalMeasurement,
    shade: Rgba8,
  ): void {
    const text = this.labels.get(measurement);
    if (text === undefined) {
      return;
    }
    const points = measurement.points;
    const line = canvas.lineHeight(canvas.labelSize) + 2;
    const background = { ...canvas.colors.background, a: 220 };
    const width = canvas.measureWidth(text, canvas.labelSize);
    if (measurement.kind === 'distance') {
      const a = this.map(layout, points[0] as MedicalPoint);
      const b = this.map(layout, points[1] as MedicalPoint);
      if (a && b) {
        canvas.drawLabel(text, (a.x + b.x) / 2 - width / 2, (a.y + b.y) / 2 - line - 4, background, shade);
      }
      return;
    }
    if (measurement.kind === 'angle') {
      const vertex = this.map(layout, points[1] as MedicalPoint);
      if (vertex) {
        canvas.drawLabel(text, vertex.x - width / 2, vertex.y + 6, background, shade);
      }
      return;
    }
    let left = Infinity;
    let bottom = -Infinity;
    for (const point of measurement.outline) {
      const at = this.map(layout, point);
      if (at) {
        left = Math.min(left, at.x);
        bottom = Math.max(bottom, at.y);
      }
    }
    if (left < Infinity) {
      canvas.drawLabel(text, left, bottom + 4, background, shade);
    }
  }

  private notify(measurement: MedicalMeasurement): void {
    if (this.items.includes(measurement)) {
      this.labels.set(measurement, format(measurement.kind, measurement.result, this.source.unit));
    } else {
      this.labels.delete(measurement);
    }
    for (const listener of this.listeners) {
      listener(measurement);
    }
    this.changed();
  }
}

const buttonSize = 26;
const buttonGap = 3;
const barMargin = 8;

function buttonBounds(pane: DipRect, index: number): DipRect {
  return new DipRect(
    pane.x + barMargin + index * (buttonSize + buttonGap),
    pane.bottom - barMargin - buttonSize,
    buttonSize,
    buttonSize,
  );
}

/** @internal The button of the bar of tools under a place, if any. */
export function hitToolBar(layout: ChartLayoutResult, position: Point): ToolButton | undefined {
  const pane = layout.panes[0];
  if (!pane) {
    return undefined;
  }
  const index = buttons.findIndex((_, i) => {
    const bounds = buttonBounds(pane, i);
    return (
      position.x >= bounds.x && position.x <= bounds.right && position.y >= bounds.y && position.y <= bounds.bottom
    );
  });
  return buttons[index];
}

function drawToolBar(
  canvas: OverlayCanvas,
  tool: MedicalMeasurementKind | undefined,
  hovered: ToolButton | undefined,
  canDelete: boolean,
): void {
  const pane = canvas.layout.panes[0];
  if (!pane) {
    return;
  }
  const ink = canvas.colors.text;
  const back = canvas.colors.background;
  buttons.forEach((button, i) => {
    const bounds = buttonBounds(pane, i);
    const isChosen = button === tool;
    const isHovered = button === hovered;
    canvas.fillRectangle(bounds, isChosen ? { ...selectedColor, a: 90 } : { ...back, a: isHovered ? 250 : 210 });
    canvas.drawRectangle(bounds, isChosen ? selectedColor : { ...ink, a: isHovered ? 200 : 90 });
    const isEnabled = button !== 'delete' || canDelete;
    symbol(canvas, button, bounds, isEnabled ? (isChosen ? selectedColor : ink) : { ...ink, a: 70 });
  });
  if (hovered !== undefined) {
    const index = buttons.indexOf(hovered);
    const bounds = buttonBounds(pane, index);
    canvas.drawLabel(
      buttonNames[index] as string,
      bounds.x,
      bounds.y - canvas.lineHeight(canvas.labelSize) - 8,
      { ...back, a: 235 },
      ink,
    );
  }
}

// A symbol of 12 × 12 in the middle of a button, made of lines.
function symbol(canvas: OverlayCanvas, button: ToolButton, bounds: DipRect, shade: Rgba8): void {
  const f = Math.fround;
  const left = f(bounds.x + 7);
  const top = f(bounds.y + 7);
  const right = f(left + 12);
  const bottom = f(top + 12);
  const width = 1.5;
  const line = (x1: number, y1: number, x2: number, y2: number): void => {
    canvas.drawLine({ x: f(x1), y: f(y1) }, { x: f(x2), y: f(y2) }, width, shade);
  };
  switch (button) {
    case 'distance':
      line(left, bottom, right, top);
      line(left - 2, bottom - 2, left + 2, bottom + 2);
      line(right - 2, top - 2, right + 2, top + 2);
      break;
    case 'angle':
      line(left, bottom, right, bottom);
      line(left, bottom, right, top);
      line(left + 6, bottom, left + 5, bottom - 4);
      break;
    case 'circle': {
      const mx = f(left + 6);
      const my = f(top + 6);
      for (let i = 0; i < 16; i++) {
        const a = f((i * Math.PI) / 8);
        const b = f(((i + 1) * Math.PI) / 8);
        line(mx + Math.cos(a) * 6, my + Math.sin(a) * 6, mx + Math.cos(b) * 6, my + Math.sin(b) * 6);
      }
      break;
    }
    case 'rectangle':
      canvas.drawRectangle(new DipRect(left, top + 2, 12, 8), shade);
      break;
    case 'freehand':
      line(left, top + 8, left + 3, top + 3);
      line(left + 3, top + 3, left + 6, top + 9);
      line(left + 6, top + 9, left + 9, top + 2);
      line(left + 9, top + 2, right, top + 7);
      break;
    default:
      line(left + 1, top + 1, right - 1, bottom - 1);
      line(right - 1, top + 1, left + 1, bottom - 1);
  }
}

const grabReach = 7;
const freehandStep = 1.5;

/** @internal Draws, moves and removes measurements with the pointer and keys; Ctrl+Z undoes. */
export class MedicalMeasurementModifier extends ChartModifier {
  private moving: MedicalMeasurement | undefined;
  private movingIndex = 0;
  private before: readonly MedicalPoint[] = [];
  private grabbed: MedicalPoint = { x: 0, y: 0 };
  private pointerId = 0;
  private isDrawing = false;

  private readonly parts: LayerParts;

  constructor(private readonly layer: MedicalMeasurementLayer) {
    super(60);
    this.parts = layerParts(layer);
  }

  override onPointer(input: PointerInputEvent): ModifierResult {
    const interaction = this.interaction;
    const layout = interaction?.chart.currentLayout;
    if (!interaction || !layout) {
      return 'ignored';
    }
    const point = this.layer.unmap(layout, input.position);
    if (!point) {
      return 'ignored';
    }
    if (this.moving || this.isDrawing) {
      return input.pointerId === this.pointerId ? this.continue(interaction, input, point) : 'ignored';
    }
    // The bar of tools: a click chooses, the pointer over a button shows its name; nothing else gets the click.
    if (this.onToolBar(interaction, layout, input)) {
      return 'handled';
    }
    const waited = this.waitForAngle(interaction, input, point);
    if (waited) {
      return waited;
    }
    if (
      input.kind !== 'pressed' ||
      input.changedButton !== 'primary' ||
      input.modifiers !== 0 ||
      !interaction.hitPane(input.position)
    ) {
      return 'ignored';
    }
    this.pointerId = input.pointerId;
    if (this.layer.tool !== undefined) {
      this.isDrawing = true;
      this.parts.setDraft([point, point]);
      return 'capture';
    }
    const found = this.layer.findPoint(layout, input.position, grabReach);
    if (found) {
      this.moving = found.measurement;
      this.movingIndex = found.index;
      this.before = found.measurement.points;
      this.grabbed = point;
      this.layer.select(found.measurement);
      return 'capture';
    }
    return 'ignored';
  }

  override onKey(input: KeyInputEvent): ModifierResult {
    const interaction = this.interaction;
    if (input.kind !== 'pressed' || !interaction) {
      return 'ignored';
    }
    // Letters choose a tool, so that a host without a tool bar can measure.
    const tool = toolOf(input.key);
    if (input.modifiers === 0 && tool) {
      this.toggle(tool);
      return 'handled';
    }
    if (input.key === 'Escape' && (this.layer.tool !== undefined || this.parts.draft() !== undefined)) {
      this.isDrawing = false;
      this.layer.tool = undefined;
      return 'handled';
    }
    const selected = this.layer.selected;
    if (input.key === 'Delete' && selected) {
      this.removeSelected(interaction, selected);
      return 'handled';
    }
    return 'ignored';
  }

  override onCaptureLost(): void {
    this.isDrawing = false;
    this.moving = undefined;
  }

  // Chooses a tool, or puts away the one chosen; the measurements stay either way.
  private toggle(tool: MedicalMeasurementKind): void {
    this.isDrawing = false;
    this.layer.tool = this.layer.tool === tool ? undefined : tool;
  }

  private removeSelected(interaction: ChartInteraction, selected: MedicalMeasurement): void {
    const layer = this.layer;
    const index = layer.measurements.indexOf(selected);
    layer.remove(selected);
    interaction.history.recordEdit({
      undo: () => {
        layer.insert(selected, index);
      },
      redo: () => {
        layer.remove(selected);
      },
    });
  }

  private onToolBar(interaction: ChartInteraction, layout: ChartLayoutResult, input: PointerInputEvent): boolean {
    const button = this.layer.showsTools ? hitToolBar(layout, input.position) : undefined;
    this.parts.setHovered(button);
    if (button === undefined) {
      return false;
    }
    if (input.kind === 'pressed' && input.changedButton === 'primary') {
      if (button !== 'delete') {
        this.toggle(button);
      } else if (this.layer.selected) {
        this.removeSelected(interaction, this.layer.selected);
      }
    }
    return true;
  }

  // An angle waits for its third point between two presses: moving shows it, a press sets it.
  private waitForAngle(
    interaction: ChartInteraction,
    input: PointerInputEvent,
    point: MedicalPoint,
  ): ModifierResult | undefined {
    const waiting = this.parts.draft();
    if (this.layer.tool !== 'angle' || waiting?.length !== 3) {
      return undefined;
    }
    if (input.kind === 'moved') {
      this.parts.setDraft([waiting[0] as MedicalPoint, waiting[1] as MedicalPoint, point]);
      return 'handled';
    }
    if (input.kind === 'pressed' && input.changedButton === 'primary') {
      this.finish(interaction, [waiting[0] as MedicalPoint, waiting[1] as MedicalPoint, point]);
      return 'handled';
    }
    return undefined;
  }

  private continue(interaction: ChartInteraction, input: PointerInputEvent, point: MedicalPoint): ModifierResult {
    const moving = this.moving;
    if (moving) {
      const points = moved(moving, this.before, this.movingIndex, this.grabbed, point);
      this.layer.moveTo(moving, points);
      if (input.kind === 'released') {
        const layer = this.layer;
        const before = this.before;
        interaction.history.recordEdit({
          undo: () => {
            layer.moveTo(moving, before);
          },
          redo: () => {
            layer.moveTo(moving, points);
          },
        });
        this.moving = undefined;
        return 'release';
      }
      return 'handled';
    }
    const draft = this.parts.draft() ?? [point, point];
    const tool = this.layer.tool ?? 'distance';
    if (input.kind === 'moved') {
      this.parts.setDraft(tool === 'freehand' ? grown(draft, point) : [draft[0] as MedicalPoint, point]);
      return 'handled';
    }
    if (input.kind !== 'released') {
      return 'handled';
    }
    this.isDrawing = false;
    const finished = tool === 'freehand' ? grown(draft, point) : [draft[0] as MedicalPoint, point];
    const isTooSmall =
      tool !== 'freehand' &&
      floatDistance(finished[0] as MedicalPoint, finished[finished.length - 1] as MedicalPoint) < 0.5;
    if (isTooSmall || (tool === 'freehand' && finished.length < 3)) {
      this.parts.setDraft(undefined);
    } else if (tool === 'angle') {
      // The first arm is drawn; the next press sets the end of the second arm.
      this.parts.setDraft([finished[0] as MedicalPoint, finished[1] as MedicalPoint, finished[1] as MedicalPoint]);
    } else {
      this.finish(interaction, finished);
    }
    return 'release';
  }

  private finish(interaction: ChartInteraction, points: readonly MedicalPoint[]): void {
    const layer = this.layer;
    const tool = layer.tool ?? 'distance';
    this.parts.setDraft(undefined);
    const measurement = layer.add(tool, points);
    layer.select(measurement);
    const index = layer.measurements.length - 1;
    interaction.history.recordEdit({
      undo: () => {
        layer.remove(measurement);
      },
      redo: () => {
        layer.insert(measurement, index);
      },
    });
  }
}

function toolOf(key: string): MedicalMeasurementKind | undefined {
  switch (key) {
    case 'D':
      return 'distance';
    case 'A':
      return 'angle';
    case 'C':
      return 'circle';
    case 'R':
      return 'rectangle';
    case 'F':
      return 'freehand';
    default:
      return undefined;
  }
}

// Moving the middle of a circle moves the whole circle; any other point moves alone.
function moved(
  measurement: MedicalMeasurement,
  before: readonly MedicalPoint[],
  index: number,
  grabbed: MedicalPoint,
  now: MedicalPoint,
): readonly MedicalPoint[] {
  const dx = now.x - grabbed.x;
  const dy = now.y - grabbed.y;
  if (measurement.kind === 'circle' && index === 0) {
    return before.map((point) => ({ x: point.x + dx, y: point.y + dy }));
  }
  return before.map((point, i) => (i === index ? { x: point.x + dx, y: point.y + dy } : point));
}

function grown(draft: readonly MedicalPoint[], point: MedicalPoint): readonly MedicalPoint[] {
  return floatDistance(draft[draft.length - 1] as MedicalPoint, point) >= freehandStep ? [...draft, point] : draft;
}

// In single precision, as the .NET version measures the steps of a drawn path.
function floatDistance(a: MedicalPoint, b: MedicalPoint): number {
  const f = Math.fround;
  const dx = f(f(b.x) - f(a.x));
  const dy = f(f(b.y) - f(a.y));
  return f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
}
