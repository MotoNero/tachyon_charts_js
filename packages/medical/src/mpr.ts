// Multiplanar reconstruction, as MedicalMprDisplay and MedicalMprSlice of the .NET version: one place in a volume and
// the axial, coronal and sagittal slices through it, each a chart of its own with the place as a cross, the slice
// number, the directions of the patient and measurements; a click moves the place, the wheel and the arrows the slice.
import { Line3D, Point3D, Points3D, Volume3D, type Chart3DBuilder, type Scene3D } from '@tachyon-charts/3d';
import {
  ChartModifier,
  ChartOverlay,
  Colormap,
  ColorAxis,
  DoubleRange,
  HeatmapData,
  HeatmapSeries,
  KeyboardNavigationModifier,
  ZoomPanModifier,
  type Axis,
  type ChartBuilder,
  type ChartInteraction,
  type InputCapture,
  type KeyInputEvent,
  type ModifierResult,
  type OverlayCanvas,
  type Point,
  type PointerInputEvent,
  type WheelInputEvent,
} from '@tachyon-charts/core';
import { MedicalColorBarModifier, initialWindow, marksOf, type MedicalOrientationMarks } from './image-display';
import {
  MedicalMeasurementModifier,
  newMeasurementLayer,
  type MedicalMeasurementLayer,
  type MedicalMeasurementSource,
} from './measurements';
import {
  CtWindowPresets,
  MedicalWindow,
  type ImageSpacing,
  type MedicalVolume,
  type PatientOrientation,
} from './medical-image';
import { SegmentationLayer, SegmentationSeries, type MedicalSegmentation } from './segmentation';
import { sliceIndex, sliceShape, sliceValue, type MedicalMprPlane } from './slices';

const minimumWindowWidth = 1e-6;

// The segmentations put onto the volume of a display, and a number that grows with every change of them or of the place.
let segmentationOf: (display: MedicalMprDisplay) => {
  layers: () => readonly SegmentationLayer[];
  stamp: () => number;
};

/** Three slices through one place of a volume, with one window for all. */
export class MedicalMprDisplay {
  /** The slice from above. */
  readonly axial: MedicalMprSlice;
  /** The slice from the front. */
  readonly coronal: MedicalMprSlice;
  /** The slice from the side. */
  readonly sagittal: MedicalMprSlice;
  /** Plays the slices of a plane one after the other, as a film. */
  readonly cine: MedicalCinePlayer;
  /** The unit of the values: HU for CT. */
  readonly unit: string;
  /** The colours from the lowest to the highest value of the window. */
  colormap: Colormap = Colormap.builtIn('Grayscale');
  /** Whether the pixels blend into each other. */
  isInterpolated = true;
  /** @internal The window the volume started with. */
  readonly initialWindow: MedicalWindow;
  private place: Point3D;
  private current: MedicalWindow;
  private volume3D: Volume3D | undefined;
  private readonly layers: SegmentationLayer[] = [];

  static {
    segmentationOf = (display) => ({
      layers: () => display.layers,
      stamp: () => display.segmentationChanges * 65536 + display.positionChanges,
    });
  }
  private readonly scenes: Scene3D[] = [];
  private segmentationChanges = 0;
  private lines3D: Measurements3D | undefined;
  /** Whether the 3D charts show the measurements of the slices as lines in the volume. */
  showsMeasurements3D = true;
  private positionChanges = 0;
  private readonly positionListeners = new Set<(position: Point3D) => void>();
  private readonly windowListeners = new Set<(window: MedicalWindow) => void>();

  /** @param source - The volume. */
  constructor(
    /** The volume. */
    readonly source: MedicalVolume,
  ) {
    this.unit = source.modality?.toUpperCase() === 'CT' ? 'HU' : 'value';
    this.current = initialWindow(source.windowCenter, source.windowWidth, source.data.valueRange);
    this.initialWindow = this.current;
    const maximum = this.maximumPosition;
    this.place = new Point3D(maximum.x / 2, maximum.y / 2, maximum.z / 2);
    this.axial = newSlice(this, 'axial');
    this.coronal = newSlice(this, 'coronal');
    this.sagittal = newSlice(this, 'sagittal');
    this.cine = new MedicalCinePlayer(this);
  }

