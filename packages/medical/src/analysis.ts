// The profile along a distance and the histogram of a region or a slice, as MedicalProfile and MedicalHistogram of the
// .NET version: each a chart of its own that follows the measurements of an image.
import {
  BandAnnotation,
  BarSeries,
  CrosshairModifier,
  DataSource,
  DoubleRange,
  TooltipModifier,
  ZoomPanModifier,
  type Axis,
  type ChartBuilder,
  type Histogram,
} from '@tachyon-charts/core';
import {
  forEachInside,
  measurementSourceOf,
  type MedicalMeasurement,
  type MedicalMeasurementLayer,
  type MedicalMeasurementSource,
} from './measurements';
import type { MedicalWindow } from './medical-image';

const mostSamples = 4096;

/** An image a profile or a histogram follows, such as a {@link MedicalImageDisplay}. */
export interface MedicalMeasuredImage {
  /** Its measurements. */
  readonly measurements: MedicalMeasurementLayer;
  /** Calls a function whenever the window changes; returns a function that stops it. */
  onWindowChanged(listener: (window: MedicalWindow) => void): () => void;
  /** Calls a function whenever another slice shows, for images of a volume; returns a function that stops it. */
  onSliceChanged?(listener: () => void): () => void;
}

/** @internal A value between the middles of the four nearest pixels, NaN outside the image. */
export function sampleAt(source: MedicalMeasurementSource, slice: number, x: number, y: number): number {
  const column = x / source.spacing.column - 0.5;
  const row = y / source.spacing.row - 0.5;
  if (column < -0.5 || row < -0.5 || column > source.width - 0.5 || row > source.height - 0.5) {
    return Number.NaN;
  }
  const left = Math.min(Math.max(Math.floor(column), 0), source.width - 1);
  const top = Math.min(Math.max(Math.floor(row), 0), source.height - 1);
  const right = Math.min(left + 1, source.width - 1);
  const bottom = Math.min(top + 1, source.height - 1);
  const u = Math.min(Math.max(column - left, 0), 1);
  const v = Math.min(Math.max(row - top, 0), 1);
  const upper = source.read(slice, left, top) * (1 - u) + source.read(slice, right, top) * u;
  const lower = source.read(slice, left, bottom) * (1 - u) + source.read(slice, right, bottom) * u;
  return upper * (1 - v) + lower * v;
}

/** The values along a distance measurement in a chart of their own: millimetres along the line against the value. */
export class MedicalProfile {
  /** The samples: millimetres along the line and the values there. */
  readonly data = new DataSource(mostSamples);
  private readonly layer: MedicalMeasurementLayer;
  private readonly source: MedicalMeasurementSource;
  private fixed: MedicalMeasurement | undefined;
  private current: MedicalMeasurement | undefined;

  /** @param image - The image whose distances the profile follows, such as a {@link MedicalImageDisplay}. */
  constructor(image: MedicalMeasuredImage) {
    this.layer = image.measurements;
    this.source = measurementSourceOf(image.measurements);
    this.layer.onChanged(() => {
      this.update();
    });
    image.onSliceChanged?.(() => {
      this.update();
    });
    this.update();
  }

  /**
   * The distance shown; when undefined, the selected one or the last one on the slice shown.
   * @throws RangeError for a measurement that is no distance.
   */
  get line(): MedicalMeasurement | undefined {
    return this.fixed;
  }

  set line(value: MedicalMeasurement | undefined) {
    if (value && value.kind !== 'distance') {
      throw new RangeError('A profile follows a distance measurement.');
    }
    this.fixed = value;
    this.update();
  }

  /** The distance shown now. */
  get shown(): MedicalMeasurement | undefined {
    return this.current;
  }

  /** Describes the chart of the profile. */
  configure(chart: ChartBuilder): ChartBuilder {
    return chart
      .title('Profile')
      .xAxis((axis) => axis.numeric('medical-profile-x').title('mm').autoRange())
      .yAxis((axis) => axis.numeric('medical-profile-y').title(this.layer.unit).autoRange())
      .addLine(this.data, (line) => line.name(this.layer.unit).thickness(1.5))
      .addModifier(() => new ZoomPanModifier())
      .addModifier(() => {
        const crosshair = new CrosshairModifier();
        crosshair.showsValues = true;
        return crosshair;
      });
  }

  // Samples at half the smaller pixel size, blended from the four nearest pixels.
  private update(): void {
    this.current = this.fixed ?? this.pick();
    this.data.clear();
    const line = this.current;
    if (!line || (line.slice !== this.source.slice && this.fixed === undefined)) {
      return;
    }
    const source = this.source;
    const start = line.points[0] as { x: number; y: number };
    const end = line.points[1] as { x: number; y: number };
    const length = Math.sqrt((end.x - start.x) * (end.x - start.x) + (end.y - start.y) * (end.y - start.y));
    const step = Math.min(source.spacing.column, source.spacing.row) / 2;
    const count = Math.min(Math.max(Math.ceil(length / step) + 1, 2), mostSamples);
    const along = new Float64Array(count);
    const values = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const share = i / (count - 1);
      along[i] = share * length;
      values[i] = sampleAt(
        source,
        line.slice,
        start.x + (end.x - start.x) * share,
        start.y + (end.y - start.y) * share,
      );
    }
    this.data.append(along, values);
  }

  private pick(): MedicalMeasurement | undefined {
    const selected = this.layer.selected;
    if (selected?.kind === 'distance') {
      return selected;
    }
    const all = this.layer.measurements;
    for (let i = all.length - 1; i >= 0; i--) {
      const each = all[i] as MedicalMeasurement;
      if (each.kind === 'distance' && each.slice === this.source.slice) {
        return each;
      }
    }
    return undefined;
  }
}

