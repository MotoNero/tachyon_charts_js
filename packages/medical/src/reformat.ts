// Oblique and curved sections through a volume, as MedicalObliqueSlice, MedicalCurvedSlice, MedicalReformatView and
// MedicalReformatBuffer of the .NET version: values sampled between the voxels along any plane, or down from a path
// drawn on a slice, each in a chart of its own.
import { Line3D, Point3D, Points3D, type Camera3D, type Chart3DBuilder } from '@tachyon-charts/3d';
import {
  ChartModifier,
  ColorAxis,
  DoubleRange,
  HeatmapData,
  HeatmapSeries,
  ZoomPanModifier,
  type ChartBuilder,
  type ChartInteraction,
  type InputCapture,
  type KeyInputEvent,
  type ModifierResult,
  type Point,
  type PointerInputEvent,
  type WheelInputEvent,
} from '@tachyon-charts/core';
import { MedicalColorBarModifier } from './image-display';
import type { MedicalMeasurement } from './measurements';
import type { MedicalVolume } from './medical-image';
import type { MedicalMprDisplay, MedicalMprSlice } from './mpr';

const mostPixels = 1024;

// The pixels and their spacing for a length: the finest voxel spacing, at most 1024 pixels.
function fit(volume: MedicalVolume, length: number): { count: number; spacing: number } {
  const voxels = volume.voxelSpacing;
  const spacing = Math.max(Math.min(voxels.x, voxels.y, voxels.z), length / mostPixels);
  return { count: Math.max(2, Math.ceil(length / spacing)), spacing };
}

// The place of the last voxel in millimetres from the first.
function extent(volume: MedicalVolume): Point3D {
  const data = volume.data;
  const spacing = volume.voxelSpacing;
  return new Point3D((data.width - 1) * spacing.x, (data.height - 1) * spacing.y, (data.depth - 1) * spacing.z);
}

const mix = (first: number, second: number, share: number): number => first + (second - first) * share;

// A section of a volume: values sampled between the voxels, NaN outside the volume.
class ReformatBuffer {
  readonly data: HeatmapData;

  constructor(
    private readonly volume: MedicalVolume,
    readonly width: number,
    readonly height: number,
    readonly spacing: number,
  ) {
    this.data = new HeatmapData(width, height);
    this.clear();
  }

  fillPlane(origin: Point3D, across: Point3D, down: Point3D): void {
    const values = new Float32Array(this.width * this.height);
    for (let row = 0; row < this.height; row++) {
      const start = origin.plus(down.times((row + 0.5) * this.spacing));
      for (let column = 0; column < this.width; column++) {
        values[row * this.width + column] = this.sample(start.plus(across.times((column + 0.5) * this.spacing)));
      }
    }
    this.data.setValues(values);
  }

  fillCurve(path: readonly Point3D[], down: Point3D, top: number): number {
    const places: (Point3D | undefined)[] = new Array<Point3D | undefined>(this.width);
    const length = walk(path, places, this.spacing);
    const values = new Float32Array(this.width * this.height);
    for (let row = 0; row < this.height; row++) {
      const offset = down.times(top + (row + 0.5) * this.spacing);
      for (let column = 0; column < this.width; column++) {
        const place = places[column];
        values[row * this.width + column] = place ? this.sample(place.plus(offset)) : Number.NaN;
      }
    }
    this.data.setValues(values);
    return length;
  }

  clear(): void {
    this.data.setValues(new Float32Array(this.width * this.height).fill(Number.NaN));
  }

  sample(place: Point3D): number {
    const data = this.volume.data;
    const spacing = this.volume.voxelSpacing;
    const u = place.x / spacing.x;
    const v = place.y / spacing.y;
    const w = place.z / spacing.z;
    const edge = 1e-9;
    if (!(
      u >= -edge &&
      v >= -edge &&
      w >= -edge &&
      u <= data.width - 1 + edge &&
      v <= data.height - 1 + edge &&
      w <= data.depth - 1 + edge
    )) {
      return Number.NaN;
    }
    const corner = (position: number, count: number): number => Math.min(Math.max(Math.floor(position), 0), count - 2);
    const x = corner(u, data.width);
    const y = corner(v, data.height);
    const z = corner(w, data.depth);
    const a = Math.min(Math.max(u - x, 0), 1);
    const b = Math.min(Math.max(v - y, 0), 1);
    const c = Math.min(Math.max(w - z, 0), 1);
    const near = mix(
      mix(data.at(x, y, z), data.at(x + 1, y, z), a),
      mix(data.at(x, y + 1, z), data.at(x + 1, y + 1, z), a),
      b,
    );
    const far = mix(
      mix(data.at(x, y, z + 1), data.at(x + 1, y, z + 1), a),
      mix(data.at(x, y + 1, z + 1), data.at(x + 1, y + 1, z + 1), a),
      b,
    );
    return mix(near, far, c);
  }
}