  /** The place in millimetres from the first voxel where the three slices cross. */
  get position(): Point3D {
    return this.place;
  }

  /** The window of grey values of all three slices. */
  get window(): MedicalWindow {
    return this.current;
  }

  /** The place of the last voxel in millimetres from the first. */
  get maximumPosition(): Point3D {
    const data = this.source.data;
    const spacing = this.source.voxelSpacing;
    return new Point3D((data.width - 1) * spacing.x, (data.height - 1) * spacing.y, (data.depth - 1) * spacing.z);
  }

  /**
   * Moves the place, kept inside the volume; the slices follow.
   * @throws RangeError when the place is not finite.
   */
  setPosition(position: Point3D): void {
    if (![position.x, position.y, position.z].every(Number.isFinite)) {
      throw new RangeError('The position must be finite.');
    }
    const maximum = this.maximumPosition;
    const clamp = (value: number, high: number): number => Math.min(Math.max(value, 0), high);
    const clamped = new Point3D(
      clamp(position.x, maximum.x),
      clamp(position.y, maximum.y),
      clamp(position.z, maximum.z),
    );
    if (clamped.equals(this.place)) {
      return;
    }
    this.place = clamped;
    this.positionChanges++;
    this.movePlanes(clamped);
    for (const listener of this.positionListeners) {
      listener(clamped);
    }
  }

  /**
   * Sets the window by its centre and width.
   * @throws RangeError unless both are finite and the width positive.
   */
  setWindow(center: number, width: number): void {
    this.applyPreset(new MedicalWindow('Custom', center, width));
  }

  /**
   * Shows a window, such as one of {@link CtWindowPresets}.
   * @throws RangeError unless its centre and width are finite and the width positive.
   */
  applyPreset(window: MedicalWindow): void {
    if (!(Number.isFinite(window.center) && Number.isFinite(window.width) && window.width >= minimumWindowWidth)) {
      throw new RangeError('The window must have a finite centre and a positive finite width.');
    }
    if (this.current.equals(window)) {
      return;
    }
    this.current = window;
    if (this.volume3D) {
      this.volume3D.colorRange = new DoubleRange(window.minimum, window.maximum);
    }
    for (const listener of this.windowListeners) {
      listener(window);
    }
  }

  /** The volume of the 3D charts, in the window of the slices, its planes at the place. */
  get volume(): Volume3D {
    if (!this.volume3D) {
      const maximum = this.maximumPosition;
      this.volume3D = new Volume3D(
        this.source.data,
        new DoubleRange(0, maximum.x),
        new DoubleRange(0, maximum.y),
        new DoubleRange(0, maximum.z),
        { colormap: this.colormap },
      );
      this.volume3D.colorRange = new DoubleRange(this.current.minimum, this.current.maximum);
      this.movePlanes(this.place);
    }
    return this.volume3D;
  }

  /** The segmentations shown over the slices and in 3D. */
  get segmentations(): readonly MedicalSegmentation[] {
    return this.layers.map((layer) => layer.source);
  }

  /**
   * Shows a segmentation over the slices and in the 3D charts, its labels put onto the voxels of the volume.
   * @throws RangeError when the segmentation is shown already, or a volume of labels has more than 255 labels.
   */
  addSegmentation(segmentation: MedicalSegmentation): void {
    if (this.layers.some((layer) => layer.source === segmentation)) {
      throw new RangeError('The segmentation is already part of this display.');
    }
    const layer = new SegmentationLayer(this.source, segmentation);
    this.layers.push(layer);
    for (const scene of this.scenes) {
      for (const volume of layer.objects) {
        scene.addVolume(volume);
      }
    }
    segmentation.onChanged(() => {
      layer.refresh3D();
      this.segmentationChanges++;
    });
    this.segmentationChanges++;
  }

