// A spectrum analyzer as a chart: the screen with graticule, mask, markers and readouts, the operation and the
// chart that follows the display, as SpectrumOverlay, SpectrumSync, SpectrumModifier and SpectrumChart of the .NET
// version.
import type { Axis } from '../axes/axis';
import { NumericAxis, type NumericLabelFormat } from '../axes/numeric-axis';
import type { ChartBuilder } from '../fluent/chart-builder';
import { ZoomPanModifier } from '../input/navigation-modifiers';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import { InputModifiers, type Point, type PointerInputEvent, type WheelInputEvent } from '../input/primitives';
import type { DipRect } from '../layout/chart-layout';
import { chartText, invariantCulture } from '../locale/culture';
import { formatFixed, formatWithPrefix, stepOneTwoFive } from '../locale/format';
import { roundHalfEven } from '../numerics/nice';
import { ChartOverlay, type OverlayCanvas } from '../overlays/chart-overlay';
import type { ChartSurface } from '../pipeline/chart-surface';
import type { Rgba8 } from '../render/types';
import { LineSeries } from '../series/line-series';
import { ScopeSync, withUnit } from './scope-chart';
import { scopeHorizontalDivisions, scopeVerticalDivisions } from './scope-display';
import { ScopePersistenceSeries } from './scope-persistence';
import type { FrequencyMask, SpectrumDisplay } from './spectrum-display';

const f = Math.fround;
const labelSize = 12;
const markerSize = 7;
const orange: Rgba8 = { r: 255, g: 160, b: 50, a: 255 };
const maskColor: Rgba8 = { r: 240, g: 80, b: 70, a: 255 };
const failColor: Rgba8 = { r: 255, g: 90, b: 80, a: 255 };
const edgeWidth = 60;
const clickDistance = 4;
const markerReach = 10;
const zoomPerStep = 1.25;
const maskReach = 6;

/** @internal The screen of a spectrum analyzer. */
export class SpectrumOverlay extends ChartOverlay {
  constructor(private readonly display: SpectrumDisplay) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.display.version + chartText.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const pane = canvas.layout.panes[0];
    if (!pane) {
      return;
    }
    const display = this.display;
    const line = { ...canvas.colors.text, a: 34 };
    for (let i = 0; i <= scopeHorizontalDivisions; i++) {
      const x = f(roundHalfEven(pane.x + (i * pane.width) / scopeHorizontalDivisions));
      canvas.drawLine({ x, y: f(pane.y) }, { x, y: f(pane.bottom) }, 1, line);
    }
    for (let i = 0; i <= scopeVerticalDivisions; i++) {
      const y = f(roundHalfEven(pane.y + (i * pane.height) / scopeVerticalDivisions));
      canvas.drawLine({ x: f(pane.x), y }, { x: f(pane.right), y }, 1, line);
    }
    const bottomLevel = display.referenceLevel - display.perDivision * scopeVerticalDivisions;
    const toPoint = (frequency: number, level: number): Point => ({
      x: f(pane.x + (pane.width * (frequency - display.start)) / (display.stop - display.start)),
      y: f(pane.bottom - (pane.height * (level - bottomLevel)) / (display.referenceLevel - bottomLevel)),
    });
    const mask = display.mask;
    if (mask) {
      const corners = mask.frequencies;
      for (let i = 1; i < corners.length; i++) {
        const from = Math.max(corners[i - 1] as number, display.start);
        const to = Math.min(corners[i] as number, display.stop);
        if (from < to) {
          canvas.drawLine(toPoint(from, mask.limit(from)), toPoint(to, mask.limit(to)), 1.5, maskColor);
        }
      }
    }
    const height = f(canvas.lineHeight(labelSize) + 5);
    const right = (text: string): number => roundHalfEven(pane.right - canvas.measureWidth(text, labelSize) - 10);
    const marker = display.markerPoint;
    const extras = display.extraMarkers;
    extras.forEach((extra, i) => {
      const { frequency, level } = display.readPoint(extra);
      if (Number.isFinite(frequency)) {
        const point = toPoint(frequency, level);
        const name = String(i + 2);
        drawMarker(canvas, point);
        canvas.drawText(name, roundHalfEven(point.x - 3), roundHalfEven(point.y - markerSize * 2), labelSize, orange);
        const row = `Mkr${name} ${formatWithPrefix(frequency, 'Hz')}   ${formatFixed(level, 1, invariantCulture)} dBm`;
        canvas.drawText(row, right(row), roundHalfEven(pane.y + height * (i + 2)), labelSize, canvas.colors.text);
      }
    });
    if (Number.isFinite(marker.frequency)) {
      drawMarker(canvas, toPoint(marker.frequency, marker.level));
      const text = `Mkr ${formatWithPrefix(marker.frequency, 'Hz')}   ${formatFixed(marker.level, 1, invariantCulture)} dBm`;
      canvas.drawText(text, right(text), roundHalfEven(pane.y + height), labelSize, canvas.colors.text);
    }
    const violation = display.lastViolation;
    if (violation) {
      const failed = `${chartText.text('maskFail')}  ${formatWithPrefix(violation.frequency, 'Hz')}`;
      canvas.drawText(
        failed,
        right(failed),
        roundHalfEven(pane.y + height * (extras.length + 2)),
        labelSize,
        failColor,
      );
    }
    const reference =
      `Ref ${formatFixed(display.referenceLevel, 0, invariantCulture)} dBm   ` +
      `${formatFixed(display.perDivision, 0, invariantCulture)} dB/div`;
    canvas.drawText(
      reference,
      roundHalfEven(pane.x + 10),
      roundHalfEven(pane.y + height),
      labelSize,
      canvas.colors.text,
    );
    const span = `Start ${formatWithPrefix(display.start, 'Hz')}   Stop ${formatWithPrefix(display.stop, 'Hz')}`;
    canvas.drawText(span, roundHalfEven(pane.x + 10), roundHalfEven(pane.bottom - 8), labelSize, canvas.colors.text);
  }
}

