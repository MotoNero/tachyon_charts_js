// The grid of a Smith chart, the marker of one point, its modifier and the chart itself, as SmithGridOverlay,
// SmithMarkerOverlay, SmithMarkerModifier and SmithChart of the .NET version.
import { NumericAxis } from '../axes/numeric-axis';
import { ZoomPanModifier } from '../input/navigation-modifiers';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import type { Point, PointerInputEvent } from '../input/primitives';
import { invariantCulture } from '../locale/culture';
import { formatFixed, formatGeneral } from '../locale/format';
import { DoubleRange } from '../numerics/range';
import { ChartSurface } from '../pipeline/chart-surface';
import type { Rgba8 } from '../render/types';
import {
  defaultReferenceImpedance,
  SmithProjection,
  SmithSeries,
  toReflection,
  toStandingWaveRatio,
  type Complex,
} from '../series/smith-series';
import type { TextEngine } from '../text/engine';
import { ChartOverlay, type OverlayCanvas } from './chart-overlay';

const f = Math.fround;
const segments = 96;
const gridLabelSize = 11;
const limit = 1.56;
const values = [0.2, 0.5, 1, 2, 5];
const markerLabelSize = 12;
const markerSize = 9;
const markerColor: Rgba8 = { r: 255, g: 160, b: 50, a: 255 };

/** The circles of constant resistance and the arcs of constant reactance of a Smith chart, with their values. */
export class SmithGridOverlay extends ChartOverlay {
  private ohms = false;

  /** @param referenceImpedance - The reference impedance in ohms, for labels in ohms. */
  constructor(private readonly referenceImpedance = defaultReferenceImpedance) {
    super();
  }

  /** Whether the labels show ohms instead of normalized values. */
  get showsOhms(): boolean {
    return this.ohms;
  }

  set showsOhms(value: boolean) {
    this.ohms = value;
    this.changed();
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const pane = canvas.layout.panes[0];
    if (!pane) {
      return;
    }
    const projection = SmithProjection.fit(pane.x, pane.y, pane.width, pane.height);
    const line = { ...canvas.colors.text, a: 70 };
    drawCurve(canvas, projection, 0, line);
    canvas.drawLine(projection.toPoint({ re: -1, im: 0 }), projection.toPoint({ re: 1, im: 0 }), 1, line);
    for (const value of values) {
      drawCurve(canvas, projection, value, line);
      drawArc(canvas, projection, value, line);
      drawArc(canvas, projection, -value, line);
      this.drawLabels(canvas, projection, value);
    }
  }

  private drawLabels(canvas: OverlayCanvas, projection: SmithProjection, value: number): void {
    const text = formatGeneral(this.ohms ? value * this.referenceImpedance : value, 3, invariantCulture);
    const color = canvas.colors.text;
    const onAxis = projection.toPoint(toReflection({ re: value, im: 0 }));
    canvas.drawText(text, f(onAxis.x + 3), f(onAxis.y - 3), gridLabelSize, color);
    const tip = projection.toPoint(toReflection({ re: 0, im: value }));
    const cx = f(projection.centerX);
    const cy = f(projection.centerY);
    const scale = f(1.07);
    const outX = f(cx + f(f(tip.x - cx) * scale));
    const outY = f(cy + f(f(tip.y - cy) * scale));
    canvas.drawText('+j' + text, f(outX - 12), f(outY + 4), gridLabelSize, color);
    const mirroredY = f(cy + f(f(cy - tip.y) * scale));
    canvas.drawText('-j' + text, f(outX - 12), f(mirroredY + 4), gridLabelSize, color);
  }
}

// The circle of a constant resistance, through all reactances.
function drawCurve(canvas: OverlayCanvas, projection: SmithProjection, resistance: number, color: Rgba8): void {
  let previous = projection.toPoint(toReflection({ re: resistance, im: Math.tan(-limit) }));
  for (let i = 1; i <= segments; i++) {
    const point = projection.toPoint(
      toReflection({ re: resistance, im: Math.tan(-limit + (2 * limit * i) / segments) }),
    );
    canvas.drawLine(previous, point, 1, color);
    previous = point;
  }
}

// The arc of a constant reactance, through all resistances.
function drawArc(canvas: OverlayCanvas, projection: SmithProjection, reactance: number, color: Rgba8): void {
  let previous = projection.toPoint(toReflection({ re: 0, im: reactance }));
  for (let i = 1; i <= segments; i++) {
    const point = projection.toPoint(toReflection({ re: Math.tan((limit * i) / segments), im: reactance }));
    canvas.drawLine(previous, point, 1, color);
    previous = point;
  }
}

