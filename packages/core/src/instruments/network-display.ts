// A vector network analyzer: traces of complex responses over frequency with limit lines and markers, and the chart
// of them, as NetworkDisplay, NetworkOverlay, NetworkMarkerModifier and NetworkChart of the .NET version.
import type { Axis } from '../axes/axis';
import { NumericAxis } from '../axes/numeric-axis';
import { DataSource } from '../data/data-source';
import type { ChartBuilder } from '../fluent/chart-builder';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import { InputModifiers, type Point, type PointerInputEvent } from '../input/primitives';
import { DipRect } from '../layout/chart-layout';
import { chartText, invariantCulture } from '../locale/culture';
import { formatFixed, formatWithPrefix } from '../locale/format';
import { roundHalfEven } from '../numerics/nice';
import { ChartOverlay, type OverlayCanvas } from '../overlays/chart-overlay';
import type { ChartSurface } from '../pipeline/chart-surface';
import { parseColor, type Rgba8 } from '../render/types';
import { LineSeries } from '../series/line-series';
import type { Complex } from '../series/smith-series';

const f = Math.fround;
const labelSize = 12;
const markerSize = 5;
const reach = 10;
const failColor: Rgba8 = { r: 255, g: 90, b: 80, a: 255 };
const traceColors: readonly Rgba8[] = [
  { r: 245, g: 214, b: 60, a: 255 },
  { r: 90, g: 170, b: 255, a: 255 },
  { r: 240, g: 110, b: 170, a: 255 },
  { r: 70, g: 215, b: 120, a: 255 },
];

/** How a network analyzer shows its traces: magnitude in dB, phase in degrees, or on a Smith chart. */
export type NetworkFormat = 'logMagnitude' | 'phase' | 'smith';

/** A straight limit from one frequency and level to another, which a trace must stay below or above. */
export interface LimitLine {
  /** Whether the trace has to stay below (maximum) or above (minimum). */
  readonly kind: 'maximum' | 'minimum';
  /** The first frequency. */
  readonly startFrequency: number;
  /** The level at the first frequency. */
  readonly startLevel: number;
  /** The last frequency. */
  readonly stopFrequency: number;
  /** The level at the last frequency. */
  readonly stopLevel: number;
}

/** Whether a level at a frequency keeps to a limit; true outside of its frequencies. */
export function passesLimit(limit: LimitLine, frequency: number, level: number): boolean {
  if (frequency < limit.startFrequency || frequency > limit.stopFrequency) {
    return true;
  }
  const share =
    limit.stopFrequency > limit.startFrequency
      ? (frequency - limit.startFrequency) / (limit.stopFrequency - limit.startFrequency)
      : 0;
  const bound = limit.startLevel + share * (limit.stopLevel - limit.startLevel);
  return limit.kind === 'maximum' ? level <= bound : level >= bound;
}

/** One trace of a network analyzer, such as S21. */
export class NetworkTrace {
  /** The levels over frequency, for the line. */
  readonly data = new DataSource();
  private readonly limitList: LimitLine[] = [];
  private frequencies = new Float64Array(0);
  private values: readonly Complex[] = [];
  private traceColor: Rgba8;

  /** @internal */
  constructor(
    private readonly display: NetworkDisplay,
    /** The name, such as S21. */
    readonly name: string,
    color: Rgba8,
  ) {
    this.traceColor = color;
  }

  /** The color; the chart sets it from the palette of its theme. */
  get color(): Rgba8 {
    return this.traceColor;
  }

  set color(value: Rgba8) {
    this.traceColor = value;
  }

  /** The limit lines. */
  get limits(): readonly LimitLine[] {
    return this.limitList;
  }

  /** Whether every point keeps to every limit; true when the format has no limits. */
  get passes(): boolean {
    if (!this.display.areLimitsActive) {
      return true;
    }
    for (let i = 0; i < this.frequencies.length; i++) {
      const level = this.display.toLevel(this.values[i] as Complex);
      if (this.limitList.some((limit) => !passesLimit(limit, this.frequencies[i] as number, level))) {
        return false;
      }
    }
    return true;
  }

  /** Adds a limit line. */
  addLimit(limit: LimitLine): void {
    this.limitList.push(limit);
    this.display.touch();
  }

  /**
   * Shows a new sweep: rising frequencies and the complex response at each.
   * @throws RangeError when the numbers differ.
   */
  setSweep(frequencies: ArrayLike<number>, values: readonly Complex[]): void {
    if (frequencies.length !== values.length) {
      throw new RangeError('Each frequency needs a value.');
    }
    this.frequencies = Float64Array.from(frequencies);
    this.values = values;
    const levels = Float32Array.from(values, (value) => this.display.toLevel(value));
    this.data.clear();
    this.data.append(this.frequencies, levels);
    this.display.touch();
  }

