// A medical image on a chart, as MedicalImageDisplay of the .NET version: the values in millimetres with a window of
// grey values, the directions of the patient at the edges, the value under the pointer, window and level with the
// pointer and keys 1 to 3, and the colour bar to drag and turn.
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
import type { Point3D } from '@tachyon-charts/3d';
import type { MedicalImage } from './dicom';
import {
  MedicalMeasurementModifier,
  newMeasurementLayer,
  type MedicalMeasurementLayer,
  type MedicalMeasurementSource,
} from './measurements';
import {
  CtWindowPresets,
  MedicalWindow,
  checkOrientation,
  checkSpacing,
  type ImageSpacing,
  type PatientOrientation,
} from './medical-image';

const xAxisId = 'medical-x';
const yAxisId = 'medical-y';
const colorAxisId = 'medical-values';
const minimumWindowWidth = 1e-6;

/** The directions of the patient at the four edges of an image: R, L, A, P, S or I. */
export interface MedicalOrientationMarks {
  /** At the top edge. */
  readonly top: string;
  /** At the right edge. */
  readonly right: string;
  /** At the bottom edge. */
  readonly bottom: string;
  /** At the left edge. */
  readonly left: string;
}

/** The value of a pixel at a place in millimetres. */
export interface MedicalImageProbe {
  /** The column. */
  readonly column: number;
  /** The row. */
  readonly row: number;
  /** The place across in millimetres. */
  readonly x: number;
  /** The place down in millimetres. */
  readonly y: number;
  /** The value. */
  readonly value: number;
  /** The unit of the value, such as HU. */
  readonly unit: string;
}

/** A medical image to show on a chart: its values in millimetres with a window of grey values. */
export class MedicalImageDisplay {
  /** The data of the image, row after row from the top. */
  readonly data: HeatmapData;
  /** The directions of the patient at the edges. */
  readonly orientationMarks: MedicalOrientationMarks;
  /** The colours from the lowest to the highest value of the window. */
  colormap: Colormap = Colormap.builtIn('Grayscale');
  /** Whether the pixels blend into each other; sharp squares when false. */
  isInterpolated = true;
  /** @internal The window the image started with, for a double click on the colour bar. */
  readonly initialWindow: MedicalWindow;
  private current: MedicalWindow;
  private readonly listeners = new Set<(window: MedicalWindow) => void>();
  private layer: MedicalMeasurementLayer | undefined;
  private source: MedicalMeasurementSource | undefined;

  /**
   * @param values - The values, row after row from the top.
   * @param width - The columns.
   * @param height - The rows.
   * @param spacing - The spacing of the pixels in millimetres.
   * @param orientation - The directions of the image in the patient.
   * @param unit - The unit of the values, such as HU.
   * @throws RangeError when the values do not fill the image, or a spacing or the orientation is not usable.
   */
  constructor(
    values: ArrayLike<number>,
    /** The columns. */
    readonly width: number,
    /** The rows. */
    readonly height: number,
    /** The spacing of the pixels in millimetres. */
    readonly spacing: ImageSpacing,
    /** The directions of the image in the patient. */
    readonly orientation: PatientOrientation,
    /** The unit of the values. */
    readonly unit = 'value',
    window?: { readonly center?: number | undefined; readonly width?: number | undefined },
  ) {
    if (!(Number.isInteger(width) && width >= 1 && Number.isInteger(height) && height >= 1)) {
      throw new RangeError('An image needs at least one column and one row.');
    }
    if (values.length !== width * height) {
      throw new RangeError('The values do not fill the image.');
    }
    checkSpacing(spacing);
    checkOrientation(orientation);
    if (unit.trim().length === 0) {
      throw new RangeError('An image needs a unit.');
    }
    this.data = new HeatmapData(width, height);
    this.data.setValues(values instanceof Float32Array ? values : Float32Array.from(values));
    this.current = initialWindow(window?.center, window?.width, valueRange(this.data));
    this.initialWindow = this.current;
    this.orientationMarks = marksOf(orientation);
  }

  /**
   * Shows an image of a DICOM file in the window the file suggests, its unit HU for CT.
   * @throws RangeError when the image lacks its pixel spacing or its orientation.
   */
  static fromImage(image: MedicalImage): MedicalImageDisplay {
    if (!image.spacing || !image.orientation) {
      throw new RangeError('The image needs pixel spacing and patient orientation.');
    }
    return new MedicalImageDisplay(
      image.values(),
      image.width,
      image.height,
      image.spacing,
      image.orientation,
      image.modality?.toUpperCase() === 'CT' ? 'HU' : 'value',
      { center: image.windowCenter, width: image.windowWidth },
    );
  }

