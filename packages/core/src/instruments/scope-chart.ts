// An oscilloscope as a chart: the screen with graticule, readouts and markers, the operation with pointer and wheel,
// and the chart that follows the display, as ScopeOverlay, ScopeModifier, ScopeSync and ScopeChart of the .NET version.
import type { Axis } from '../axes/axis';
import { NumericAxis, type NumericLabelFormat } from '../axes/numeric-axis';
import type { ChartBuilder } from '../fluent/chart-builder';
import { ZoomPanModifier } from '../input/navigation-modifiers';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import { InputModifiers, type Point, type PointerInputEvent, type WheelInputEvent } from '../input/primitives';
import { DipRect } from '../layout/chart-layout';
import { chartText } from '../locale/culture';
import { formatWithPrefix, stepOneTwoFive } from '../locale/format';
import { roundHalfEven } from '../numerics/nice';
import { ChartOverlay, type OverlayCanvas } from '../overlays/chart-overlay';
import type { ChartSurface } from '../pipeline/chart-surface';
import { parseColor, type Rgba8 } from '../render/types';
import { LineSeries } from '../series/line-series';
import type { ThemeDocument } from '../themes/theme-document';
import {
  scopeHorizontalDivisions,
  scopeVerticalDivisions,
  type ScopeChannel,
  type ScopeDisplay,
} from './scope-display';
import { ScopePersistenceSeries } from './scope-persistence';

const f = Math.fround;
const labelSize = 12;
const markerSize = 7;
const subDivisions = 5;
const rowPadding = 5;
const edgeWidth = 60;
const grabReach = 14;
const orange: Rgba8 = { r: 255, g: 160, b: 50, a: 255 };

/** @internal The screen of an oscilloscope: graticule, readouts and the markers of channels and trigger. */
export class ScopeOverlay extends ChartOverlay {
  constructor(private readonly display: ScopeDisplay) {
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
    drawGraticule(canvas, pane);
    this.drawReadouts(canvas, pane);
    this.drawMarkers(canvas, pane);
  }

  private drawMarkers(canvas: OverlayCanvas, pane: DipRect): void {
    const stepY = pane.height / scopeVerticalDivisions;
    const left = f(pane.x);
    for (const channel of this.display.channels) {
      const y = f(roundHalfEven(pane.y + pane.height / 2 - channel.position * stepY));
      canvas.fillTriangle(
        { x: f(left + markerSize * 2), y },
        { x: left, y: f(y - markerSize) },
        { x: left, y: f(y + markerSize) },
        channel.color,
      );
      canvas.drawText(
        String(channel.number),
        roundHalfEven(pane.x + markerSize * 2 + 2),
        roundHalfEven(y + labelSize * 0.36),
        labelSize,
        channel.color,
      );
    }
    const time = this.display.timeRange();
    const triggerX = pane.x + (pane.width * (0 - time.min)) / (time.max - time.min);
    if (triggerX >= pane.x && triggerX <= pane.right) {
      const x = f(roundHalfEven(triggerX));
      const top = f(pane.y);
      canvas.fillTriangle(
        { x, y: f(top + markerSize * 1.5) },
        { x: f(x - markerSize), y: top },
        { x: f(x + markerSize), y: top },
        orange,
      );
    }
    const first = this.display.channels[0];
    if (first) {
      const range = first.range();
      const share = (this.display.triggerLevel - range.min) / (range.max - range.min);
      if (share >= 0 && share <= 1) {
        const y = f(roundHalfEven(pane.bottom - share * pane.height));
        const right = f(pane.right);
        canvas.fillTriangle(
          { x: f(right - markerSize * 1.5), y },
          { x: right, y: f(y - markerSize) },
          { x: right, y: f(y + markerSize) },
          orange,
        );
      }
    }
  }

