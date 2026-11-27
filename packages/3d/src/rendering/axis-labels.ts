// The numbers and titles of the three axes along the edges of the box, as AxisLabels3D of the .NET version; the color
// scales of surfaces and antennas come with their parts.
import {
  chartText,
  ChartOverlay,
  DipRect,
  formatGeneral,
  invariantCulture,
  roundHalfEven,
  type Axis,
  type OverlayCanvas,
} from '@tachyon-charts/core';
import { boxTicks, keepApart, selectWalls, toBox, xEdge, yEdge, zEdge, type LabelEdge } from '../scene/axis-box';
import type { Matrix3D } from '../scene/matrix';
import { Point3D } from '../scene/matrix';
import type { AntennaPattern3D } from '../scene/antenna';
import type { ColorScale3D } from '../scene/mesh';
import type { Scene3D } from '../scene/scene';

const labelReach = 0.14;
const titleReach = 0.5;
const labelGap = 6;
const zOffset = 10;
const highestUpAxisView = 62;
const scaleWidth = 14;
const scaleHeight = 220;
const scaleMargin = 56;
const scaleSteps = 64;

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

function drawScale(canvas: OverlayCanvas, scale: ColorScale3D, pane: DipRect): void {
  const x = pane.x + pane.width - scaleMargin;
  const top = pane.y + (pane.height - scaleHeight) / 2;
  const step = scaleHeight / scaleSteps;
  for (let i = 0; i < scaleSteps; i++) {
    canvas.fillRectangle(
      new DipRect(x, top + i * step, scaleWidth, step + 0.5),
      scale.colormap.sample(1 - (i + 0.5) / scaleSteps),
    );
  }
  const size = canvas.labelSize;
  const height = canvas.lineHeight(size);
  const middle = x + scaleWidth / 2;
  const color = canvas.colors.text;
  const high = formatGeneral(scale.range.max, 4, invariantCulture);
  const low = formatGeneral(scale.range.min, 4, invariantCulture);
  canvas.drawText(
    high,
    roundHalfEven(middle - canvas.measureWidth(high, size) / 2),
    roundHalfEven(top - height / 2),
    size,
    color,
  );
  canvas.drawText(
    low,
    roundHalfEven(middle - canvas.measureWidth(low, size) / 2),
    roundHalfEven(top + scaleHeight + height),
    size,
    color,
  );
  const title = scale.title;
  if (title) {
    const width = canvas.measureWidth(title, size);
    canvas.drawText(
      title,
      roundHalfEven(Math.min(middle - width / 2, pane.x + pane.width - width)),
      roundHalfEven(top - height * 1.7),
      size,
      color,
    );
  }
}

function drawAntenna(
  canvas: OverlayCanvas,
  antenna: AntennaPattern3D,
  pane: DipRect,
  view: Projector,
  scene: Scene3D,
): void {
  if (!Number.isFinite(antenna.mainLobe.gain)) {
    return;
  }
  const x = pane.x + pane.width - scaleMargin;
  const top = pane.y + (pane.height - scaleHeight) / 2;
  const step = scaleHeight / scaleSteps;
  for (let i = 0; i < scaleSteps; i++) {
    canvas.fillRectangle(
      new DipRect(x, top + i * step, scaleWidth, step + 0.5),
      antenna.colormap.sample(1 - (i + 0.5) / scaleSteps),
    );
  }
  const size = canvas.labelSize;
  const color = canvas.colors.text;
  const height = canvas.lineHeight(size);
  const peak = antenna.peakText;
  const floor = antenna.floorText;
  const middle = x + scaleWidth / 2;
  canvas.drawText(
    peak,
    roundHalfEven(middle - canvas.measureWidth(peak, size) / 2),
    roundHalfEven(top - height / 2),
    size,
    color,
  );
  canvas.drawText(
    floor,
    roundHalfEven(middle - canvas.measureWidth(floor, size) / 2),
    roundHalfEven(top + scaleHeight + height),
    size,
    color,
  );
  const tip = antenna.markTip;
  const [tipX, tipY] = view.toDips(
    new Point3D(toBox(scene.xAxis, tip.x), toBox(scene.yAxis, tip.y), toBox(scene.zAxis, tip.z)),
  );
  canvas.drawText(antenna.lobeText, roundHalfEven(tipX + labelGap), roundHalfEven(tipY), size, color);
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
    const antenna = scene.antennas[0];
    if (antenna) {
      drawAntenna(canvas, antenna, pane, view, scene);
      return;
    }
    // The first surface whose colors come from a color scale shows it.
    for (const mesh of scene.meshes) {
      if (mesh.colorScale) {
        drawScale(canvas, mesh.colorScale, pane);
        return;
      }
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