  /** Describes a 3D chart of the volume with its three planes and the segmentations. */
  configure3D(chart: Chart3DBuilder): Chart3DBuilder {
    const maximum = this.maximumPosition;
    chart
      .title('Medical MPR')
      .xAxis(0, maximum.x, 'mm')
      .yAxis(0, maximum.y, 'mm')
      .zAxis(0, maximum.z, 'mm')
      .addVolume(this.volume);
    for (const layer of this.layers) {
      for (const volume of layer.objects) {
        chart.addVolume(volume);
      }
    }
    if (this.showsMeasurements3D) {
      this.lines3D ??= new Measurements3D(this);
      chart.addLine(this.lines3D.lines).addLine(this.lines3D.selected);
    }
    const scene = chart.scene;
    this.scenes.push(scene);
    // A click on the volume or a label sets a marker there; the place follows it.
    const before = scene.onMarkerAdded;
    scene.onMarkerAdded = (marker) => {
      before?.(marker);
      if (
        marker.source === this.volume3D ||
        this.layers.some((layer) => layer.objects.includes(marker.source as Volume3D))
      ) {
        this.setPosition(marker.position);
      }
    };
    return chart;
  }

  // The planes of the volume through the place, in the box from -1 to 1.
  private movePlanes(position: Point3D): void {
    const volume = this.volume3D;
    if (!volume) {
      return;
    }
    const maximum = this.maximumPosition;
    volume.sliceX.offset = (position.x / maximum.x) * 2 - 1;
    volume.sliceY.offset = (position.y / maximum.y) * 2 - 1;
    volume.sliceZ.offset = (position.z / maximum.z) * 2 - 1;
  }

  /** Calls a function whenever the place moves; returns a function that stops it. */
  onPositionChanged(listener: (position: Point3D) => void): () => void {
    this.positionListeners.add(listener);
    return () => this.positionListeners.delete(listener);
  }

  /** Calls a function whenever the window changes; returns a function that stops it. */
  onWindowChanged(listener: (window: MedicalWindow) => void): () => void {
    this.windowListeners.add(listener);
    return () => this.windowListeners.delete(listener);
  }
}

let createSlice: (display: MedicalMprDisplay, plane: MedicalMprPlane) => MedicalMprSlice;

function newSlice(display: MedicalMprDisplay, plane: MedicalMprPlane): MedicalMprSlice {
  return createSlice(display, plane);
}

/** One of the three slices of a {@link MedicalMprDisplay}, to show in a chart of its own. */
export class MedicalMprSlice {
  /** The columns. */
  readonly width: number;
  /** The rows. */
  readonly height: number;
  /** The spacing of the pixels in millimetres. */
  readonly spacing: ImageSpacing;
  /** The directions of the slice in the patient. */
  readonly orientation: PatientOrientation;
  /** The directions of the patient at the edges. */
  readonly orientationMarks: MedicalOrientationMarks;
  /** @internal The values of the slice shown, row after row from the top. */
  readonly data: HeatmapData;
  private index = -1;
  private readonly texts: readonly string[];
  private layer: MedicalMeasurementLayer | undefined;

  static {
    createSlice = (display, plane) => new MedicalMprSlice(display, plane);
  }

  private constructor(
    /** The display the slice belongs to. */
    readonly display: MedicalMprDisplay,
    /** The plane. */
    readonly plane: MedicalMprPlane,
  ) {
    const shape = sliceShape(display.source, plane);
    this.width = shape.width;
    this.height = shape.height;
    this.spacing = shape.spacing;
    this.orientation = shape.orientation;
    this.orientationMarks = marksOf(shape.orientation);
    this.data = new HeatmapData(this.width, this.height);
    const data = display.source.data;
    const spacing = display.source.voxelSpacing;
    const count = plane === 'axial' ? data.depth : plane === 'coronal' ? data.height : data.width;
    const step = plane === 'axial' ? spacing.z : plane === 'coronal' ? spacing.y : spacing.x;
    this.texts = Array.from(
      { length: count },
      (_, i) => `${String(i + 1)} / ${String(count)} · ${String(Math.round(i * step * 1000) / 1000)} mm`,
    );
    this.update(display.position);
    display.onPositionChanged((position) => {
      this.update(position);
    });
  }

  /** The index of the slice shown. */
  get sliceIndex(): number {
    return this.index;
  }

  /** The number of slices of the plane. */
  get sliceCount(): number {
    return this.texts.length;
  }