  private drawReadouts(canvas: OverlayCanvas, pane: DipRect): void {
    const height = f(canvas.lineHeight(labelSize) + rowPadding);
    const status = this.display.triggerStatus;
    const timeText =
      (status === undefined ? '' : chartText.text(status) + '   ') +
      formatWithPrefix(this.display.timePerDivision, 's') +
      '/div   T ' +
      formatWithPrefix(this.display.triggerLevel, 'V');
    const timeLeft = pane.right - canvas.measureWidth(timeText, labelSize) - 28;
    canvas.drawText(
      timeText,
      roundHalfEven(timeLeft),
      roundHalfEven(pane.y + height - rowPadding),
      labelSize,
      canvas.colors.text,
    );
    // The scales of the channels run from the left; one that would reach the time goes to the next line.
    let x = pane.x + 36;
    let row = 0;
    for (const channel of this.display.channels) {
      const text = `${String(channel.number)}: ${formatWithPrefix(channel.voltsPerDivision, 'V')}/div`;
      const width = canvas.measureWidth(text, labelSize);
      if (x + width > timeLeft - 18 && x > pane.x + 36) {
        x = pane.x + 36;
        row++;
      }
      canvas.drawText(
        text,
        roundHalfEven(x),
        roundHalfEven(pane.y + height * (row + 1) - rowPadding),
        labelSize,
        channel.color,
      );
      const readout = channel.readout;
      readout.left = x;
      readout.right = x + width;
      readout.top = pane.y + height * row;
      readout.bottom = pane.y + height * (row + 1);
      x += width + 18;
    }
    const rows = this.display.channels.length;
    const top = pane.bottom - rows * height - rowPadding;
    canvas.fillRectangle(new DipRect(pane.x, top, pane.width, pane.bottom - top), {
      ...canvas.colors.background,
      a: 200,
    });
    let baseline = top + height;
    for (const channel of this.display.channels) {
      const values = channel.measurements;
      const text =
        `${String(channel.number)}:  Vpp ${formatWithPrefix(values.maximum - values.minimum, 'V')}` +
        `    Vrms ${formatWithPrefix(values.rms, 'V')}` +
        `    ${chartText.text('mean')} ${formatWithPrefix(values.mean, 'V')}` +
        `    Freq ${formatWithPrefix(values.frequency, 'Hz')}`;
      canvas.drawText(text, roundHalfEven(pane.x + 8), roundHalfEven(baseline - rowPadding), labelSize, channel.color);
      baseline += height;
    }
  }
}

function drawGraticule(canvas: OverlayCanvas, pane: DipRect): void {
  const line = { ...canvas.colors.text, a: 34 };
  const mark = { ...canvas.colors.text, a: 110 };
  const stepX = pane.width / scopeHorizontalDivisions;
  const stepY = pane.height / scopeVerticalDivisions;
  const top = f(pane.y);
  const bottom = f(pane.bottom);
  const left = f(pane.x);
  const right = f(pane.right);
  for (let i = 0; i <= scopeHorizontalDivisions; i++) {
    const x = f(roundHalfEven(pane.x + i * stepX));
    canvas.drawLine({ x, y: top }, { x, y: bottom }, 1, line);
  }
  for (let i = 0; i <= scopeVerticalDivisions; i++) {
    const y = f(roundHalfEven(pane.y + i * stepY));
    canvas.drawLine({ x: left, y }, { x: right, y }, 1, line);
  }
  // The ticks on the center lines, which make reading between the divisions possible.
  const centerX = f(roundHalfEven(pane.x + pane.width / 2));
  const centerY = f(roundHalfEven(pane.y + pane.height / 2));
  for (let i = 0; i <= scopeHorizontalDivisions * subDivisions; i++) {
    const x = f(roundHalfEven(pane.x + (i * stepX) / subDivisions));
    const length = i % subDivisions === 0 ? 5 : 3;
    canvas.drawLine({ x, y: f(centerY - length) }, { x, y: f(centerY + length) }, 1, mark);
  }
  for (let i = 0; i <= scopeVerticalDivisions * subDivisions; i++) {
    const y = f(roundHalfEven(pane.y + (i * stepY) / subDivisions));
    const length = i % subDivisions === 0 ? 5 : 3;
    canvas.drawLine({ x: f(centerX - length), y }, { x: f(centerX + length), y }, 1, mark);
  }
}