// The places along the path every step, from half a step on; the rest stay undefined.
function walk(path: readonly Point3D[], places: (Point3D | undefined)[], step: number): number {
  let column = 0;
  let travelled = 0;
  let next = step / 2;
  for (let i = 1; i < path.length && column < places.length; i++) {
    const from = path[i - 1] as Point3D;
    const to = path[i] as Point3D;
    const along = to.minus(from);
    const part = along.length;
    while (part > 0 && next <= travelled + part && column < places.length) {
      places[column++] = from.plus(along.times((next - travelled) / part));
      next += step;
    }
    travelled += part;
  }
  return travelled;
}

// The chart of a section: the values in the window of the display, the part with values in view.
class ReformatView {
  readonly listeners = new Set<() => void>();

  constructor(
    readonly display: MedicalMprDisplay,
    readonly buffer: ReformatBuffer,
    private readonly title: string,
    readonly wheel?: (steps: number) => void,
    readonly key?: (key: string) => boolean,
  ) {}

  changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  configure(chart: ChartBuilder): ChartBuilder {
    const window = this.display.window;
    const buffer = this.buffer;
    const width = buffer.width * buffer.spacing;
    const height = buffer.height * buffer.spacing;
    const filled = this.filled();
    return chart
      .title(this.title)
      .xAxis((axis) =>
        axis.numeric('medical-reformat-x').title('mm').range(filled.across.min, filled.across.max).limits(0, width),
      )
      .yAxis((axis) =>
        axis
          .numeric('medical-reformat-y')
          .title('mm')
          .range(filled.down.min, filled.down.max)
          .limits(0, height)
          .inverted(),
      )
      .yAxis((axis) =>
        axis
          .color('Grayscale', 'medical-reformat-values')
          .range(window.minimum, window.maximum)
          .title(this.display.unit),
      )
      .addSeries(
        (x, y, axis) => {
          const colors = axis('medical-reformat-values') as ColorAxis;
          colors.colormap = this.display.colormap;
          const series = new HeatmapSeries(buffer.data, x, y, colors);
          series.name = this.display.unit;
          series.xStart = 0;
          series.xStep = buffer.spacing;
          series.yStart = 0;
          series.yStep = buffer.spacing;
          series.isInterpolated = this.display.isInterpolated;
          return series;
        },
        'medical-reformat-x',
        'medical-reformat-y',
      )
      .addModifier(() => new ReformatModifier(this))
      .addModifier(
        () =>
          new MedicalColorBarModifier(
            () => this.display.window,
            (value) => {
              this.display.applyPreset(value);
            },
            this.display.initialWindow,
          ),
      )
      .addModifier(() => {
        const zoom = new ZoomPanModifier();
        zoom.panButton = 'middle';
        return zoom;
      });
  }

  // The view opens on the part with values; zooming out shows the whole square.
  private filled(): { across: DoubleRange; down: DoubleRange } {
    const buffer = this.buffer;
    let left = Infinity;
    let top = Infinity;
    let right = -1;
    let bottom = -1;
    for (let row = 0; row < buffer.height; row++) {
      for (let column = 0; column < buffer.width; column++) {
        if (!Number.isNaN(buffer.data.at(column, row))) {
          left = Math.min(left, column);
          right = Math.max(right, column);
          top = Math.min(top, row);
          bottom = Math.max(bottom, row);
        }
      }
    }
    const spacing = buffer.spacing;
    return right < 0
      ? { across: new DoubleRange(0, buffer.width * spacing), down: new DoubleRange(0, buffer.height * spacing) }
      : {
          across: new DoubleRange(left * spacing, (right + 1) * spacing),
          down: new DoubleRange(top * spacing, (bottom + 1) * spacing),
        };
  }
}

// Window by dragging; the wheel and keys as the section wants them.
class ReformatModifier extends ChartModifier {
  private stops: (() => void)[] = [];
  private startWindow;
  private start: Point = { x: 0, y: 0 };
  private pointerId = 0;
  private isDragging = false;