  /** The window of grey values shown. */
  get window(): MedicalWindow {
    return this.current;
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
    for (const listener of this.listeners) {
      listener(window);
    }
  }

  /** Calls a function whenever the window changes; returns a function that stops it. */
  onWindowChanged(listener: (window: MedicalWindow) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The value at a place in millimetres from the top left corner, or undefined outside the image. */
  valueAt(x: number, y: number): MedicalImageProbe | undefined {
    const column = Math.floor(x / this.spacing.column);
    const row = Math.floor(y / this.spacing.row);
    if (column < 0 || column >= this.width || row < 0 || row >= this.height) {
      return undefined;
    }
    return { column, row, x, y, value: this.data.at(column, row), unit: this.unit };
  }

  /** The measurements of the image in millimetres: distances, angles and regions with their statistics. */
  get measurements(): MedicalMeasurementLayer {
    this.layer ??= newMeasurementLayer(this.measurementSource());
    return this.layer;
  }

  // What the measurements read: a single image, one slice without a distance to the next.
  private measurementSource(): MedicalMeasurementSource {
    if (!this.source) {
      let range: DoubleRange | undefined;
      const read = (_slice: number, column: number, row: number): number => this.data.at(column, row);
      const display = this as MedicalImageDisplay;
      this.source = {
        width: this.width,
        height: this.height,
        spacing: this.spacing,
        slice: 0,
        sliceCount: 1,
        sliceDistance: 0,
        unit: this.unit,
        read,
        get valueRange(): DoubleRange {
          range ??= valueRange(display.data);
          return range;
        },
        get window(): MedicalWindow {
          return display.window;
        },
      };
    }
    return this.source;
  }

  /** Describes the chart of the image: axes in millimetres, the image, the colour bar and the tools. */
  configure(chart: ChartBuilder): ChartBuilder {
    const xLength = this.width * this.spacing.column;
    const yLength = this.height * this.spacing.row;
    const window = this.current;
    return (
      chart
        .title('Medical image')
        .xAxis((axis) => axis.numeric(xAxisId).title('mm').range(0, xLength).limits(0, xLength))
        .yAxis((axis) => axis.numeric(yAxisId).title('mm').range(0, yLength).limits(0, yLength).inverted())
        .yAxis((axis) => axis.color('Grayscale', colorAxisId).range(window.minimum, window.maximum).title(this.unit))
        .addSeries(
          (x, y, axis) => {
            const colors = axis(colorAxisId) as ColorAxis;
            colors.colormap = this.colormap;
            const series = new HeatmapSeries(this.data, x, y, colors);
            series.name = this.unit;
            series.xStart = 0;
            series.xStep = this.spacing.column;
            series.yStart = 0;
            series.yStep = this.spacing.row;
            series.isInterpolated = this.isInterpolated;
            return series;
          },
          xAxisId,
          yAxisId,
        )
        .addOverlay((surface) => this.measurements.attach(surface))
        .addModifier(() => new MedicalMeasurementModifier(this.measurements))
        .addModifier(() => new MedicalImageModifier(this))
        .addModifier(
          () =>
            new MedicalColorBarModifier(
              () => this.window,
              (value) => {
                this.applyPreset(value);
              },
              this.initialWindow,
            ),
        )
        .addModifier(() => {
          const zoom = new ZoomPanModifier();
          zoom.panButton = 'middle';
          return zoom;
        })
        // Ctrl+Z and Ctrl+Y undo and redo measurements as well as zooming.
        .addModifier(() => new KeyboardNavigationModifier())
    );
  }
}

/** @internal The window of a file, or one over all values. */
export function initialWindow(
  center: number | undefined,
  width: number | undefined,
  range: DoubleRange,
): MedicalWindow {
  if (center !== undefined && width !== undefined && width > 0 && Number.isFinite(center) && Number.isFinite(width)) {
    return new MedicalWindow('File', center, width);
  }
  const fallbackWidth = range.length > 0 && Number.isFinite(range.length) ? range.length : 1;
  const middle = (range.min + range.max) / 2;
  return new MedicalWindow('Data', fallbackWidth > 0 && Number.isFinite(middle) ? middle : 0, fallbackWidth);
}

function valueRange(data: HeatmapData): DoubleRange {
  let low = Infinity;
  let high = -Infinity;
  for (let row = 0; row < data.height; row++) {
    for (let column = 0; column < data.width; column++) {
      const value = data.at(column, row);
      if (Number.isFinite(value)) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
  }
  return low <= high ? new DoubleRange(low, high) : DoubleRange.empty;
}

/** @internal The letters of the patient's directions at the edges of an image. */
export function marksOf(orientation: PatientOrientation): MedicalOrientationMarks {
  const right = direction(orientation.across);
  const bottom = direction(orientation.down);
  return { top: opposite(bottom), right, bottom, left: opposite(right) };
}

function direction(value: Point3D): string {
  const x = Math.abs(value.x);
  const y = Math.abs(value.y);
  const z = Math.abs(value.z);
  if (x >= y && x >= z) {
    return value.x >= 0 ? 'L' : 'R';
  }
  if (y >= z) {
    return value.y >= 0 ? 'P' : 'A';
  }
  return value.z >= 0 ? 'S' : 'I';
}

function opposite(value: string): string {
  const pairs: Record<string, string> = { L: 'R', R: 'L', P: 'A', A: 'P', S: 'I' };
  return pairs[value] ?? 'S';
}

const formatOne = (value: number): string => value.toFixed(1);

// Window and level by dragging, the presets on 1 to 3, and the value under the pointer.
class MedicalImageModifier extends ChartModifier {
  private readonly overlay: MedicalImageOverlay;
  private stopListening: (() => void) | undefined;
  private start: Point = { x: 0, y: 0 };
  private startWindow: MedicalWindow;
  private pointerId = 0;
  private isDragging = false;

  constructor(private readonly display: MedicalImageDisplay) {
    super(50);
    this.overlay = new MedicalImageOverlay(display.orientationMarks);
    this.startWindow = display.window;
  }

  protected override onAttached(interaction: ChartInteraction): void {
    const chart = interaction.chart;
    this.stopListening = this.display.onWindowChanged((window) => {
      interaction.run(() => {
        // Found when needed: a chart described anew may attach its modifiers before its axes are there.
        const axis = chart.panes.flatMap((pane) => pane.axes).find((each) => each instanceof ColorAxis);
        if (axis) {
          axis.visibleRange = new DoubleRange(window.minimum, window.maximum);
        }
      });
    });
    interaction.run(() => {
      chart.addOverlay(this.overlay);
    });
  }

  protected override onDetached(interaction: ChartInteraction): void {
    this.stopListening?.();
    this.stopListening = undefined;
    interaction.run(() => {
      interaction.chart.removeOverlay(this.overlay);
    });
  }

  override onPointer(input: PointerInputEvent): ModifierResult {
    if (this.isDragging) {
      return input.pointerId === this.pointerId ? this.continueWindowing(input) : 'ignored';
    }
    this.updateProbe(input);
    const interaction = this.interaction;
    if (
      input.kind !== 'pressed' ||
      input.changedButton !== 'primary' ||
      input.modifiers !== 0 ||
      !interaction?.hitPane(input.position)
    ) {
      return 'ignored';
    }
    this.isDragging = true;
    this.pointerId = input.pointerId;
    this.start = input.position;
    this.startWindow = this.display.window;
    return 'capture';
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
    if (!preset) {
      return 'ignored';
    }
    this.display.applyPreset(preset);
    return 'handled';
  }

  override onCaptureLost(_capture: InputCapture): void {
    this.isDragging = false;
  }

  private continueWindowing(input: PointerInputEvent): ModifierResult {
    if (input.kind === 'moved') {
      const scale = Math.max(this.startWindow.width / 256, 0.01);
      const width = Math.max(minimumWindowWidth, this.startWindow.width + (input.position.x - this.start.x) * scale);
      const center = this.startWindow.center - (input.position.y - this.start.y) * scale;
      this.display.setWindow(center, width);
      return 'handled';
    }
    if (input.kind === 'released' || input.kind === 'canceled') {
      this.isDragging = false;
      return 'release';
    }
    return 'handled';
  }

  // The value of the pixel under the pointer, at the middle of the pixel as the heatmap finds it.
  private updateProbe(input: PointerInputEvent): void {
    const interaction = this.interaction;
    const pane =
      interaction && input.kind !== 'exited' && input.kind !== 'canceled'
        ? interaction.hitPane(input.position)
        : undefined;
    const series = interaction?.chart.series.find((each) => each instanceof HeatmapSeries);
    const layout = interaction?.chart.currentLayout;
    if (!pane || !series || !layout) {
      interaction?.run(() => {
        this.overlay.hideProbe();
      });
      return;
    }
    const bounds = layout.plotArea;
    const x = series.xAxis.createTransform(bounds.x, bounds.width).toData(input.position.x);
    const y = series.yAxis.createTransform(bounds.y, bounds.height).toData(input.position.y);
    const probe = this.display.valueAt(x, y);
    interaction.run(() => {
      if (!probe || !Number.isFinite(probe.value)) {
        this.overlay.hideProbe();
        return;
      }
      const middleX = (probe.column + 0.5) * this.display.spacing.column;
      const middleY = (probe.row + 0.5) * this.display.spacing.row;
      this.overlay.showProbe(
        input.position,
        `${formatOne(probe.value)} ${this.display.unit}   x ${formatOne(middleX)} mm   y ${formatOne(middleY)} mm`,
      );
    });
  }
}

class MedicalImageOverlay extends ChartOverlay {
  private probePosition: Point = { x: 0, y: 0 };
  private probeText: string | undefined;

  constructor(private readonly marks: MedicalOrientationMarks) {
    super();
  }

  showProbe(position: Point, text: string): void {
    this.probePosition = position;
    this.probeText = text;
    this.changed();
  }

  hideProbe(): void {
    if (this.probeText === undefined) {
      return;
    }
    this.probeText = undefined;
    this.changed();
  }

  draw(canvas: OverlayCanvas): void {
    const plot = canvas.layout.plotArea;
    const size = 15;
    const height = canvas.lineHeight(size);
    const marks = this.marks;
    this.centered(canvas, marks.top, plot.x + plot.width / 2, plot.y + height + 5, size);
    this.centered(canvas, marks.bottom, plot.x + plot.width / 2, plot.bottom - 6, size);
    this.centered(canvas, marks.left, plot.x + 12, plot.y + plot.height / 2, size);
    this.centered(canvas, marks.right, plot.right - 12, plot.y + plot.height / 2, size);
    if (this.probeText !== undefined) {
      canvas.drawLabel(
        this.probeText,
        this.probePosition.x + 12,
        this.probePosition.y + 12,
        { r: 20, g: 24, b: 32, a: 225 },
        canvas.colors.text,
      );
    }
  }

  private centered(canvas: OverlayCanvas, text: string, x: number, baseline: number, size: number): void {
    canvas.drawText(text, x - canvas.measureWidth(text, size) / 2, baseline, size, { r: 255, g: 220, b: 90, a: 255 });
  }
}

/** @internal Turning the wheel over the colour bar narrows or widens the window, dragging moves it, a double click resets it. */
export class MedicalColorBarModifier extends ChartModifier {
  private bar:
    | { readonly axis: { readonly isHorizontal: boolean }; readonly bounds: { width: number; height: number } }
    | undefined;
  private startWindow: MedicalWindow;
  private start: Point = { x: 0, y: 0 };
  private pointerId = 0;
  private isDragging = false;

  constructor(
    private readonly read: () => MedicalWindow,
    private readonly write: (window: MedicalWindow) => void,
    private readonly initial: MedicalWindow,
  ) {
    super(55);
    this.startWindow = initial;
  }

  /** A window narrowed by steps of 1.15, widened for negative steps. */
  static zoom(window: MedicalWindow, steps: number): MedicalWindow {
    return new MedicalWindow('Custom', window.center, Math.max(1e-6, window.width * Math.pow(1.15, -steps)));
  }

  override onWheel(input: WheelInputEvent): ModifierResult {
    if (input.delta.y === 0 || !this.hitsBar(input.position)) {
      return 'ignored';
    }
    this.write(MedicalColorBarModifier.zoom(this.read(), input.delta.y));
    return 'handled';
  }

  override onPointer(input: PointerInputEvent): ModifierResult {
    if (!this.isDragging) {
      const bar =
        input.kind === 'pressed' && input.changedButton === 'primary' ? this.hitsBar(input.position) : undefined;
      if (!bar) {
        return 'ignored';
      }
      if (input.clickCount >= 2) {
        this.write(this.initial);
        return 'handled';
      }
      this.isDragging = true;
      this.pointerId = input.pointerId;
      this.start = input.position;
      this.bar = bar;
      this.startWindow = this.read();
      return 'capture';
    }
    if (input.pointerId !== this.pointerId) {
      return 'ignored';
    }
    if (input.kind === 'released' || input.kind === 'canceled') {
      this.isDragging = false;
      return 'release';
    }
    if (input.kind === 'moved' && this.bar) {
      const horizontal = this.bar.axis.isHorizontal;
      const moved = horizontal ? input.position.x - this.start.x : this.start.y - input.position.y;
      const length = horizontal ? this.bar.bounds.width : this.bar.bounds.height;
      const shift = length > 0 ? (moved / length) * this.startWindow.width : 0;
      this.write(new MedicalWindow('Custom', this.startWindow.center - shift, this.startWindow.width));
    }
    return 'handled';
  }

  override onCaptureLost(_capture: InputCapture): void {
    this.isDragging = false;
  }

  private hitsBar(position: Point): MedicalColorBarModifier['bar'] {
    const placement = this.interaction?.hitAxis(position);
    return placement && placement.axis instanceof ColorAxis ? placement : undefined;
  }
}
