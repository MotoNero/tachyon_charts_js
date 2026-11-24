// Pie and donut charts, as PieSeries, PieLabelOverlay, PieModifier and PieCharts of the .NET version: slices from the
// top clockwise with a gap and soft edges, labels inside or outside on lines, a slice pulled out on a click and the
// value under the pointer.
import type { Axis } from '../axes/axis';
import type { FoundPoint } from '../hit-testing/types';
import type { ChartBuilder } from '../fluent/chart-builder';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import { ZoomPanModifier } from '../input/navigation-modifiers';
import type { PointerInputEvent } from '../input/primitives';
import type { DipRect } from '../layout/chart-layout';
import { chartText } from '../locale/culture';
import { formatFixed, formatGeneral } from '../locale/format';
import { roundHalfEven } from '../numerics/nice';
import { DoubleRange } from '../numerics/range';
import { ChartOverlay, type OverlayCanvas } from '../overlays/chart-overlay';
import { ChartSeries, type SeriesFrame } from '../pipeline/chart-series';
import type { CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import { packRgba8, type Rgba8 } from '../render/types';
import { addFringe, Mesh, type Corner } from './ribbon-series';

const f = Math.fround;
const stepsPerTurn = 180;
const radiusWithLabels = f(0.62);
const radiusWithoutLabels = f(0.92);
const hoverLift = 0.03;
const fringeWidth = 1;
const turn = 2 * Math.PI;
const defaultPalette: readonly Rgba8[] = [
  { r: 76, g: 201, b: 240, a: 255 },
  { r: 247, g: 37, b: 133, a: 255 },
  { r: 255, g: 190, b: 11, a: 255 },
  { r: 114, g: 9, b: 183, a: 255 },
  { r: 58, g: 134, b: 255, a: 255 },
  { r: 6, g: 214, b: 160, a: 255 },
  { r: 251, g: 86, b: 7, a: 255 },
  { r: 131, g: 56, b: 236, a: 255 },
];

/** What the slices of a pie say. */
export type PieLabels = 'none' | 'name' | 'percent' | 'value' | 'nameAndPercent';

/** The slices of a pie: values, names and angles in radians from the top clockwise. */
export interface PieSlices {
  /** The values. */
  readonly values: readonly number[];
  /** The names, empty where none is given. */
  readonly names: readonly string[];
  /** The sum of the positive finite values. */
  readonly total: number;
  /** The angle where each slice starts. */
  readonly start: readonly number[];
  /** The angle each slice spans, 0 for values that are left out. */
  readonly sweep: readonly number[];
}

const counts = (value: number): boolean => Number.isFinite(value) && value > 0;

function createSlices(values: readonly number[], names: readonly string[] | undefined): PieSlices {
  if (names && names.length !== values.length) {
    throw new RangeError('Every value needs a name.');
  }
  const copy = [...values];
  let total = 0;
  for (const value of copy) {
    total += counts(value) ? value : 0;
  }
  const start: number[] = [];
  const sweep: number[] = [];
  let angle = 0;
  for (const value of copy) {
    start.push(angle);
    const part = total > 0 && counts(value) ? (value / total) * 2 * Math.PI : 0;
    sweep.push(part);
    angle += part;
  }
  return {
    values: copy,
    names: names ? [...names] : copy.map(() => ''),
    total: Number.isFinite(total) ? total : 0,
    start,
    sweep,
  };
}

/** @internal The direction of an angle from the top clockwise. */
export function pieDirection(angle: number): { x: number; y: number } {
  return { x: f(Math.sin(angle)), y: f(-Math.cos(angle)) };
}

/** A pie or, with an inner radius, a donut: one slice per value, from the top clockwise. */
export class PieSeries extends ChartSeries {
  private readonly mesh = new Mesh();
  private slices: PieSlices;
  private palette: readonly Rgba8[] = defaultPalette;
  private ownColors: readonly Rgba8[] | undefined;
  private inner = 0;
  private explode = 0.1;
  private gapWidth = 1.5;
  private exploded = -1;
  private highlighted = -1;
  private labelKind: PieLabels = 'nameAndPercent';
  private changes = 0;
  private builtVersion = -1;
  private builtFrame: SeriesFrame | undefined;

  /**
   * @param values - The values; slices of values that are not positive and finite stay out.
   * @param names - The names, one per value.
   * @param xAxis - The hidden X axis.
   * @param yAxis - The hidden Y axis.
   * @throws RangeError when the names do not match the values.
   */
  constructor(values: readonly number[], names: readonly string[] | undefined, xAxis: Axis, yAxis: Axis) {
    super(xAxis, yAxis);
    this.slices = createSlices(values, names);
  }

  /** The number of values. */
  get count(): number {
    return this.slices.values.length;
  }

  /** The inner radius as a share of the outer one, 0 for a pie; at most 0.95. */
  get innerRadius(): number {
    return this.inner;
  }

  set innerRadius(value: number) {
    if (!(value >= 0 && value <= 0.95)) {
      throw new RangeError('The inner radius must lie between 0 and 0.95.');
    }
    this.inner = value;
    this.changes++;
  }

  /** The slice pulled out, -1 for none. */
  get explodedIndex(): number {
    return this.exploded;
  }

  set explodedIndex(value: number) {
    this.exploded = value;
    this.changes++;
  }

  /** How far the pulled slice moves out, as a share of the radius; 0.1 by default, at most 0.5. */
  get explodeDistance(): number {
    return this.explode;
  }

  set explodeDistance(value: number) {
    if (!(value >= 0 && value <= 0.5)) {
      throw new RangeError('The distance must lie between 0 and 0.5.');
    }
    this.explode = value;
    this.changes++;
  }

  /** The slice under the pointer, lifted a little and lighter; -1 for none. */
  get highlightedIndex(): number {
    return this.highlighted;
  }

  set highlightedIndex(value: number) {
    if (value !== this.highlighted) {
      this.highlighted = value;
      this.changes++;
    }
  }

  /** The gap between slices in device-independent units; 1.5 by default. */
  get gap(): number {
    return this.gapWidth;
  }

  set gap(value: number) {
    this.gapWidth = Math.max(0, value);
    this.changes++;
  }

  /** What the slices say; name and percent by default. */
  get labels(): PieLabels {
    return this.labelKind;
  }

  set labels(value: PieLabels) {
    this.labelKind = value;
    this.changes++;
  }

  /** The colors of the slices in turn; those of the theme when left out. */
  get colors(): readonly Rgba8[] | undefined {
    return this.ownColors;
  }

  set colors(value: readonly Rgba8[] | undefined) {
    this.ownColors = value?.length === 0 ? undefined : value;
    this.changes++;
  }

  /** {@inheritDoc ChartSeries.accentColor} */
  override get accentColor(): Rgba8 {
    return this.colorOf(0);
  }

  /** {@inheritDoc ChartSeries.version} */
  get version(): number {
    return this.changes;
  }

  /** The slices of the coming frame. */
  get current(): PieSlices {
    return this.slices;
  }

  /** Shows new values, with new names or the old ones when their number fits. */
  setValues(values: readonly number[], names?: readonly string[]): void {
    const kept = this.slices.names.length === values.length ? this.slices.names : undefined;
    this.slices = createSlices(values, names ?? kept);
    this.changes++;
  }

  /** The value of a slice. */
  sliceValue(index: number): number {
    return this.slices.values[index] ?? Number.NaN;
  }

  /** The name of a slice. */
  sliceName(index: number): string {
    return this.slices.names[index] ?? '';
  }

  /** The share of a slice in the whole, 0 to 1. */
  sliceShare(index: number): number {
    return this.slices.total > 0 ? (this.slices.sweep[index] ?? 0) / turn : 0;
  }

  /** {@inheritDoc ChartSeries.onPalette} */
  override onPalette(palette: readonly Rgba8[]): void {
    this.palette = [...palette];
    this.changes++;
  }

  /** {@inheritDoc ChartSeries.dataRange} */
  override dataRange(): DoubleRange | undefined {
    return new DoubleRange(0, 1);
  }

  /** {@inheritDoc ChartSeries.findPoint} */
  override findPoint(frame: SeriesFrame, pixelX: number, pixelY: number): FoundPoint | undefined {
    const bounds = frame.bounds;
    const found = this.findSlice(pixelX, pixelY, bounds.x, bounds.y, bounds.width, bounds.height);
    return found < 0 ? undefined : { index: found, x: found, y: this.sliceValue(found) };
  }

  /** @internal The middle and the radius in an area. */
  fit(x: number, y: number, width: number, height: number): { x: number; y: number; radius: number } {
    const share = this.labelKind === 'none' ? radiusWithoutLabels : radiusWithLabels;
    return { x: f(x + width / 2), y: f(y + height / 2), radius: f((Math.min(width, height) / 2) * share) };
  }

  /** @internal The color of a slice. */
  colorOf(index: number): Rgba8 {
    const colors = this.ownColors ?? this.palette;
    return colors[index % colors.length] as Rgba8;
  }

  /** @internal How far a slice moves out along its middle, as a share of the radius. */
  liftOf(index: number): number {
    if (index === this.exploded) {
      return this.explode;
    }
    return index === this.highlighted ? hoverLift : 0;
  }

  /** @internal The slice at a position in an area, -1 for none. */
  findSlice(px: number, py: number, x: number, y: number, width: number, height: number): number {
    const slices = this.slices;
    if (slices.total <= 0) {
      return -1;
    }
    const center = this.fit(x, y, width, height);
    for (let i = 0; i < slices.values.length; i++) {
      const sweep = slices.sweep[i] as number;
      if (sweep <= 0) {
        continue;
      }
      const start = slices.start[i] as number;
      const direction = pieDirection(start + sweep / 2);
      const lift = f(this.liftOf(i) * center.radius);
      const offsetX = f(f(px - f(direction.x * lift)) - center.x);
      const offsetY = f(f(py - f(direction.y * lift)) - center.y);
      const distance = Math.hypot(offsetX, offsetY);
      if (distance > center.radius || distance < center.radius * this.inner) {
        continue;
      }
      let angle = Math.atan2(offsetX, -offsetY);
      angle = angle < 0 ? angle + turn : angle;
      if (angle >= start && angle < start + sweep) {
        return i;
      }
    }
    return -1;
  }

  /** {@inheritDoc ChartSeries.prepare} */
  override prepare(_device: RenderDevice, frame: SeriesFrame): void {
    if (this.builtVersion === this.changes && this.builtFrame === frame) {
      return;
    }
    this.build(frame);
    this.builtVersion = this.changes;
    this.builtFrame = frame;
  }

  /** {@inheritDoc ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.mesh.count > 0) {
      commands.fillMesh(this.mesh.data, this.mesh.count, frame.bounds);
    }
  }

  private build(frame: SeriesFrame): void {
    this.mesh.clear();
    const slices = this.slices;
    if (slices.total <= 0) {
      return;
    }
    const bounds = frame.bounds;
    const center = this.fit(bounds.x, bounds.y, bounds.width, bounds.height);
    const radius = center.radius;
    const inner = f(radius * this.inner);
    const drawn = slices.sweep.filter((sweep) => sweep > 0).length;
    // A single slice is a closed circle; otherwise a gap on both sides keeps the slices apart. The soft band along
    // each cut reaches into the gap, so the gap grows by the band on both sides.
    const gap = drawn > 1 ? (this.gapWidth * frame.dpiScale + 2 * fringeWidth) / radius : 0;
    for (let i = 0; i < slices.values.length; i++) {
      const sweep = slices.sweep[i] as number;
      if (sweep <= 0) {
        continue;
      }
      const shrink = Math.min(gap, sweep * 0.5);
      const start = (slices.start[i] as number) + shrink / 2;
      const end = (slices.start[i] as number) + sweep - shrink / 2;
      const direction = pieDirection((start + end) / 2);
      const lift = f(this.liftOf(i) * radius);
      const origin = { x: f(center.x + f(direction.x * lift)), y: f(center.y + f(direction.y * lift)) };
      const color = i === this.highlighted ? lighten(this.colorOf(i)) : this.colorOf(i);
      this.addSlice(origin, radius, inner, start, end, color);
    }
  }

  // The arcs and the cuts get a soft band of one pixel, so that they show no steps.
  private addSlice(
    origin: { x: number; y: number },
    radius: number,
    inner: number,
    start: number,
    end: number,
    color: Rgba8,
  ): void {
    const mesh = this.mesh;
    const packed = packRgba8(color);
    const at = (direction: { x: number; y: number }, length: number): Corner => ({
      x: f(origin.x + f(direction.x * length)),
      y: f(origin.y + f(direction.y * length)),
      color,
    });
    const steps = Math.max(1, Math.ceil(((end - start) / turn) * stepsPerTurn));
    for (let step = 0; step < steps; step++) {
      const a = pieDirection(start + ((end - start) * step) / steps);
      const b = pieDirection(start + ((end - start) * (step + 1)) / steps);
      const outerA = at(a, radius);
      const outerB = at(b, radius);
      addFringe(mesh, outerA, outerB, origin.x, origin.y);
      if (inner <= 0) {
        mesh.add(origin.x, origin.y, packed);
        mesh.add(outerA.x, outerA.y, packed);
        mesh.add(outerB.x, outerB.y, packed);
        continue;
      }
      const innerA = at(a, inner);
      const innerB = at(b, inner);
      for (const corner of [innerA, outerA, outerB, innerA, outerB, innerB]) {
        mesh.add(corner.x, corner.y, packed);
      }
      addFringe(mesh, innerA, innerB, outerA.x, outerA.y);
    }
    if (end - start >= turn - 1e-9) {
      return;
    }
    // The straight cuts at both ends, seen from a point inside the slice.
    const middle = at(pieDirection((start + end) / 2), f(f(radius + inner) / 2));
    for (const angle of [start, end]) {
      const direction = pieDirection(angle);
      addFringe(mesh, at(direction, inner), at(direction, radius), middle.x, middle.y);
    }
  }
}

function lighten(color: Rgba8): Rgba8 {
  return {
    r: color.r + Math.trunc((255 - color.r) / 4),
    g: color.g + Math.trunc((255 - color.g) / 4),
    b: color.b + Math.trunc((255 - color.b) / 4),
    a: color.a,
  };
}

const labelSize = 12;
const insideSweep = 0.5;
const elbow = 1.12;
const labelGap = 6;

interface Outside {
  readonly text: string;
  readonly width: number;
  readonly anchor: { x: number; y: number };
  readonly wanted: number;
}

/** @internal Places labels from the top down with at least one line between them, within the bounds. */
export function spreadLabels(places: number[], top: number, bottom: number, line: number): void {
  for (let i = 0; i < places.length; i++) {
    places[i] = Math.max(places[i] as number, i === 0 ? top : (places[i - 1] as number) + line);
  }
  for (let i = places.length - 1; i >= 0; i--) {
    places[i] = Math.min(places[i] as number, i === places.length - 1 ? bottom : (places[i + 1] as number) - line);
  }
}

function contrastTo(color: Rgba8): Rgba8 {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b > 150
    ? { r: 20, g: 20, b: 20, a: 255 }
    : { r: 255, g: 255, b: 255, a: 255 };
}

function percent(share: number): string {
  const culture = chartText.culture;
  const value = share * 100;
  const text =
    share < 0.1
      ? formatFixed(value, 1, culture).replace(new RegExp(`\\${culture.decimalSeparator}0$`), '')
      : formatFixed(value, 0, culture);
  return text + ' %';
}

/** @internal The labels of a pie inside its slices or outside on lines, and the value under the pointer. */
export class PieLabelOverlay extends ChartOverlay {
  constructor(private readonly series: PieSeries) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.series.version + chartText.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const pane = canvas.layout.panes[0];
    const slices = this.series.current;
    if (!pane || slices.total <= 0) {
      return;
    }
    const center = this.series.fit(pane.x, pane.y, pane.width, pane.height);
    const line = canvas.lineHeight(labelSize);
    if (this.series.labels !== 'none') {
      const left: Outside[] = [];
      const right: Outside[] = [];
      for (let i = 0; i < slices.values.length; i++) {
        if ((slices.sweep[i] as number) > 0) {
          this.placeLabel(canvas, slices, i, center, line, left, right);
        }
      }
      this.drawOutside(canvas, left, pane, line, true);
      this.drawOutside(canvas, right, pane, line, false);
    }
    this.drawHover(canvas, slices, center);
  }

  private textOf(slices: PieSlices, index: number): string {
    const share = (slices.sweep[index] as number) / turn;
    const name = slices.names[index] ?? '';
    switch (this.series.labels) {
      case 'name':
        return name;
      case 'percent':
        return percent(share);
      case 'value':
        return formatGeneral(slices.values[index] as number, 4, chartText.culture);
      default:
        return name.length === 0 ? percent(share) : `${name} ${percent(share)}`;
    }
  }

  private placeLabel(
    canvas: OverlayCanvas,
    slices: PieSlices,
    index: number,
    center: { x: number; y: number; radius: number },
    line: number,
    left: Outside[],
    right: Outside[],
  ): void {
    const text = this.textOf(slices, index);
    if (text.length === 0) {
      return;
    }
    const sweep = slices.sweep[index] as number;
    const direction = pieDirection((slices.start[index] as number) + sweep / 2);
    const radius = center.radius;
    const lift = f(this.series.liftOf(index) * radius);
    const origin = { x: f(center.x + f(direction.x * lift)), y: f(center.y + f(direction.y * lift)) };
    const width = canvas.measureWidth(text, labelSize);
    const ring = radius * (1 - this.series.innerRadius);
    // Inside when the slice is wide enough: at its middle for a pie, in the middle of the ring for a donut.
    const at = this.series.innerRadius > 0 ? radius * (1 - ring / radius / 2) : f(radius * radiusWithLabels);
    const room = 2 * at * Math.sin(Math.min(sweep, Math.PI) / 2);
    if (sweep >= insideSweep && width <= room * 0.9 && width <= ring * 1.8 && line <= ring * 0.9) {
      const x = f(origin.x + f(direction.x * f(at)));
      const y = f(origin.y + f(direction.y * f(at)));
      canvas.drawText(
        text,
        roundHalfEven(x - width / 2),
        roundHalfEven(y + line * 0.35),
        labelSize,
        contrastTo(this.series.colorOf(index)),
      );
      return;
    }
    const anchor = { x: f(origin.x + f(direction.x * radius)), y: f(origin.y + f(direction.y * radius)) };
    const bend = f(origin.y + f(direction.y * f(radius * elbow)));
    (direction.x < 0 ? left : right).push({ text, width, anchor, wanted: bend });
  }

  // Spreads the labels of one side top to bottom with at least one line between them, then draws them with their lines.
  private drawOutside(canvas: OverlayCanvas, labels: Outside[], pane: DipRect, line: number, isLeft: boolean): void {
    if (labels.length === 0) {
      return;
    }
    labels.sort((a, b) => a.wanted - b.wanted);
    const places = labels.map((label) => label.wanted);
    spreadLabels(places, pane.y + line, pane.bottom - line * 0.3, line);
    const center = this.series.fit(pane.x, pane.y, pane.width, pane.height);
    const edge = isLeft ? center.x - center.radius * elbow - labelGap : center.x + center.radius * elbow + labelGap;
    const color = { ...canvas.colors.text, a: 150 };
    labels.forEach((label, i) => {
      const y = places[i] as number;
      const bend = {
        x: isLeft ? Math.min(label.anchor.x, f(f(edge) + labelGap)) : Math.max(label.anchor.x, f(f(edge) - labelGap)),
        y: f(y),
      };
      canvas.drawLine(label.anchor, bend, 1, color);
      canvas.drawLine(bend, { x: f(edge), y: f(y) }, 1, color);
      const x = isLeft ? edge - 4 - label.width : edge + 4;
      canvas.drawText(label.text, roundHalfEven(x), roundHalfEven(y + line * 0.35), labelSize, canvas.colors.text);
    });
  }

  private drawHover(canvas: OverlayCanvas, slices: PieSlices, center: { x: number; y: number; radius: number }): void {
    const index = this.series.highlightedIndex;
    if (index < 0 || index >= slices.values.length || (slices.sweep[index] as number) <= 0) {
      return;
    }
    const name = slices.names[index] ?? '';
    const text =
      (name.length > 0 ? `${name}: ` : '') +
      formatGeneral(slices.values[index] as number, 6, chartText.culture) +
      ` (${percent((slices.sweep[index] as number) / turn)})`;
    const direction = pieDirection((slices.start[index] as number) + (slices.sweep[index] as number) / 2);
    const half = f(center.radius * 0.5);
    const x = f(center.x + f(direction.x * half));
    const y = f(center.y + f(direction.y * half));
    canvas.drawLabel(
      text,
      x - canvas.measureWidth(text, canvas.labelSize) / 2,
      y,
      { ...canvas.colors.background, a: 235 },
      canvas.colors.text,
    );
  }
}

/** Lights up the slice under the pointer and pulls a slice out on a click, again back. */
export class PieModifier extends ChartModifier {
  constructor() {
    super(ZoomPanModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    const chart = this.interaction?.chart;
    const pane = chart?.currentLayout?.panes[0];
    const pie = chart?.series.find((series) => series instanceof PieSeries);
    if (!pane || !pie) {
      return 'ignored';
    }
    if (input.kind === 'exited' || input.kind === 'canceled') {
      pie.highlightedIndex = -1;
      return 'ignored';
    }
    const index = pie.findSlice(input.position.x, input.position.y, pane.x, pane.y, pane.width, pane.height);
    if (input.kind === 'moved') {
      pie.highlightedIndex = index;
      return 'ignored';
    }
    if (input.kind === 'pressed' && input.changedButton === 'primary' && index >= 0) {
      pie.explodedIndex = pie.explodedIndex === index ? -1 : index;
      return 'handled';
    }
    return 'ignored';
  }
}

/** Describes a pie chart: hidden axes, the pie, its labels and the pointer. */
export function pie(
  builder: ChartBuilder,
  values: readonly number[],
  names?: readonly string[],
  configure?: (pie: PieSeries) => void,
): ChartBuilder {
  return builder
    .xAxis((axis) => axis.numeric('x').range(0, 1).hidden())
    .yAxis((axis) => axis.numeric('y').range(0, 1).hidden())
    .addSeries((x, y) => {
      const series = new PieSeries(values, names, x, y);
      configure?.(series);
      return series;
    })
    .addOverlay((chart) => new PieLabelOverlay(chart.series.find((series) => series instanceof PieSeries) as PieSeries))
    .addModifier(() => new PieModifier());
}