  /** The value at the nearest frequency, or nothing before the first sweep. */
  read(frequency: number): Complex | undefined {
    const frequencies = this.frequencies;
    const count = frequencies.length;
    if (count === 0) {
      return undefined;
    }
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const value = frequencies[middle] as number;
      if (value === frequency) {
        return this.values[middle];
      }
      if (value < frequency) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    let index = low;
    if (low === 0) {
      index = 0;
    } else if (low >= count) {
      index = count - 1;
    } else if (frequency - (frequencies[low - 1] as number) < (frequencies[low] as number) - frequency) {
      index = low - 1;
    }
    return this.values[index];
  }
}

/** The state of a network analyzer: traces in one format and markers. */
export class NetworkDisplay {
  private readonly traceList: NetworkTrace[] = [];
  private markerList: readonly number[] = [];
  private changes = 0;

  /** @param format - The format; magnitude in dB by default. */
  constructor(
    /** The format. */
    readonly format: NetworkFormat = 'logMagnitude',
  ) {}

  /** Whether the limits apply; not on a Smith chart. */
  get areLimitsActive(): boolean {
    return this.format !== 'smith';
  }

  /** The traces. */
  get traces(): readonly NetworkTrace[] {
    return this.traceList;
  }

  /** The frequencies of the markers. */
  get markers(): readonly number[] {
    return this.markerList;
  }

  /** Grows with every change. */
  get version(): number {
    return this.changes;
  }

  /** Adds a trace in the next color. */
  addTrace(name: string): NetworkTrace {
    const trace = new NetworkTrace(this, name, traceColors[this.traceList.length % traceColors.length] as Rgba8);
    this.traceList.push(trace);
    return trace;
  }

  /** Adds a marker. */
  addMarker(frequency: number): void {
    this.markerList = [...this.markerList, frequency];
    this.touch();
  }

  /** Moves a marker. */
  moveMarker(index: number, frequency: number): void {
    this.markerList = this.markerList.map((marker, i) => (i === index ? frequency : marker));
    this.touch();
  }

  /** Removes a marker. */
  removeMarker(index: number): void {
    this.markerList = this.markerList.filter((_, i) => i !== index);
    this.touch();
  }

  /** The level of a value in the format: degrees of the phase, otherwise dB of the magnitude. */
  toLevel(value: Complex): number {
    return this.format === 'phase'
      ? (Math.atan2(value.im, value.re) * 180) / Math.PI
      : 20 * Math.log10(Math.hypot(value.re, value.im));
  }

  /** @internal Asks for a new frame. */
  touch(): void {
    this.changes++;
  }
}

/** @internal Limit lines, markers with their table and the verdicts of a network analyzer. */
export class NetworkOverlay extends ChartOverlay {
  constructor(
    private readonly display: NetworkDisplay,
    private readonly chart: ChartSurface,
  ) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.display.version + chartText.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    this.applyPalette();
    const pane = canvas.layout.panes[0];
    const x = this.chart.horizontalAxes[0];
    const y = this.chart.panes[0]?.axes[0];
    if (!pane || !x || !y) {
      return;
    }
    const toPoint = (frequency: number, level: number): Point => ({
      x: f(pane.x + (pane.width * (frequency - x.visibleRange.min)) / (x.visibleRange.max - x.visibleRange.min)),
      y: f(pane.bottom - (pane.height * (level - y.visibleRange.min)) / (y.visibleRange.max - y.visibleRange.min)),
    });
    const display = this.display;
    if (display.areLimitsActive) {
      for (const trace of display.traces) {
        for (const limit of trace.limits) {
          canvas.drawLine(
            toPoint(limit.startFrequency, limit.startLevel),
            toPoint(limit.stopFrequency, limit.stopLevel),
            1.5,
            { ...trace.color, a: 170 },
          );
        }
      }
    }
    display.markers.forEach((marker, i) => {
      for (const trace of display.traces) {
        const value = trace.read(marker);
        if (value) {
          const point = toPoint(marker, display.toLevel(value));
          canvas.fillTriangle(
            point,
            { x: f(point.x - markerSize), y: f(point.y - markerSize * 2) },
            { x: f(point.x + markerSize), y: f(point.y - markerSize * 2) },
            trace.color,
          );
          canvas.drawText(
            String(i + 1),
            roundHalfEven(point.x - 3),
            roundHalfEven(point.y - markerSize * 2 - 2),
            labelSize,
            trace.color,
          );
        }
      }
    });
    this.drawTable(canvas, pane);
    this.drawResults(canvas, pane);
  }

  private applyPalette(): void {
    const palette = this.chart.theme?.palette;
    if (!palette || palette.length === 0) {
      return;
    }
    const lines = this.chart.series.filter((series) => series instanceof LineSeries);
    this.display.traces.forEach((trace, i) => {
      const color = parseColor(palette[(i * 2) % palette.length] as string);
      trace.color = color;
      const line = lines[i];
      if (line) {
        line.color = color;
      }
    });
  }

  private drawTable(canvas: OverlayCanvas, pane: DipRect): void {
    const display = this.display;
    const height = f(canvas.lineHeight(labelSize) + 4);
    const rows = display.markers.length * display.traces.length;
    if (rows === 0) {
      return;
    }
    const width = 250;
    const top = pane.bottom - rows * height - 10;
    const left = pane.right - width - 8;
    canvas.fillRectangle(new DipRect(left, top, width, rows * height + 6), { ...canvas.colors.background, a: 215 });
    let baseline = top + height;
    const unit = display.format === 'phase' ? '°' : ' dB';
    display.markers.forEach((marker, i) => {
      for (const trace of display.traces) {
        const read = trace.read(marker);
        const value = read ? formatFixed(display.toLevel(read), 2, invariantCulture) + unit : '---';
        const text = `${String(i + 1)}  ${trace.name}  ${formatWithPrefix(marker, 'Hz')}  ${value}`;
        canvas.drawText(text, roundHalfEven(left + 8), roundHalfEven(baseline), labelSize, trace.color);
        baseline += height;
      }
    });
  }

  private drawResults(canvas: OverlayCanvas, pane: DipRect): void {
    const display = this.display;
    const baseline = pane.y + canvas.lineHeight(labelSize) + 4;
    let x = pane.x + 10;
    for (const trace of display.traces) {
      const hasLimits = trace.limits.length > 0 && display.areLimitsActive;
      const passes = trace.passes;
      const verdict = chartText.text(passes ? 'pass' : 'fail');
      const text = trace.name + (hasLimits ? '  ' + verdict : '');
      const color = hasLimits && !passes ? failColor : trace.color;
      canvas.drawText(text, roundHalfEven(x), roundHalfEven(baseline), labelSize, color);
      x += canvas.measureWidth(text, labelSize) + 18;
    }
  }
}