/**
 * Operates an oscilloscope: dragging a channel marker at the left moves the channel, dragging at the right edge moves
 * the trigger level, dragging elsewhere moves the time; the wheel changes the time base, over a channel readout, at
 * the left edge or with Ctrl the volts per division of the nearest channel.
 */
export class ScopeModifier extends ChartModifier {
  private channel: ScopeChannel | undefined;
  private isTrigger = false;
  private isTime = false;
  private pointerId = 0;
  private start: Point = { x: 0, y: 0 };
  private startValue = 0;

  /** @param display - The display. */
  constructor(private readonly display: ScopeDisplay) {
    super(ZoomPanModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const pane = this.interaction?.chart.currentLayout?.panes[0];
    if (!pane) {
      return 'ignored';
    }
    if (input.kind === 'pressed' && input.changedButton === 'primary') {
      return this.begin(input, pane);
    }
    if (input.pointerId !== this.pointerId || (!this.channel && !this.isTrigger && !this.isTime)) {
      return 'ignored';
    }
    if (input.kind === 'moved') {
      this.continue(input, pane);
      return 'handled';
    }
    if (input.kind === 'released') {
      this.onCaptureLost();
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
    const steps = input.delta.y > 0 ? -1 : 1;
    const channel = this.channelForScale(input, pane);
    if (channel) {
      channel.voltsPerDivision = stepOneTwoFive(channel.voltsPerDivision, steps);
    } else {
      this.display.timePerDivision = stepOneTwoFive(this.display.timePerDivision, steps);
    }
    return 'handled';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.channel = undefined;
    this.isTrigger = false;
    this.isTime = false;
  }

  private channelForScale(input: WheelInputEvent, pane: DipRect): ScopeChannel | undefined {
    const { x, y } = input.position;
    const hit = this.display.channels.find(
      (channel) =>
        x >= channel.readout.left &&
        x <= channel.readout.right &&
        y >= channel.readout.top &&
        y <= channel.readout.bottom,
    );
    if (hit) {
      return hit;
    }
    const isOverScale = (input.modifiers & InputModifiers.control) !== 0 || x <= pane.x + edgeWidth;
    return isOverScale ? this.nearestChannel(y, pane, Number.POSITIVE_INFINITY) : undefined;
  }

  private begin(input: PointerInputEvent, pane: DipRect): ModifierResult {
    this.pointerId = input.pointerId;
    this.start = input.position;
    const channel =
      input.position.x <= pane.x + edgeWidth ? this.nearestChannel(input.position.y, pane, grabReach) : undefined;
    if (channel) {
      this.channel = channel;
      this.startValue = channel.position;
    } else if (input.position.x >= pane.right - edgeWidth && this.display.channels.length > 0) {
      this.isTrigger = true;
      this.startValue = this.display.triggerLevel;
    } else {
      this.isTime = true;
      this.startValue = this.display.timeOffset;
    }
    return 'capture';
  }

  private continue(input: PointerInputEvent, pane: DipRect): void {
    const divisions = (this.start.y - input.position.y) / (pane.height / scopeVerticalDivisions);
    const first = this.display.channels[0];
    if (this.channel) {
      this.channel.position = this.startValue + divisions;
    } else if (this.isTrigger && first) {
      this.display.triggerLevel = this.startValue + divisions * first.voltsPerDivision;
    } else {
      const seconds =
        ((this.start.x - input.position.x) / (pane.width / scopeHorizontalDivisions)) * this.display.timePerDivision;
      this.display.timeOffset = this.startValue + seconds;
    }
  }

  private nearestChannel(y: number, pane: DipRect, reach: number): ScopeChannel | undefined {
    const stepY = pane.height / scopeVerticalDivisions;
    let best: ScopeChannel | undefined;
    let distance = reach;
    for (const channel of this.display.channels) {
      const current = Math.abs(pane.y + pane.height / 2 - channel.position * stepY - y);
      if (current <= distance) {
        distance = current;
        best = channel;
      }
    }
    return best;
  }
}

const secondsFormat: NumericLabelFormat = { useSiPrefixes: true, unit: 's' };
const voltsFormat: NumericLabelFormat = { useSiPrefixes: true, unit: 'V' };

/** @internal Gives a hidden axis the unit the crosshair reads. */
export function withUnit(axis: Axis | undefined, format: NumericLabelFormat): void {
  if (axis instanceof NumericAxis && axis.isHidden && axis.labelFormat !== format) {
    axis.labelFormat = format;
  }
}

/**
 * @internal Lets the chart follow the display: the axes follow its scales, the channels take the colors of the theme,
 * the lines hide behind the color grade. Draws nothing.
 */
export class ScopeSync extends ChartOverlay {
  /** Whether the lines stay visible with the color grade. */
  keepsLines = false;
  /** The step through the palette from one channel to the next. */
  paletteStep = 1;
  private applied = -1;
  private appliedTheme: ThemeDocument | undefined;

  constructor(
    private readonly chart: ChartSurface,
    private readonly display: ScopeDisplay,
  ) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.display.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(): void {
    const chart = this.chart;
    if (this.display.version === this.applied && chart.theme === this.appliedTheme) {
      return;
    }
    this.applied = this.display.version;
    this.applyPalette();
    const time = chart.horizontalAxes[0];
    if (time) {
      time.visibleRange = this.display.timeRange();
    }
    if (!this.keepsLines) {
      for (const series of chart.series) {
        if (series instanceof LineSeries) {
          series.isVisible = this.display.persistence !== 'colorGrade';
        }
      }
    }
    const axes = chart.panes[0]?.axes ?? [];
    const channels = this.display.channels;
    for (let i = 0; i < channels.length && i < axes.length; i++) {
      (axes[i] as Axis).visibleRange = (channels[i] as ScopeChannel).range();
    }
    // The hidden axes show no scale, but the crosshair reads its values from them: in seconds and volts.
    withUnit(time, secondsFormat);
    for (let i = 0; i < channels.length && i < axes.length; i++) {
      withUnit(axes[i], voltsFormat);
    }
  }

  private applyPalette(): void {
    this.appliedTheme = this.chart.theme;
    const palette = this.appliedTheme?.palette;
    if (!palette || palette.length === 0) {
      return;
    }
    const lines = this.chart.series.filter((series) => series instanceof LineSeries);
    this.display.channels.forEach((channel, i) => {
      const color = parseColor(palette[(i * this.paletteStep) % palette.length] as string);
      channel.color = color;
      const line = lines[i];
      if (line) {
        line.color = color;
      }
    });
  }
}

/**
 * Describes an oscilloscope for a display: hidden axes for the time and each channel, a persistence and a line per
 * channel, the screen and the operation.
 */
export function oscilloscope(builder: ChartBuilder, display: ScopeDisplay): ChartBuilder {
  const time = display.timeRange();
  builder.xAxis((a) => a.numeric('time').range(time.min, time.max).hidden());
  for (const channel of display.channels) {
    const range = channel.range();
    builder.yAxis((a) => a.numeric(channel.axisId).range(range.min, range.max).hidden());
  }
  for (const channel of display.channels) {
    builder.addSeries((x, y) => new ScopePersistenceSeries(display, channel, x, y), undefined, channel.axisId);
  }
  for (const channel of display.channels) {
    builder.addLine(channel.data, (line) =>
      line
        .name(`CH${String(channel.number)}`)
        .yAxis(channel.axisId)
        .stroke(channel.color)
        .thickness(1.5),
    );
  }
  return builder
    .addOverlay((chart) => new ScopeSync(chart, display))
    .addOverlay(() => new ScopeOverlay(display))
    .addModifier(() => new ScopeModifier(display));
}