  constructor(private readonly view: ReformatView) {
    super(50);
    this.startWindow = view.display.window;
  }

  protected override onAttached(interaction: ChartInteraction): void {
    const chart = interaction.chart;
    const redraw = (): void => {
      interaction.run(() => {
        chart.invalidate();
      });
    };
    this.view.listeners.add(redraw);
    this.stops = [
      () => this.view.listeners.delete(redraw),
      this.view.display.onWindowChanged((window) => {
        interaction.run(() => {
          const axis = chart.panes.flatMap((pane) => pane.axes).find((each) => each instanceof ColorAxis);
          if (axis) {
            axis.visibleRange = new DoubleRange(window.minimum, window.maximum);
          }
        });
      }),
    ];
  }

  protected override onDetached(): void {
    for (const stop of this.stops) {
      stop();
    }
    this.stops = [];
  }

  override onPointer(input: PointerInputEvent): ModifierResult {
    if (!this.isDragging) {
      if (
        input.kind !== 'pressed' ||
        input.changedButton !== 'primary' ||
        input.modifiers !== 0 ||
        !this.interaction?.hitPane(input.position)
      ) {
        return 'ignored';
      }
      this.isDragging = true;
      this.pointerId = input.pointerId;
      this.start = input.position;
      this.startWindow = this.view.display.window;
      return 'capture';
    }
    if (input.pointerId !== this.pointerId) {
      return 'ignored';
    }
    if (input.kind === 'released' || input.kind === 'canceled') {
      this.isDragging = false;
      return 'release';
    }
    if (input.kind === 'moved') {
      const scale = Math.max(this.startWindow.width / 256, 0.01);
      const width = Math.max(1e-6, this.startWindow.width + (input.position.x - this.start.x) * scale);
      this.view.display.setWindow(this.startWindow.center - (input.position.y - this.start.y) * scale, width);
    }
    return 'handled';
  }

  override onWheel(input: WheelInputEvent): ModifierResult {
    const wheel = this.view.wheel;
    if (!wheel || input.modifiers !== 0 || input.delta.y === 0 || !this.interaction?.hitPane(input.position)) {
      return 'ignored';
    }
    wheel(Math.sign(input.delta.y));
    return 'handled';
  }

  override onKey(input: KeyInputEvent): ModifierResult {
    const key = this.view.key;
    if (input.kind !== 'pressed' || input.modifiers !== 0 || !key) {
      return 'ignored';
    }
    return key(input.key) ? 'handled' : 'ignored';
  }

  override onCaptureLost(_capture: InputCapture): void {
    this.isDragging = false;
  }
}

function unit(vector: Point3D): Point3D {
  const length = vector.length;
  if (!Number.isFinite(length) || length < 1e-12) {
    throw new RangeError('The direction must be finite and not zero.');
  }
  return vector.times(1 / length);
}

const outlineColor = { r: 255, g: 170, b: 40, a: 255 };

/** A plane in any direction through the volume of a display, in a chart of its own; it can follow a line on a slice. */
export class MedicalObliqueSlice {
  /** The camera of a 3D chart the key V on the plane turns it to face. */
  viewCamera: Camera3D | undefined;
  private readonly view: ReformatView;
  private readonly side: number;
  private readonly outlines: Points3D[] = [];
  private followed: MedicalMprSlice | undefined;
  private stopFollowing: (() => void) | undefined;
  private frame = {
    center: Point3D.zero,
    across: new Point3D(1, 0, 0),
    down: new Point3D(0, 1, 0),
    normal: new Point3D(0, 0, 1),
  };

  /** @param display - The display whose volume the plane cuts; it starts flat through its place. */
  constructor(display: MedicalMprDisplay) {
    const size = fit(display.source, extent(display.source).length);
    this.side = size.count * size.spacing;
    const buffer = new ReformatBuffer(display.source, size.count, size.count, size.spacing);
    this.view = new ReformatView(
      display,
      buffer,
      'Oblique',
      (steps) => {
        this.move(steps * size.spacing);
      },
      (key) => this.onKey(key),
    );
    this.setPlane(display.position, new Point3D(0, 0, 1));
  }

  /** The middle of the plane in millimetres from the first voxel. */
  get center(): Point3D {
    return this.frame.center;
  }

  /** The direction across the plane, to the right in its chart. */
  get across(): Point3D {
    return this.frame.across;
  }