/** Moves the markers of a network analyzer: drag one to move it, Ctrl+click adds or removes one. */
export class NetworkMarkerModifier extends ChartModifier {
  /** The priority, above zooming and panning. */
  static readonly defaultPriority = 22;
  private marker = -1;

  /** @param display - The display. */
  constructor(private readonly display: NetworkDisplay) {
    super(NetworkMarkerModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const chart = this.interaction?.chart;
    const pane = chart?.currentLayout?.panes[0];
    const axis = chart?.series[0]?.xAxis;
    if (!pane || !axis) {
      return 'ignored';
    }
    const range = axis.visibleRange;
    const perUnit = (range.max - range.min) / pane.width;
    const frequency = range.min + (input.position.x - pane.x) * perUnit;
    if (input.kind === 'pressed' && input.changedButton === 'primary') {
      return this.pressed(frequency, reach * perUnit, (input.modifiers & InputModifiers.control) !== 0);
    }
    if (this.marker < 0) {
      return 'ignored';
    }
    if (input.kind === 'moved') {
      this.display.moveMarker(this.marker, Math.min(Math.max(frequency, range.min), range.max));
      return 'handled';
    }
    if (input.kind === 'released') {
      this.marker = -1;
      return 'release';
    }
    return 'ignored';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.marker = -1;
  }

  private pressed(frequency: number, distance: number, isToggle: boolean): ModifierResult {
    let nearest = -1;
    let best = distance;
    this.display.markers.forEach((marker, i) => {
      if (Math.abs(marker - frequency) <= best) {
        best = Math.abs(marker - frequency);
        nearest = i;
      }
    });
    if (isToggle) {
      if (nearest >= 0) {
        this.display.removeMarker(nearest);
      } else {
        this.display.addMarker(frequency);
      }
      return 'handled';
    }
    if (nearest < 0) {
      return 'ignored';
    }
    this.marker = nearest;
    return 'capture';
  }
}

/**
 * Describes a network analyzer for a display: frequency from start to stop in hertz, level from minimum to maximum,
 * a line per trace, limits, markers and verdicts.
 */
export function networkAnalyzer(
  builder: ChartBuilder,
  display: NetworkDisplay,
  start: number,
  stop: number,
  minimum: number,
  maximum: number,
): ChartBuilder {
  builder
    .xAxis((a) => a.numeric('frequency').range(start, stop))
    .yAxis((a) =>
      a
        .numeric('level')
        .title(display.format === 'phase' ? '°' : 'dB')
        .range(minimum, maximum),
    );
  for (const trace of display.traces) {
    builder.addLine(trace.data, (line) => line.name(trace.name).stroke(trace.color).thickness(1.5));
  }
  return builder.addOverlay((chart) => {
    const axis: Axis | undefined = chart.series[0]?.xAxis;
    if (axis instanceof NumericAxis) {
      axis.labelFormat = { useSiPrefixes: true, unit: 'Hz', culture: invariantCulture };
    }
    return new NetworkOverlay(display, chart);
  });
}