  /** The measurements on the slices of this plane. */
  get measurements(): MedicalMeasurementLayer {
    this.layer ??= newMeasurementLayer(this.measurementSource());
    return this.layer;
  }

  /** The values of the slice shown, row after row from the top. */
  values(): Float32Array {
    return Float32Array.from({ length: this.width * this.height }, (_, i) =>
      this.data.at(i % this.width, Math.floor(i / this.width)),
    );
  }

  /** Calls a function whenever the window changes; returns a function that stops it. */
  onWindowChanged(listener: (window: MedicalWindow) => void): () => void {
    return this.display.onWindowChanged(listener);
  }

  /** Calls a function whenever another slice shows; returns a function that stops it. */
  onSliceChanged(listener: () => void): () => void {
    let shown = this.index;
    return this.display.onPositionChanged(() => {
      if (this.index !== shown) {
        shown = this.index;
        listener();
      }
    });
  }

  /** Shows the slice a number of steps further, kept inside the volume. */
  step(steps: number): void {
    this.showSlice(this.index + steps);
  }

  /** Shows a slice by its index, kept inside the volume. */
  showSlice(index: number): void {
    const clamped = Math.min(Math.max(Math.round(index), 0), this.sliceCount - 1);
    const position = this.display.position;
    const distance = this.sliceDistance;
    const at = clamped * distance;
    this.display.setPosition(
      this.plane === 'axial'
        ? new Point3D(position.x, position.y, at)
        : this.plane === 'coronal'
          ? new Point3D(position.x, at, position.z)
          : new Point3D(at, position.y, position.z),
    );
  }

  /** Describes the chart of the slice. */
  configure(chart: ChartBuilder): ChartBuilder {
    const window = this.display.window;
    const xLength = this.width * this.spacing.column;
    const yLength = this.height * this.spacing.row;
    const title = this.plane.charAt(0).toUpperCase() + this.plane.slice(1);
    return chart
      .title(title)
      .xAxis((axis) => axis.numeric('medical-mpr-x').title('mm').range(0, xLength).limits(0, xLength))
      .yAxis((axis) => axis.numeric('medical-mpr-y').title('mm').range(0, yLength).limits(0, yLength).inverted())
      .yAxis((axis) =>
        axis.color('Grayscale', 'medical-mpr-values').range(window.minimum, window.maximum).title(this.display.unit),
      )
      .addSeries(
        (x, y, axis) => {
          const colors = axis('medical-mpr-values') as ColorAxis;
          colors.colormap = this.display.colormap;
          const series = new HeatmapSeries(this.data, x, y, colors);
          series.name = this.display.unit;
          series.xStart = 0;
          series.xStep = this.spacing.column;
          series.yStart = 0;
          series.yStep = this.spacing.row;
          series.isInterpolated = this.display.isInterpolated;
          return series;
        },
        'medical-mpr-x',
        'medical-mpr-y',
      )
      .addSeries(
        (x, y) =>
          new SegmentationSeries(this, segmentationOf(this.display).layers, segmentationOf(this.display).stamp, x, y),
        'medical-mpr-x',
        'medical-mpr-y',
      )
      .addOverlay(
        (surface) => new MedicalMprOverlay(this, surface.horizontalAxes[0] as Axis, surface.panes[0]?.axes[0] as Axis),
      )
      .addOverlay((surface) => this.measurements.attach(surface))
      .addModifier(() => new MedicalMeasurementModifier(this.measurements))
      .addModifier(() => new MedicalMprModifier(this))
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
      })
      .addModifier(() => new KeyboardNavigationModifier());
  }

  /** @internal The place in the volume of a point of the slice in millimetres, on the slice of a place or of the place. */
  toVolumePosition(x: number, y: number, current: Point3D = this.display.position): Point3D {
    const source = this.display.source;
    const maximumZ = (source.data.depth - 1) * source.voxelSpacing.z;
    const column = x - this.spacing.column / 2;
    const row = y - this.spacing.row / 2;
    switch (this.plane) {
      case 'axial':
        return new Point3D(column, row, current.z);
      case 'coronal':
        return new Point3D(column, current.y, maximumZ - row);
      default:
        return new Point3D(current.x, column, maximumZ - row);
    }
  }

  /** @internal The point of the slice in millimetres of a place in the volume. */
  fromVolumePosition(position: Point3D): Point {
    const source = this.display.source;
    const maximumZ = (source.data.depth - 1) * source.voxelSpacing.z;
    switch (this.plane) {
      case 'axial':
        return { x: position.x + this.spacing.column / 2, y: position.y + this.spacing.row / 2 };
      case 'coronal':
        return { x: position.x + this.spacing.column / 2, y: maximumZ - position.z + this.spacing.row / 2 };
      default:
        return { x: position.y + this.spacing.column / 2, y: maximumZ - position.z + this.spacing.row / 2 };
    }
  }

  /** @internal A place on the slice of an index. */
  slicePosition(index: number): Point3D {
    const at = index * this.sliceDistance;
    return this.plane === 'axial'
      ? new Point3D(0, 0, at)
      : this.plane === 'coronal'
        ? new Point3D(0, at, 0)
        : new Point3D(at, 0, 0);
  }

  /** @internal The text of the slice shown, such as 97 / 192 · 96 mm. */
  get sliceText(): string {
    return this.texts[Math.max(this.index, 0)] as string;
  }

  private get sliceDistance(): number {
    const spacing = this.display.source.voxelSpacing;
    return this.plane === 'axial' ? spacing.z : this.plane === 'coronal' ? spacing.y : spacing.x;
  }

  private update(position: Point3D): void {
    const index = sliceIndex(this.display.source, this.plane, position);
    if (index === this.index) {
      return;
    }
    this.index = index;
    const values = new Float32Array(this.width * this.height);
    const data = this.display.source.data;
    for (let row = 0; row < this.height; row++) {
      for (let column = 0; column < this.width; column++) {
        values[row * this.width + column] = sliceValue(data, this.plane, index, column, row);
      }
    }
    this.data.setValues(values);
  }

  private measurementSource(): MedicalMeasurementSource {
    const slice = this as MedicalMprSlice;
    const data = this.display.source.data;
    return {
      width: this.width,
      height: this.height,
      spacing: this.spacing,
      get slice(): number {
        return Math.max(slice.index, 0);
      },
      sliceCount: this.sliceCount,
      sliceDistance: this.sliceDistance,
      unit: this.display.unit,
      read: (index, column, row) => sliceValue(data, this.plane, index, column, row),
      get valueRange(): DoubleRange {
        return data.valueRange;
      },
      get window(): MedicalWindow {
        return slice.display.window;
      },
    };
  }
}

