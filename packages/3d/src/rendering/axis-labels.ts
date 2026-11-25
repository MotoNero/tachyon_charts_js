// The numbers and titles of the three axes along the edges of the box, as AxisLabels3D of the .NET version; the color
// scales of surfaces and antennas come with their parts.
import {
  chartText,
  ChartOverlay,
  roundHalfEven,
  type Axis,
  type DipRect,
  type OverlayCanvas,
} from '@tachyon-charts/core';
import { boxTicks, keepApart, selectWalls, toBox, xEdge, yEdge, zEdge, type LabelEdge } from '../scene/axis-box';
import type { Matrix3D } from '../scene/matrix';
import type { Point3D } from '../scene/matrix';
import type { Scene3D } from '../scene/scene';

const labelReach = 0.14;
const titleReach = 0.5;
const labelGap = 6;
const zOffset = 10;
const highestUpAxisView = 62;

class Projector {
  constructor(
    private readonly matrix: Matrix3D,
    private readonly pane: DipRect,
  ) {}

  toDips(point: Point3D): [number, number] {
    const { x, y } = this.matrix.project(point);
    return [this.pane.x + ((x + 1) / 2) * this.pane.width, this.pane.y + ((1 - y) / 2) * this.pane.height];
  }
}

// The labels of an axis, made again only when its range changes.
class AxisText {
  private range: { min: number; max: number } | undefined;
  labels: string[] = [];
  places: number[] = [];
  dips: [number, number][] = [];
  spans: [number, number][] = [];
  shown: boolean[] = [];

  update(axis: Axis): void {
    const range = axis.visibleRange;
    if (this.range?.min === range.min && this.range.max === range.max) {
      return;
    }
    this.range = { min: range.min, max: range.max };
    const ticks = boxTicks(axis);
    this.labels = ticks.map((tick) => tick.label);
    this.places = ticks.map((tick) => toBox(axis, tick.value));
    this.dips = ticks.map(() => [0, 0]);
    this.spans = ticks.map(() => [0, 0]);
    this.shown = ticks.map(() => false);
  }
}

function along(edge: LabelEdge, place: number, reach: number): Point3D {
  return edge.start.plus(edge.end.minus(edge.start).times((place + 1) / 2)).plus(edge.outward.times(reach));
}

/** @internal Writes the labels of the box of a scene. */
export class AxisLabels3D extends ChartOverlay {
  private readonly x = new AxisText();
  private readonly y = new AxisText();
  private readonly z = new AxisText();

  constructor(private readonly scene: Scene3D) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.scene.camera.version + chartText.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const scene = this.scene;
    const pane = canvas.layout.panes[0];
    if (!scene.showsAxes || !pane) {
      return;
    }
    const matrix = scene.camera.createMatrix(pane.width / pane.height);
    const walls = selectWalls(scene.camera.eye);
    const view = new Projector(matrix, pane);
    this.x.update(scene.xAxis);
    this.y.update(scene.yAxis);
    this.drawFloorAxis(canvas, this.x, scene.xAxis, xEdge(walls), view);
    this.drawFloorAxis(canvas, this.y, scene.yAxis, yEdge(walls), view);
    // Seen from above the axis points at the eye, and its numbers would fall on one spot.
    if (Math.abs(scene.camera.elevation) <= highestUpAxisView) {
      this.z.update(scene.zAxis);
      this.drawUpAxis(canvas, zEdge(walls, matrix), view);
    }
  }

  private drawFloorAxis(canvas: OverlayCanvas, text: AxisText, axis: Axis, edge: LabelEdge, view: Projector): void {
    const size = canvas.labelSize;
    const height = canvas.lineHeight(size);
    const a = view.toDips(edge.start);
    const b = view.toDips(edge.end);
    const isWide = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    text.labels.forEach((label, i) => {
      const place = view.toDips(along(edge, text.places[i] as number, labelReach));
      text.dips[i] = place;
      const width = canvas.measureWidth(label, size);
      text.spans[i] = isWide ? [place[0] - width / 2, place[0] + width / 2] : [place[1] - height, place[1]];
    });
    keepApart(text.spans, labelGap, text.shown);
    text.labels.forEach((label, i) => {
      if (text.shown[i]) {
        const [x, y] = text.dips[i] as [number, number];
        const width = canvas.measureWidth(label, size);
        canvas.drawText(label, roundHalfEven(x - width / 2), roundHalfEven(y + height / 3), size, canvas.colors.text);
      }
    });
    const title = axis.title;
    if (title !== undefined) {
      const [x, y] = view.toDips(along(edge, 0, titleReach));
      canvas.drawText(
        title,
        roundHalfEven(x - canvas.measureWidth(title, size) / 2),
        roundHalfEven(y),
        size,
        canvas.colors.text,
      );
    }
  }

  private drawUpAxis(canvas: OverlayCanvas, edge: LabelEdge, view: Projector): void {
    const text = this.z;
    const size = canvas.labelSize;
    const height = canvas.lineHeight(size);
    text.labels.forEach((_, i) => {
      const place = view.toDips(along(edge, text.places[i] as number, 0));
      text.dips[i] = place;
      text.spans[i] = [place[1] - height, place[1]];
    });
    keepApart(text.spans, labelGap, text.shown);
    text.labels.forEach((label, i) => {
      if (text.shown[i]) {
        const [x, y] = text.dips[i] as [number, number];
        const width = canvas.measureWidth(label, size);
        canvas.drawText(
          label,
          roundHalfEven(x - width - zOffset),
          roundHalfEven(y + height / 3),
          size,
          canvas.colors.text,
        );
      }
    });
    const title = this.scene.zAxis.title;
    if (title !== undefined) {
      const [x, y] = view.toDips(edge.end);
      canvas.drawText(
        title,
        roundHalfEven(x - canvas.measureWidth(title, size) / 2),
        roundHalfEven(y - height),
        size,
        canvas.colors.text,
      );
    }
  }
}