function drawMarker(canvas: OverlayCanvas, point: Point): void {
  canvas.fillTriangle(
    point,
    { x: f(point.x - markerSize), y: f(point.y - markerSize * 1.5) },
    { x: f(point.x + markerSize), y: f(point.y - markerSize * 1.5) },
    orange,
  );
}

const dbmFormat: NumericLabelFormat = { unit: 'dBm' };
const hertzFormat: NumericLabelFormat = { useSiPrefixes: true, unit: 'Hz' };

/** @internal Shows the max hold and the axes as the display wants them. Draws nothing. */
export class SpectrumSync extends ChartOverlay {
  constructor(
    private readonly chart: ChartSurface,
    private readonly display: SpectrumDisplay,
  ) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.display.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(): void {
    const lines = this.chart.series.filter((series) => series instanceof LineSeries);
    const hold = lines[1];
    if (lines.length === 2 && hold) {
      hold.isVisible = this.display.showsMaxHold;
    }
    this.showAxes();
  }

  // The frequency below and the level of the trace on the left, when the display wants them; the axes of the other
  // channels stay hidden. The vertical axes come in the order of the channels.
  private showAxes(): void {
    const shows = this.display.showsAxes;
    const frequency = this.chart.horizontalAxes[0];
    if (frequency instanceof NumericAxis && frequency.isHidden === shows) {
      frequency.isHidden = !shows;
      frequency.title = shows ? 'Frequency' : undefined;
      frequency.labelFormat = hertzFormat;
    }
    const channels = this.display.scope.channels;
    const axes = this.chart.panes[0]?.axes ?? [];
    for (let i = 0; i < channels.length && i < axes.length; i++) {
      const axis = axes[i] as Axis;
      showLevelAxis(axis, shows && channels[i] === this.display.trace);
      // The crosshair reads hidden axes too: frequency in hertz, level in dBm.
      withUnit(axis, dbmFormat);
    }
    withUnit(frequency, hertzFormat);
  }
}

function showLevelAxis(axis: Axis, visible: boolean): void {
  if (axis.isHidden !== visible) {
    return;
  }
  axis.isHidden = !visible;
  axis.title = visible ? 'Level in dBm' : undefined;
  if (visible && axis instanceof NumericAxis) {
    axis.labelFormat = {};
  }
}

/**
 * Operates a spectrum analyzer: a click sets the marker (with Ctrl adds or removes a further one), a double click
 * returns it to the peak, dragging moves the frequencies or, at the mask, the mask; the wheel zooms the frequencies,
 * at the left edge steps the dB per division, with Ctrl moves the reference level.
 */
export class SpectrumModifier extends ChartModifier {
  private isDragging = false;
  private hasMoved = false;
  private isAdding = false;
  private start: Point = { x: 0, y: 0 };
  private startFrequency = 0;
  private stopFrequency = 0;
  private movedMask: FrequencyMask | undefined;