// The slice number, the place as a cross and the directions of the patient.
class MedicalMprOverlay extends ChartOverlay {
  private shown = '';

  constructor(
    private readonly slice: MedicalMprSlice,
    private readonly xAxis: Axis,
    private readonly yAxis: Axis,
  ) {
    super();
    slice.display.onPositionChanged(() => {
      this.changed();
    });
    slice.display.cine.onStateChanged(() => {
      this.changed();
    });
  }

  draw(canvas: OverlayCanvas): void {
    const plot = canvas.layout.plotArea;
    const slice = this.slice;
    this.shown = slice.sliceText;
    const at = slice.fromVolumePosition(slice.display.position);
    const color = { r: 255, g: 160, b: 50, a: 220 };
    const label = canvas.drawLabel(
      this.shown,
      plot.x + 6,
      plot.y + 6,
      { r: 12, g: 16, b: 24, a: 220 },
      { r: 235, g: 240, b: 248, a: 255 },
    );
    const cine = slice.display.cine;
    const status = cine.statusText;
    if (cine.plane === slice.plane && status !== undefined) {
      canvas.drawLabel(status, plot.x + 6, label.bottom + 3, { r: 12, g: 16, b: 24, a: 220 }, color);
    }
    const x = this.position(canvas, this.xAxis, at.x);
    if (x !== undefined) {
      canvas.drawLine(
        { x: Math.fround(x), y: Math.fround(plot.y) },
        { x: Math.fround(x), y: Math.fround(plot.bottom) },
        1,
        color,
      );
    }
    const y = this.position(canvas, this.yAxis, at.y);
    if (y !== undefined) {
      canvas.drawLine(
        { x: Math.fround(plot.x), y: Math.fround(y) },
        { x: Math.fround(plot.right), y: Math.fround(y) },
        1,
        color,
      );
    }
    const size = 15;
    const height = canvas.lineHeight(size);
    const marks = slice.orientationMarks;
    this.centered(canvas, marks.top, plot.x + plot.width / 2, plot.y + height + 5, size);
    this.centered(canvas, marks.bottom, plot.x + plot.width / 2, plot.bottom - 6, size);
    this.centered(canvas, marks.left, plot.x + 12, plot.y + plot.height / 2, size);
    this.centered(canvas, marks.right, plot.right - 12, plot.y + plot.height / 2, size);
  }

