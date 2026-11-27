// The value under the pointer and the markers, flat over the picture, as PointerPick3D and PickLabels3D of the .NET
// version.
import {
  chartText,
  ChartOverlay,
  DipRect,
  formatFixed,
  formatGeneral,
  NumericAxis,
  roundHalfEven,
  type Axis,
  type ChartGroup,
  type DipRect as Pane,
  type OverlayCanvas,
} from '@tachyon-charts/core';
import { AntennaPattern3D } from '../scene/antenna';
import type { Matrix3D } from '../scene/matrix';
import { pickPixels, type Pick3D, type Pick3DFinder, type PieSlicePick } from '../scene/picking';
import type { Scene3D } from '../scene/scene';

const gap = 10;
const inset = 6;
const dot = 3.5;

/** @internal Whether a hit is a slice of a pie. */
export function isPieSlice(source: object): source is PieSlicePick {
  return 'pie' in source && 'index' in source;
}

/** Remembers what lies under the pointer of a 3D chart; the chart makes it. */
export class PointerPick3D {
  private changes = 0;
  /** What lies under the pointer. */
  current: Pick3D | undefined;
  /** The group whose other charts show the place under the pointer as their crosshair. */
  group: ChartGroup | undefined;

  constructor(
    private readonly scene: Scene3D,
    private readonly picker: Pick3DFinder,
  ) {}

  /** Grows with each change of what lies under the pointer. */
  get version(): number {
    return this.changes;
  }

  /** Looks at a place of the pane. */
  move(pane: Pane, x: number, y: number): void {
    this.current = this.find(pane, x, y);
    this.changes++;
    this.group?.showCursor(this.current?.position.x);
  }

  /** Hides the value. */
  hide(): void {
    if (this.current) {
      this.current = undefined;
      this.changes++;
      this.group?.showCursor(undefined);
    }
  }

  /** What lies at a place of the pane, if anything. */
  find(pane: Pane, px: number, py: number): Pick3D | undefined {
    const aspect = pane.width / pane.height;
    const x = ((px - pane.x) / pane.width) * 2 - 1;
    const y = 1 - ((py - pane.y) / pane.height) * 2;
    const camera = this.scene.camera;
    const ray = camera.createRay(aspect, x, y);
    const beside = camera.createRay(aspect, x + (2 * pickPixels) / pane.width, y);
    return this.picker.find(ray, {
      base: beside.start.minus(ray.start).length,
      growth: beside.direction.minus(ray.direction).length,
    });
  }
}

function row(axis: Axis, name: string, value: number): string {
  const title = axis.title ?? name;
  if (!(axis instanceof NumericAxis)) {
    return `${title}: ${axis.formatCursorValue(value)}`;
  }
  const format = axis.labelFormat;
  const unit = format.unit ? ` ${format.unit}` : '';
  return `${title}: ${formatGeneral(value, 6, format.culture ?? chartText.culture)}${unit}`;
}

/** @internal The rows of the label of a hit: three or four. */
export function pickRows(scene: Scene3D, pick: Pick3D): string[] {
  const culture = chartText.culture;
  const source = pick.source;
  if (source instanceof AntennaPattern3D) {
    const p = pick.position;
    const azimuth = (Math.atan2(p.y, p.x) * 180) / Math.PI;
    const elevation = (Math.asin(Math.min(Math.max(p.length > 0 ? p.z / p.length : 0, -1), 1)) * 180) / Math.PI;
    return [
      `${chartText.text('azimuth')}: ${formatFixed(azimuth, 1, culture)}°`,
      `${chartText.text('elevation')}: ${formatFixed(elevation, 1, culture)}°`,
      `${chartText.text('gain')}: ${formatFixed(source.floor + p.length, 2, culture)} dB`,
    ];
  }
  if (isPieSlice(source)) {
    // As in 2D: the name, the value and the share of the whole.
    const share = source.pie.share(source.index);
    const value = share * 100;
    const percent =
      share < 0.1
        ? formatFixed(value, 1, culture).replace(new RegExp(`\\${culture.decimalSeparator}0$`), '')
        : formatFixed(value, 0, culture);
    return [
      source.pie.names[source.index] ?? '',
      `${chartText.text('value')}: ${formatGeneral(source.pie.values[source.index] as number, 6, culture)}`,
      `${percent} %`,
    ];
  }
  const rows = [
    row(scene.xAxis, 'X', pick.position.x),
    row(scene.yAxis, 'Y', pick.position.y),
    row(scene.zAxis, 'Z', pick.position.z),
  ];
  if (pick.value !== undefined) {
    rows.push(`${chartText.text('value')}: ${formatGeneral(pick.value, 6, culture)}`);
  }
  return rows;
}

/** @internal Shows the value under the pointer and the markers, flat over the picture. */
export class PickLabels3D extends ChartOverlay {
  constructor(
    private readonly scene: Scene3D,
    private readonly pointer: PointerPick3D,
  ) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.pointer.version + this.scene.camera.version + this.scene.version + chartText.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const pane = canvas.layout.panes[0];
    if (!pane) {
      return;
    }
    const matrix = this.scene.camera.createMatrix(pane.width / pane.height);
    this.scene.markers.forEach((marker, i) => {
      this.drawPick(canvas, pane, matrix, marker);
      const { x, y } = matrix.project(marker.box);
      const dipX = pane.x + ((x + 1) / 2) * pane.width;
      const dipY = pane.y + ((1 - y) / 2) * pane.height;
      canvas.drawText(
        String(i + 1),
        roundHalfEven(dipX - 10),
        roundHalfEven(dipY - 6),
        canvas.labelSize,
        canvas.colors.accent,
      );
    });
    const current = this.pointer.current;
    if (current) {
      this.drawPick(canvas, pane, matrix, current);
    }
  }

  private drawPick(canvas: OverlayCanvas, pane: DipRect, matrix: Matrix3D, pick: Pick3D): void {
    const { x, y } = matrix.project(pick.box);
    const dipX = pane.x + ((x + 1) / 2) * pane.width;
    const dipY = pane.y + ((1 - y) / 2) * pane.height;
    const cx = Math.fround(dipX);
    const cy = Math.fround(dipY);
    const accent = canvas.colors.accent;
    canvas.drawLine({ x: cx - dot, y: cy }, { x: cx + dot, y: cy }, dot, accent);
    canvas.drawLine({ x: cx, y: cy - dot }, { x: cx, y: cy + dot }, dot, accent);
    const rows = pickRows(this.scene, pick);
    const size = canvas.labelSize;
    const height = canvas.lineHeight(size);
    const width = Math.max(...rows.map((text) => canvas.measureWidth(text, size))) + 2 * inset;
    const total = rows.length * height + 2 * inset;
    const left = Math.min(dipX + gap, pane.x + pane.width - width);
    const top = Math.max(Math.min(dipY - total - gap, pane.y + pane.height - total), pane.y);
    const area = new DipRect(roundHalfEven(left), roundHalfEven(top), width, total);
    canvas.fillRectangle(area, canvas.colors.background);
    canvas.drawRectangle(area, accent);
    rows.forEach((text, i) => {
      canvas.drawText(
        text,
        roundHalfEven(area.x + inset),
        roundHalfEven(area.y + inset + (i + 0.8) * height),
        size,
        canvas.colors.text,
      );
    });
  }
}