  /** @param display - The display. */
  constructor(private readonly display: SpectrumDisplay) {
    super(ZoomPanModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const pane = this.interaction?.chart.currentLayout?.panes[0];
    if (!pane) {
      return 'ignored';
    }
    if (input.kind === 'pressed' && input.changedButton === 'primary') {
      return this.press(input, pane);
    }
    if (!this.isDragging) {
      return 'ignored';
    }
    if (input.kind === 'moved') {
      this.move(input, pane);
      return 'handled';
    }
    if (input.kind === 'released') {
      this.isDragging = false;
      if (!this.hasMoved) {
        this.placeMarker((input.position.x - pane.x) / pane.width, pane.width);
      }
      return 'release';
    }
    return 'ignored';
  }

  /** {@inheritDoc ChartModifier.onWheel} */
  override onWheel(input: WheelInputEvent): ModifierResult {
    const pane = this.interaction?.chart.currentLayout?.panes[0];
    if (!pane || input.delta.y === 0) {
      return 'ignored';
    }
    const display = this.display;
    const isLarger = input.delta.y < 0;
    if ((input.modifiers & InputModifiers.control) !== 0) {
      const level = display.referenceLevel + (isLarger ? -display.perDivision : display.perDivision);
      display.setView(display.start, display.stop, level, display.perDivision);
    } else if (input.position.x <= pane.x + edgeWidth) {
      const perDivision = stepOneTwoFive(display.perDivision, isLarger ? 1 : -1);
      display.setView(display.start, display.stop, display.referenceLevel, perDivision);
    } else {
      const share = (input.position.x - pane.x) / pane.width;
      const center = display.start + share * (display.stop - display.start);
      const span = (display.stop - display.start) * (isLarger ? zoomPerStep : 1 / zoomPerStep);
      display.setView(center - share * span, center + (1 - share) * span, display.referenceLevel, display.perDivision);
    }
    return 'handled';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.isDragging = false;
  }

  private press(input: PointerInputEvent, pane: DipRect): ModifierResult {
    if (input.clickCount === 2) {
      this.display.markerFrequency = undefined;
      return 'handled';
    }
    this.isDragging = true;
    this.hasMoved = false;
    this.movedMask = isOnMask(this.display, pane, input.position) ? this.display.mask : undefined;
    this.isAdding = (input.modifiers & InputModifiers.control) !== 0;
    this.start = input.position;
    this.startFrequency = this.display.start;
    this.stopFrequency = this.display.stop;
    return 'capture';
  }

  // Dragging the mask moves it up or down; dragging elsewhere moves the frequencies.
  private move(input: PointerInputEvent, pane: DipRect): void {
    const display = this.display;
    this.hasMoved ||= Math.hypot(input.position.x - this.start.x, input.position.y - this.start.y) > clickDistance;
    if (this.hasMoved && this.movedMask) {
      const span = display.perDivision * scopeVerticalDivisions;
      display.mask = this.movedMask.shift(((this.start.y - input.position.y) / pane.height) * span);
    } else if (this.hasMoved) {
      const shift = ((this.start.x - input.position.x) / pane.width) * (this.stopFrequency - this.startFrequency);
      display.setView(
        this.startFrequency + shift,
        this.stopFrequency + shift,
        display.referenceLevel,
        display.perDivision,
      );
    }
  }

  private placeMarker(share: number, width: number): void {
    const display = this.display;
    const span = display.stop - display.start;
    const frequency = display.start + share * span;
    if (!this.isAdding) {
      display.markerFrequency = frequency;
    } else if (!display.removeMarker(frequency, (markerReach * span) / width)) {
      display.addMarker(frequency);
    }
  }
}

/** Whether a position lies on the mask of the display, within six units. */
export function isOnMask(display: SpectrumDisplay, pane: DipRect, position: Point): boolean {
  const mask = display.mask;
  if (!mask || pane.width <= 0 || pane.height <= 0) {
    return false;
  }
  const frequency = display.start + ((position.x - pane.x) / pane.width) * (display.stop - display.start);
  const limit = mask.limit(frequency);
  const span = display.perDivision * scopeVerticalDivisions;
  const y = pane.y + ((display.referenceLevel - limit) / span) * pane.height;
  return Number.isFinite(y) && Math.abs(y - position.y) <= maskReach;
}

/**
 * Describes a spectrum analyzer for a display: hidden axes for frequency and level, the density of the traces, the
 * trace and the max hold, the screen and the operation.
 */
export function spectrum(builder: ChartBuilder, display: SpectrumDisplay): ChartBuilder {
  const scope = display.scope;
  const time = scope.timeRange();
  builder.xAxis((a) => a.numeric('frequency').range(time.min, time.max).hidden());
  for (const channel of scope.channels) {
    const range = channel.range();
    builder.yAxis((a) => a.numeric(channel.axisId).range(range.min, range.max).hidden());
  }
  builder.addSeries((x, y) => new ScopePersistenceSeries(scope, display.trace, x, y), undefined, display.trace.axisId);
  builder.addLine(display.trace.data, (line) =>
    line.name('Trace').yAxis(display.trace.axisId).stroke({ r: 245, g: 214, b: 60, a: 255 }).thickness(1.2),
  );
  builder.addLine(display.hold.data, (line) =>
    line.name('Max Hold').yAxis(display.hold.axisId).stroke({ r: 90, g: 170, b: 255, a: 255 }).thickness(1),
  );
  return builder
    .addOverlay((chart) => Object.assign(new ScopeSync(chart, scope), { keepsLines: true, paletteStep: 2 }))
    .addOverlay((chart) => new SpectrumSync(chart, display))
    .addOverlay(() => new SpectrumOverlay(display))
    .addModifier(() => new SpectrumModifier(display));
}
