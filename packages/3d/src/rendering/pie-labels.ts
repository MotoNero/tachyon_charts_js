// The labels of the pies in 3D, flat over the picture, as a pie in 2D does and as PieLabels3D of the .NET version: on
// the slice when it is wide enough, otherwise beside the pie with a line to its edge, spread so that no two overlap.
import { chartText, ChartOverlay, DipRect, roundHalfEven, type OverlayCanvas, type Point } from '@tachyon-charts/core';
import { toBox } from '../scene/axis-box';
import { Point3D, type Matrix3D } from '../scene/matrix';
import type { Pie3D } from '../scene/pie';
import type { Scene3D } from '../scene/scene';

const inset = 4;
const insideShare = 0.06;
const gap = 14;

interface Outside {
  readonly text: string;
  readonly width: number;
  readonly anchor: Point;
  readonly y: number;
}

function overlap(a: DipRect, b: DipRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function area(width: number, line: number, left: number, middle: number): DipRect {
  return new DipRect(
    roundHalfEven(left - inset),
    roundHalfEven(middle - line / 2 - inset / 2),
    width + 2 * inset,
    line + inset,
  );
}

function label(canvas: OverlayCanvas, text: string, width: number, line: number, left: number, middle: number): void {
  const plate = area(width, line, left, middle);
  canvas.fillRectangle(plate, { ...canvas.colors.background, a: 190 });
  canvas.drawText(
    text,
    roundHalfEven(plate.x + inset),
    roundHalfEven(plate.y + inset / 2 + line * 0.8),
    canvas.labelSize,
    canvas.colors.text,
  );
}

// The labels of one side top to bottom, at least one line apart, then back up from the bottom, each with its line.
function spread(
  canvas: OverlayCanvas,
  labels: Outside[],
  pane: DipRect,
  line: number,
  column: number,
  isLeft: boolean,
): void {
  if (labels.length === 0) {
    return;
  }
  labels.sort((a, b) => a.y - b.y);
  const step = line + inset + 2;
  const y = labels.map((item) => item.y);
  for (let i = 0; i < y.length; i++) {
    y[i] = Math.max(y[i] as number, i === 0 ? pane.y + step : (y[i - 1] as number) + step);
  }
  for (let i = y.length - 1; i >= 0; i--) {
    y[i] = Math.min(y[i] as number, i === y.length - 1 ? pane.bottom - step : (y[i + 1] as number) - step);
  }
  // The column stays inside the chart, even when the pie fills it and the labels then lie over its edge.
  const widest = Math.max(...labels.map((item) => item.width)) + 2 * inset;
  const x = isLeft ? Math.max(column, pane.x + widest) : Math.min(column, pane.x + pane.width - widest);
  const color = { ...canvas.colors.text, a: 150 };
  labels.forEach((item, i) => {
    const at = y[i] as number;
    canvas.drawLine(item.anchor, { x: Math.fround(x), y: Math.fround(at) }, 1, color);
    label(canvas, item.text, item.width, line, isLeft ? x - inset - item.width : x + inset, at);
  });
}

/** @internal Writes the labels of the pies of a scene. */
export class PieLabels3D extends ChartOverlay {
  constructor(private readonly scene: Scene3D) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.scene.camera.version + this.scene.version + chartText.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const pane = canvas.layout.panes[0];
    if (!pane || this.scene.pies.length === 0) {
      return;
    }
    const matrix = this.scene.camera.createMatrix(pane.width / pane.height);
    const line = canvas.lineHeight(canvas.labelSize);
    for (const pie of this.scene.pies) {
      const left: Outside[] = [];
      const right: Outside[] = [];
      const placed: DipRect[] = [];
      const [minimum, maximum] = this.extent(pie, pane, matrix);
      const center = this.toScreen(pane, matrix, new Point3D(0, 0, pie.height / 2));
      for (let i = 0; i < pie.values.length; i++) {
        const text = pie.labelText(i);
        const inside = pie.labelPoint(i);
        const edge = pie.topPoint(i, 1);
        if (text.length === 0 || !inside || !edge) {
          continue;
        }
        const width = canvas.measureWidth(text, canvas.labelSize);
        // On the slice when it is wide enough and the label covers none placed before; slices seen flat at the back
        // may not.
        const place = this.toScreen(pane, matrix, inside);
        const plate = area(width, line, place.x - width / 2, place.y);
        if (pie.share(i) >= insideShare && !placed.some((other) => overlap(other, plate))) {
          placed.push(plate);
          label(canvas, text, width, line, place.x - width / 2, place.y);
          continue;
        }
        const anchor = this.toScreen(pane, matrix, edge);
        (anchor.x < center.x ? left : right).push({ text, width, anchor, y: anchor.y });
      }
      spread(canvas, left, pane, line, minimum - gap, true);
      spread(canvas, right, pane, line, maximum + gap, false);
    }
  }

  // The left and right edge of the pie on the screen, from points around its rim.
  private extent(pie: Pie3D, pane: DipRect, matrix: Matrix3D): [number, number] {
    let minimum = Infinity;
    let maximum = -Infinity;
    const reach = 1 + pie.explodeDistance;
    for (let step = 0; step < 72; step++) {
      const angle = (step * Math.PI) / 36;
      for (const z of [-pie.height / 2, pie.height / 2]) {
        const point = this.toScreen(pane, matrix, new Point3D(Math.cos(angle) * reach, Math.sin(angle) * reach, z));
        minimum = Math.min(minimum, point.x);
        maximum = Math.max(maximum, point.x);
      }
    }
    return [minimum, maximum];
  }

  // From data units through the box of the axes onto the screen, in single precision as the .NET version.
  private toScreen(pane: DipRect, matrix: Matrix3D, point: Point3D): Point {
    const scene = this.scene;
    const box = new Point3D(toBox(scene.xAxis, point.x), toBox(scene.yAxis, point.y), toBox(scene.zAxis, point.z));
    const { x, y } = matrix.project(box);
    return {
      x: Math.fround(pane.x + ((x + 1) / 2) * pane.width),
      y: Math.fround(pane.y + ((1 - y) / 2) * pane.height),
    };
  }
}