  /** The direction down the plane in its chart. */
  get down(): Point3D {
    return this.frame.down;
  }

  /** The normal of the plane. */
  get normal(): Point3D {
    return this.frame.normal;
  }

  /** The pixels along each side. */
  get size(): number {
    return this.view.buffer.width;
  }

  /** The spacing of the pixels in millimetres. */
  get pixelSpacing(): number {
    return this.view.buffer.spacing;
  }

  /** The values of the plane, row after row from the top; NaN outside the volume. */
  values(): Float32Array {
    const data = this.view.buffer.data;
    return Float32Array.from({ length: data.width * data.height }, (_, i) =>
      data.at(i % data.width, Math.floor(i / data.width)),
    );
  }

  /** Calls a function whenever the plane moves; returns a function that stops it. */
  onChanged(listener: () => void): () => void {
    this.view.listeners.add(listener);
    return () => this.view.listeners.delete(listener);
  }

  /**
   * Sets the plane by its middle and its normal; rows run to lower z, or along y for a plane that lies nearly flat.
   * @throws RangeError when the normal is zero or not finite.
   */
  setPlane(center: Point3D, normal: Point3D): void {
    const direction = unit(normal);
    const reference = Math.abs(direction.z) > 0.9 ? new Point3D(0, 1, 0) : new Point3D(0, 0, -1);
    const down = unit(reference.minus(direction.times(Point3D.dot(reference, direction))));
    this.setFrame(center, Point3D.cross(down, direction), down);
  }

  /** Moves the plane along its normal by millimetres. */
  move(millimetres: number): void {
    this.setFrame(this.frame.center.plus(this.frame.normal.times(millimetres)), this.frame.across, this.frame.down);
  }

  /** Lets the plane stand upright on the last distance of a slice, or on the selected one; undefined stops it. */
  followLine(slice: MedicalMprSlice | undefined): void {
    this.stopFollowing?.();
    this.stopFollowing = undefined;
    this.followed = slice;
    if (slice) {
      this.stopFollowing = slice.measurements.onChanged(() => {
        this.onLineChanged();
      });
      this.onLineChanged();
    }
  }

  /** Turns the plane to face the view of a 3D chart of the volume. */
  alignToView(camera: Camera3D): void {
    // The box of the chart spans -1 to 1 on each axis; the volume its full size in millimetres.
    const size = extent(this.view.display.source);
    const look = camera.target.minus(camera.eye);
    this.setPlane(this.frame.center, new Point3D(look.x * size.x, look.y * size.y, look.z * size.z));
  }

  /** Describes the chart of the plane. */
  configure(chart: ChartBuilder): ChartBuilder {
    return this.view.configure(chart);
  }

  /** Adds the outline of the plane to a 3D chart of the volume. */
  configure3D(chart: Chart3DBuilder): Chart3DBuilder {
    const points = new Points3D(5);
    this.outlines.push(points);
    this.writeOutline(points);
    return chart.addLine(new Line3D(points));
  }

  private onKey(key: string): boolean {
    if (key !== 'V' || !this.viewCamera) {
      return false;
    }
    this.alignToView(this.viewCamera);
    return true;
  }

  private setFrame(center: Point3D, across: Point3D, down: Point3D): void {
    this.frame = { center, across, down, normal: Point3D.cross(across, down) };
    const corner = center.minus(across.times(this.side / 2)).minus(down.times(this.side / 2));
    this.view.buffer.fillPlane(corner, across, down);
    for (const outline of this.outlines) {
      this.writeOutline(outline);
    }
    this.view.changed();
  }

  // The four corners and the first again; the ring of points keeps the last five.
  private writeOutline(points: Points3D): void {
    const half = this.side / 2;
    const { center, across, down } = this.frame;
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      const corner = center.plus(across.times(x * half)).plus(down.times(y * half));
      points.append(corner.x, corner.y, corner.z, outlineColor);
    }
  }

  private onLineChanged(): void {
    const slice = this.followed;
    const line = slice ? pickDistance(slice) : undefined;
    if (!slice || !line) {
      return;
    }
    const start = line.points[0] as { x: number; y: number };
    const end = line.points[1] as { x: number; y: number };
    const from = slice.toVolumePosition(start.x, start.y);
    const to = slice.toVolumePosition(end.x, end.y);
    if (to.minus(from).length < 1e-9) {
      return;
    }
    // The rows run along the normal of the orthogonal plane, to lower z or along y.
    const normal =
      slice.plane === 'axial'
        ? new Point3D(0, 0, -1)
        : slice.plane === 'coronal'
          ? new Point3D(0, 1, 0)
          : new Point3D(1, 0, 0);
    this.setFrame(from.plus(to).times(0.5), unit(to.minus(from)), normal);
  }
}