/** The values of a region, or of the whole slice, counted into fixed bins, with the window as a band. */
export class MedicalHistogram {
  private readonly layer: MedicalMeasurementLayer;
  private readonly source: MedicalMeasurementSource;
  private readonly edges: Float64Array;
  private readonly counts: Float64Array;
  private readonly bars: BarSeries[] = [];
  private readonly bands: BandAnnotation[] = [];
  private readonly axes: Axis[] = [];
  private fixed: MedicalMeasurement | undefined;
  private current: MedicalMeasurement | undefined;
  private counted: Histogram;

  /**
   * @param image - The image whose regions the histogram counts, such as a {@link MedicalImageDisplay}.
   * @param bins - The bins over all values of the image.
   * @throws RangeError with fewer than two bins.
   */
  constructor(image: MedicalMeasuredImage, bins = 512) {
    if (!(Number.isInteger(bins) && bins >= 2)) {
      throw new RangeError('A histogram needs at least two bins.');
    }
    this.layer = image.measurements;
    this.source = measurementSourceOf(image.measurements);
    const range = this.source.valueRange;
    const usable = range.length > 0 && Number.isFinite(range.length);
    const low = usable ? range.min : range.min - 0.5;
    const high = usable ? range.max : range.min + 0.5;
    this.edges = Float64Array.from({ length: bins + 1 }, (_, i) => low + ((high - low) * i) / bins);
    this.counts = new Float64Array(bins);
    this.counted = { edges: this.edges.slice(), counts: this.counts.slice() };
    this.layer.onChanged(() => {
      this.update();
    });
    image.onSliceChanged?.(() => {
      this.update();
    });
    image.onWindowChanged((window) => {
      this.showWindow(window);
    });
    this.update();
  }

  /**
   * The region counted; when undefined, the selected region, else the whole slice.
   * @throws RangeError for a measurement that is no region.
   */
  get region(): MedicalMeasurement | undefined {
    return this.fixed;
  }

  set region(value: MedicalMeasurement | undefined) {
    if (value && !value.isRegion) {
      throw new RangeError('A histogram shows a circle, a rectangle or a freehand region.');
    }
    this.fixed = value;
    this.update();
  }

  /** The region counted now, or undefined for the whole slice. */
  get shown(): MedicalMeasurement | undefined {
    return this.current;
  }

  /** The bins and their counts now. */
  get histogram(): Histogram {
    return this.counted;
  }

  /** Describes the chart of the histogram. */
  configure(chart: ChartBuilder): ChartBuilder {
    const view = this.view(this.source.window);
    return chart
      .title('Histogram')
      .xAxis((axis) =>
        axis
          .numeric('medical-histogram-x')
          .title(this.layer.unit)
          .range(view.min, view.max)
          .limits(this.edges[0] as number, this.edges[this.edges.length - 1] as number),
      )
      .yAxis((axis) => axis.numeric('medical-histogram-y').title('Pixels').autoRange())
      .addSeries((x, y) => {
        const bars = BarSeries.fromHistogram(this.counted, x, y);
        this.bars.push(bars);
        return bars;
      })
      .addOverlay((surface) => {
        const axis = surface.horizontalAxes[0] as Axis;
        const band = new BandAnnotation(axis);
        band.color = { r: 80, g: 220, b: 255, a: 45 };
        band.setRange(this.source.window.minimum, this.source.window.maximum);
        this.bands.push(band);
        this.axes.push(axis);
        return band;
      })
      .addModifier(() => new ZoomPanModifier())
      .addModifier(() => new TooltipModifier());
  }

  // The values around the window matter for windowing, so the view shows the window and half its width on each side.
  private showWindow(window: MedicalWindow): void {
    for (const band of this.bands) {
      band.setRange(window.minimum, window.maximum);
    }
    for (const axis of this.axes) {
      axis.visibleRange = this.view(window);
    }
  }

  private view(window: MedicalWindow): DoubleRange {
    const first = this.edges[0] as number;
    const last = this.edges[this.edges.length - 1] as number;
    const low = Math.max(window.minimum - window.width / 2, first);
    const high = Math.min(window.maximum + window.width / 2, last);
    return high > low ? new DoubleRange(low, high) : new DoubleRange(first, last);
  }

  // Counts the pixels of the region, or of the whole slice, into the fixed bins.
  private update(): void {
    const selected = this.layer.selected;
    this.current = this.fixed ?? (selected?.isRegion ? selected : undefined);
    this.counts.fill(0);
    const source = this.source;
    const count = (value: number): void => {
      if (!Number.isFinite(value)) {
        return;
      }
      const bins = this.counts.length;
      const first = this.edges[0] as number;
      const last = this.edges[this.edges.length - 1] as number;
      const index = Math.floor(((value - first) / (last - first)) * bins);
      const bin = Math.min(Math.max(index, 0), bins - 1);
      this.counts[bin] = (this.counts[bin] as number) + 1;
    };
    const region = this.current;
    if (region) {
      forEachInside(region.outline, region.slice, source, count);
    } else {
      for (let row = 0; row < source.height; row++) {
        for (let column = 0; column < source.width; column++) {
          count(source.read(source.slice, column, row));
        }
      }
    }
    this.counted = { edges: this.edges.slice(), counts: this.counts.slice() };
    for (const bars of this.bars) {
      bars.setValues([this.counts.slice()]);
    }
  }
}