/** Puts a point into words: its impedance, reflection coefficient and standing wave ratio. */
export function describeSmithPoint(impedance: Complex, reflection: Complex): string[] {
  const sign = impedance.im < 0 ? '-' : '+';
  const ratio = toStandingWaveRatio(reflection);
  const fixed = (value: number, decimals: number): string => formatFixed(value, decimals, invariantCulture);
  const phase = (Math.atan2(reflection.im, reflection.re) * 180) / Math.PI;
  return [
    `Z = ${fixed(impedance.re, 2)} ${sign} j${fixed(Math.abs(impedance.im), 2)} Ω`,
    `Γ = ${fixed(Math.hypot(reflection.re, reflection.im), 3)} at ${fixed(phase, 1)}°`,
    `VSWR = ${Number.isFinite(ratio) ? fixed(ratio, 2) : '∞'}`,
  ];
}

/** Marks a point of a curve and shows its impedance, reflection and standing wave ratio. */
export class SmithMarkerOverlay extends ChartOverlay {
  /**
   * @param series - The curve.
   * @param marked - The point.
   */
  constructor(
    private readonly series: SmithSeries,
    private marked: number,
  ) {
    super();
  }

  /** The point. */
  get index(): number {
    return this.marked;
  }

  set index(value: number) {
    this.marked = value;
    this.changed();
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const pane = canvas.layout.panes[0];
    if (!pane || this.marked < 0 || this.marked >= this.series.count) {
      return;
    }
    const projection = SmithProjection.fit(pane.x, pane.y, pane.width, pane.height);
    const reflection = this.series.reflection(this.marked);
    const point = projection.toPoint(reflection);
    const left = { x: f(point.x - markerSize), y: point.y };
    const right = { x: f(point.x + markerSize), y: point.y };
    canvas.fillTriangle(left, { x: point.x, y: f(point.y - markerSize) }, right, markerColor);
    canvas.fillTriangle(left, { x: point.x, y: f(point.y + markerSize) }, right, markerColor);
    const height = canvas.lineHeight(markerLabelSize);
    let baseline = pane.y + height;
    for (const line of describeSmithPoint(this.series.impedance(this.marked), reflection)) {
      canvas.drawText(line, pane.x + 6, baseline, markerLabelSize, canvas.colors.text);
      baseline += height;
    }
  }
}

/** Moves the marker of a Smith chart to the point next to the pointer while the primary button is held. */
export class SmithMarkerModifier extends ChartModifier {
  private isDragging = false;

  constructor() {
    super(ZoomPanModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    if (input.kind === 'pressed' && input.changedButton === 'primary') {
      this.isDragging = true;
      this.move(input.position);
      return 'capture';
    }
    if (!this.isDragging) {
      return 'ignored';
    }
    if (input.kind === 'moved') {
      this.move(input.position);
      return 'handled';
    }
    if (input.kind === 'released') {
      this.isDragging = false;
      return 'release';
    }
    return 'ignored';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.isDragging = false;
  }

  private move(position: Point): void {
    const chart = this.interaction?.chart;
    const pane = chart?.currentLayout?.panes[0];
    const series = chart?.series.find((s) => s instanceof SmithSeries);
    const marker = chart?.overlays.find((o) => o instanceof SmithMarkerOverlay);
    if (!pane || !series || !marker) {
      return;
    }
    const projection = SmithProjection.fit(pane.x, pane.y, pane.width, pane.height);
    let best = -1;
    let distance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < series.count; i++) {
      const point = projection.toPoint(series.reflection(i));
      const current = (point.x - position.x) ** 2 + (point.y - position.y) ** 2;
      if (current < distance) {
        distance = current;
        best = i;
      }
    }
    if (best >= 0) {
      marker.index = best;
    }
  }
}

/** A Smith chart: hidden axes from -1 to 1 and its grid. */
export interface SmithChart {
  /** The chart. */
  readonly chart: ChartSurface;
  /** The hidden X axis. */
  readonly x: NumericAxis;
  /** The hidden Y axis. */
  readonly y: NumericAxis;
  /** The grid. */
  readonly grid: SmithGridOverlay;
}

/** Creates a Smith chart whose cartesian axes are hidden. */
export function createSmithChart(textEngine: TextEngine, referenceImpedance = defaultReferenceImpedance): SmithChart {
  const x = new NumericAxis('x', 'bottom');
  x.visibleRange = new DoubleRange(-1, 1);
  x.isHidden = true;
  const y = new NumericAxis('y', 'left');
  y.visibleRange = new DoubleRange(-1, 1);
  y.isHidden = true;
  const chart = new ChartSurface([x], [{ axes: [y] }], textEngine);
  const grid = new SmithGridOverlay(referenceImpedance);
  chart.addOverlay(grid);
  return { chart, x, y, grid };
}