function pickDistance(slice: MedicalMprSlice): MedicalMeasurement | undefined {
  const layer = slice.measurements;
  if (layer.selected?.kind === 'distance') {
    return layer.selected;
  }
  return [...layer.measurements].reverse().find((each) => each.kind === 'distance');
}

const isLine = (measurement: MedicalMeasurement): boolean =>
  measurement.kind === 'distance' || measurement.kind === 'angle' || measurement.kind === 'freehand';

/** A section that runs down from a path drawn on a slice through the whole volume, straightened in a chart of its own. */
export class MedicalCurvedSlice {
  private readonly view: ReformatView;
  private readonly downward: Point3D;
  private readonly top: number;
  private fixed: MedicalMeasurement | undefined;
  private current: MedicalMeasurement | undefined;
  private travelled = 0;

  /** @param slice - The slice whose lines the section follows. */
  constructor(private readonly slice: MedicalMprSlice) {
    const display = slice.display;
    const size = extent(display.source);
    // Down runs across the plane: to lower z under an axial plane, along y and x under the others.
    this.downward =
      slice.plane === 'axial'
        ? new Point3D(0, 0, -1)
        : slice.plane === 'coronal'
          ? new Point3D(0, 1, 0)
          : new Point3D(1, 0, 0);
    const depth = slice.plane === 'axial' ? size.z : slice.plane === 'coronal' ? size.y : size.x;
    const columns = fit(display.source, size.length);
    const rows = Math.max(2, Math.ceil(depth / columns.spacing) + 1);
    const buffer = new ReformatBuffer(display.source, columns.count, rows, columns.spacing);
    // The first row lies half a pixel above the first slice of the plane, so the middle of each row meets a slice place.
    this.top = (slice.plane === 'axial' ? -size.z : 0) - columns.spacing / 2;
    this.view = new ReformatView(display, buffer, 'Curved');
    slice.measurements.onChanged(() => {
      this.update();
    });
    this.update();
  }

  /**
   * The path followed; when undefined, the selected line of the slice or its last one.
   * @throws RangeError for a measurement that is no distance, angle or freehand line.
   */
  get path(): MedicalMeasurement | undefined {
    return this.fixed;
  }

  set path(value: MedicalMeasurement | undefined) {
    if (value && !isLine(value)) {
      throw new RangeError('A curved section follows a distance, an angle or a freehand line.');
    }
    this.fixed = value;
    this.update();
  }

  /** The path shown now. */
  get shown(): MedicalMeasurement | undefined {
    return this.current;
  }

  /** The length of the path in millimetres. */
  get length(): number {
    return this.travelled;
  }

  /** The spacing of the pixels in millimetres. */
  get pixelSpacing(): number {
    return this.view.buffer.spacing;
  }

  /** The rows, down through the volume. */
  get rows(): number {
    return this.view.buffer.height;
  }

  /** The value of a pixel of the section; NaN where the path or the volume ends. */
  at(column: number, row: number): number {
    return this.view.buffer.data.at(column, row);
  }

  /** Calls a function whenever the section changes; returns a function that stops it. */
  onChanged(listener: () => void): () => void {
    this.view.listeners.add(listener);
    return () => this.view.listeners.delete(listener);
  }

  /** Describes the chart of the section. */
  configure(chart: ChartBuilder): ChartBuilder {
    return this.view.configure(chart);
  }

  private update(): void {
    const selected = this.slice.measurements.selected;
    this.current =
      this.fixed ??
      (selected && isLine(selected) ? selected : [...this.slice.measurements.measurements].reverse().find(isLine));
    const line = this.current;
    if (!line) {
      this.travelled = 0;
      this.view.buffer.clear();
      this.view.changed();
      return;
    }
    // On the plane, at the depth where the rows start; the rows then run through the whole volume.
    const down = this.downward;
    const path = line.points.map((point) => {
      const place = this.slice.toVolumePosition(point.x, point.y);
      return place.minus(down.times(Point3D.dot(place, down)));
    });
    this.travelled = this.view.buffer.fillCurve(path, down, this.top);
    this.view.changed();
  }
}