  private position(canvas: OverlayCanvas, axis: Axis, value: number): number | undefined {
    const placement = canvas.layout.axes.find((each) => each.axis === axis);
    if (!placement) {
      return undefined;
    }
    const bounds = placement.bounds;
    const transform = axis.isHorizontal
      ? axis.createTransform(bounds.x, bounds.width)
      : axis.createTransform(bounds.y, bounds.height);
    return transform.toPixel(value);
  }

  private centered(canvas: OverlayCanvas, text: string, x: number, baseline: number, size: number): void {
    canvas.drawText(text, x - canvas.measureWidth(text, size) / 2, baseline, size, { r: 255, g: 220, b: 90, a: 255 });
  }
}

const clickReach = 4;

// Window by dragging, the place by a click, slices by the wheel and the arrows, presets by 1 to 3.
class MedicalMprModifier extends ChartModifier {
  private stops: (() => void)[] = [];
  private startWindow: MedicalWindow;
  private start: Point = { x: 0, y: 0 };
  private last: Point = { x: 0, y: 0 };
  private pointerId = 0;
  private isDragging = false;
  private isClick = false;

  constructor(private readonly slice: MedicalMprSlice) {
    super(50);
    this.startWindow = slice.display.window;
  }

  protected override onAttached(interaction: ChartInteraction): void {
    const chart = interaction.chart;
    const cine = this.slice.display.cine;
    cine.attach();
    this.stops = [
      () => {
        cine.detach();
      },
      this.slice.display.onWindowChanged((window) => {
        interaction.run(() => {
          // Found when needed: a chart described anew may attach its modifiers before its axes are there.
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
    const interaction = this.interaction;
    if (!this.isDragging) {
      if (
        input.kind !== 'pressed' ||
        input.changedButton !== 'primary' ||
        input.modifiers !== 0 ||
        !interaction?.hitPane(input.position)
      ) {
        return 'ignored';
      }
      this.isDragging = true;
      this.isClick = true;
      this.pointerId = input.pointerId;
      this.start = input.position;
      this.last = input.position;
      this.startWindow = this.slice.display.window;
      return 'capture';
    }
    if (input.pointerId !== this.pointerId) {
      return 'ignored';
    }
    if (input.kind === 'moved') {
      this.last = input.position;
      this.isClick &&= Math.hypot(input.position.x - this.start.x, input.position.y - this.start.y) <= clickReach;
      if (!this.isClick) {
        const scale = Math.max(this.startWindow.width / 256, 0.01);
        const width = Math.max(1e-6, this.startWindow.width + (input.position.x - this.start.x) * scale);
        const center = this.startWindow.center - (input.position.y - this.start.y) * scale;
        this.slice.display.setWindow(center, width);
      }
      return 'handled';
    }
    if (input.kind === 'released' || input.kind === 'canceled') {
      this.isDragging = false;
      if (this.isClick && input.kind === 'released') {
        this.setPosition(this.last);
      }
      return 'release';
    }
    return 'handled';
  }

  override onKey(input: KeyInputEvent): ModifierResult {
    if (input.kind !== 'pressed' || input.modifiers !== 0) {
      return 'ignored';
    }
    const preset =
      input.key === 'D1'
        ? CtWindowPresets.brain
        : input.key === 'D2'
          ? CtWindowPresets.bone
          : input.key === 'D3'
            ? CtWindowPresets.lung
            : undefined;
    if (preset) {
      this.slice.display.applyPreset(preset);
      return 'handled';
    }
    const slice = this.slice;
    const cine = slice.display.cine;
    switch (input.key) {
      case 'Up':
      case 'Right':
      case 'PageUp':
        cine.pause();
        cine.step(slice.plane, 1);
        return 'handled';
      case 'Down':
      case 'Left':
      case 'PageDown':
        cine.pause();
        cine.step(slice.plane, -1);
        return 'handled';
      case 'Home':
        cine.pause();
        slice.showSlice(0);
        return 'handled';
      case 'End':
        cine.pause();
        slice.showSlice(slice.sliceCount - 1);
        return 'handled';
      case 'Space':
        cine.toggle(slice.plane);
        return 'handled';
      case 'Add':
        cine.framesPerSecond = Math.min(cine.framesPerSecond * 1.25, 120);
        return 'handled';
      case 'Subtract':
        cine.framesPerSecond = Math.max(cine.framesPerSecond / 1.25, 0.5);
        return 'handled';
      default:
        return 'ignored';
    }
  }

  override onWheel(input: WheelInputEvent): ModifierResult {
    if (input.modifiers !== 0 || input.delta.y === 0 || !this.interaction?.hitPane(input.position)) {
      return 'ignored';
    }
    this.slice.display.cine.pause();
    this.slice.step(input.delta.y > 0 ? 1 : -1);
    return 'handled';
  }

  override onCaptureLost(_capture: InputCapture): void {
    this.isDragging = false;
  }

  // The middle of the pixel under the pointer becomes the place, as the series of the .NET version finds it.
  private setPosition(pointer: Point): void {
    const chart = this.interaction?.chart;
    const series = chart?.series.find((each) => each instanceof HeatmapSeries);
    const layout = chart?.currentLayout;
    if (!series || !layout) {
      return;
    }
    const bounds = layout.plotArea;
    const x = series.xAxis.createTransform(bounds.x, bounds.width).toData(pointer.x);
    const y = series.yAxis.createTransform(bounds.y, bounds.height).toData(pointer.y);
    const column = Math.floor(x / this.slice.spacing.column);
    const row = Math.floor(y / this.slice.spacing.row);
    if (column < 0 || column >= this.slice.width || row < 0 || row >= this.slice.height) {
      return;
    }
    this.slice.display.setPosition(
      this.slice.toVolumePosition((column + 0.5) * this.slice.spacing.column, (row + 0.5) * this.slice.spacing.row),
    );
  }
}

// The points of all lines; the ring of points keeps this many, so a write of exactly as many replaces it.
const lineCapacity = 8192;

// The measurements of the three slices as lines in the volume, the selected one in its own colour, over everything.
class Measurements3D {
  readonly lines = new Line3D(new Points3D(lineCapacity), {
    color: { r: 255, g: 214, b: 10, a: 255 },
    width: 2,
    drawsOnTop: true,
  });
  readonly selected = new Line3D(new Points3D(lineCapacity), {
    color: { r: 80, g: 220, b: 255, a: 255 },
    width: 2.5,
    drawsOnTop: true,
  });

  constructor(private readonly display: MedicalMprDisplay) {
    for (const slice of this.slices) {
      slice.measurements.onChanged(() => {
        this.refresh();
      });
      slice.measurements.onSelectionChanged(() => {
        this.refresh();
      });
    }
    this.refresh();
  }

  private get slices(): readonly MedicalMprSlice[] {
    return [this.display.axial, this.display.coronal, this.display.sagittal];
  }

  private refresh(): void {
    const all: (Point3D | undefined)[] = [];
    const chosen: (Point3D | undefined)[] = [];
    for (const slice of this.slices) {
      const layer = slice.measurements;
      for (const measurement of layer.measurements) {
        const points = measurement.isRegion ? measurement.outline : measurement.points;
        const at = slice.slicePosition(measurement.slice);
        const line = points.map((point) => slice.toVolumePosition(point.x, point.y, at));
        if (measurement.isRegion && points.length > 2) {
          line.push(line[0] as Point3D);
        }
        // Over everything, like the outlines of the planes: a measurement behind a plane stays in sight.
        const target = measurement === layer.selected ? chosen : all;
        target.push(...line, undefined);
      }
    }
    write(this.lines.points, all);
    write(this.selected.points, chosen);
  }
}

// All points of the ring at once: the measurements, then gaps up to the capacity, so nothing old stays.
function write(target: Points3D, points: readonly (Point3D | undefined)[]): void {
  for (let i = 0; i < lineCapacity; i++) {
    const point = points[i];
    if (point) {
      target.append(point.x, point.y, point.z);
    } else {
      target.appendGap();
    }
  }
}

/** Plays the slices of one plane of a display one after the other, as a film, while one of its slices is in a chart. */
export class MedicalCinePlayer {
  private shownPlane: MedicalMprPlane = 'axial';
  private speed = 24;
  private playing = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private attached = 0;
  private readonly listeners = new Set<() => void>();

  /** @internal Use {@link MedicalMprDisplay.cine}. */
  constructor(private readonly display: MedicalMprDisplay) {}

  /** The plane that plays or played last. */
  get plane(): MedicalMprPlane {
    return this.shownPlane;
  }

  /** Whether the film plays. */
  get isPlaying(): boolean {
    return this.playing;
  }

  /**
   * The slices a second; 24 by default.
   * @throws RangeError unless finite, positive and at most 120.
   */
  get framesPerSecond(): number {
    return this.speed;
  }

  set framesPerSecond(value: number) {
    if (!(Number.isFinite(value) && value > 0 && value <= 120)) {
      throw new RangeError('The speed must be finite, positive and no greater than 120 frames per second.');
    }
    if (value === this.speed) {
      return;
    }
    this.speed = value;
    if (this.timer !== undefined) {
      this.stopTimer();
      this.startTimer();
    }
    this.changed();
  }

  /** @internal The state for the overlay of a slice, such as ▶ 24 fps, or undefined while paused. */
  get statusText(): string | undefined {
    return this.playing ? `▶ ${String(Math.round(this.speed * 10) / 10)} fps` : undefined;
  }

  /** Calls a function whenever the film starts, stops, changes its speed or its plane; returns a function that stops it. */
  onStateChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Shows the slice a number of steps further in a plane, kept inside the volume. */
  step(plane: MedicalMprPlane, slices: number): void {
    const changed = this.setPlane(plane);
    if (slices !== 0) {
      this.slice(plane).step(slices);
    }
    if (changed) {
      this.changed();
    }
  }

  /** Plays the slices of a plane, from the end back to the start. */
  play(plane: MedicalMprPlane): void {
    let changed = this.setPlane(plane);
    if (!this.playing) {
      this.playing = true;
      changed = true;
    }
    this.startTimer();
    if (changed) {
      this.changed();
    }
  }

  /** Stops the film. */
  pause(): void {
    if (!this.playing) {
      return;
    }
    this.playing = false;
    this.stopTimer();
    this.changed();
  }

  /** Plays a plane, or stops it when it plays. */
  toggle(plane: MedicalMprPlane): void {
    if (this.playing && this.shownPlane === plane) {
      this.pause();
    } else {
      this.play(plane);
    }
  }

  /** @internal The next slice, the first after the last. */
  advance(): void {
    const slice = this.slice(this.shownPlane);
    slice.showSlice(slice.sliceIndex + 1 === slice.sliceCount ? 0 : slice.sliceIndex + 1);
  }

  /** @internal A chart of a slice is there to play in. */
  attach(): void {
    this.attached++;
    this.startTimer();
  }

  /** @internal A chart of a slice is gone; without any the film stops. */
  detach(): void {
    this.attached = Math.max(this.attached - 1, 0);
    if (this.attached === 0) {
      this.stopTimer();
      if (this.playing) {
        this.playing = false;
        this.changed();
      }
    }
  }

  private slice(plane: MedicalMprPlane): MedicalMprSlice {
    return plane === 'axial' ? this.display.axial : plane === 'coronal' ? this.display.coronal : this.display.sagittal;
  }

  private setPlane(plane: MedicalMprPlane): boolean {
    if (this.shownPlane === plane) {
      return false;
    }
    this.shownPlane = plane;
    return true;
  }

  private startTimer(): void {
    if (!this.playing || this.attached === 0 || this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.playing) {
        this.advance();
      }
    }, 1000 / this.speed);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
