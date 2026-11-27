// The values of the elements that ask for them (showsValues), flat over the picture above their points, as
// ValueLabels3D of the .NET version: the height of a column, a surface or a measured point. Large data are sampled
// evenly, and a label that would cover one drawn before is left out.
import {
  chartText,
  ChartOverlay,
  DipRect,
  formatFixed,
  roundHalfEven,
  type Culture,
  type HeatmapData,
  type OverlayCanvas,
} from '@tachyon-charts/core';
import { toBox } from '../scene/axis-box';
import { Point3D } from '../scene/matrix';
import type { Scene3D } from '../scene/scene';

// About this many places per element are looked at; more would cover each other anyway.
const budget = 600;
const padding = 3;
const distance = 4;

/** @internal A value with at most three decimals and grouped thousands, as "#,0.###": 913, 0.5, 1,250.25. */
export function formatValue(value: number, culture: Culture): string {
  const fixed = formatFixed(value, 3, culture);
  const decimal = culture.decimalSeparator;
  const [whole = '', fraction = ''] = fixed.split(decimal);
  const sign = whole.startsWith(culture.negativeSign) ? culture.negativeSign : '';
  const digits = sign ? whole.slice(sign.length) : whole;
  const group = decimal === ',' ? '.' : ',';
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const kept = fraction.replace(/0+$/, '');
  const text = kept.length > 0 ? `${grouped}${decimal}${kept}` : grouped;
  return text === '0' ? '0' : sign + text;
}

function stride(count: number): number {
  return Math.max(1, Math.ceil(count / budget));
}

/** @internal Writes the values of the elements that show them. */
export class ValueLabels3D extends ChartOverlay {
  constructor(private readonly scene: Scene3D) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.scene.camera.version + this.scene.version + chartText.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const labels = this.collect();
    const pane = canvas.layout.panes[0];
    if (labels.length === 0 || !pane) {
      return;
    }
    const scene = this.scene;
    const matrix = scene.camera.createMatrix(pane.width / pane.height);
    const size = canvas.labelSize;
    const line = canvas.lineHeight(size);
    const back = { ...canvas.colors.background, a: 190 };
    const placed: DipRect[] = [];
    for (const [place, value] of labels) {
      const box = new Point3D(toBox(scene.xAxis, place.x), toBox(scene.yAxis, place.y), toBox(scene.zAxis, place.z));
      const { x, y, z } = matrix.project(box);
      if (Math.abs(x) > 1 || Math.abs(y) > 1 || z < -1 || z > 1) {
        continue;
      }
      const px = Math.fround(pane.x + ((x + 1) / 2) * pane.width);
      const py = Math.fround(pane.y + ((1 - y) / 2) * pane.height);
      const text = formatValue(value, chartText.culture);
      const width = canvas.measureWidth(text, size) + 2 * padding;
      const area = new DipRect(px - width / 2, py - distance - line - padding, width, line + padding);
      if (
        placed.some(
          (other) =>
            area.x < other.x + other.width &&
            other.x < area.x + area.width &&
            area.y < other.y + other.height &&
            other.y < area.y + area.height,
        )
      ) {
        continue;
      }
      placed.push(area);
      canvas.fillRectangle(area, back);
      canvas.drawText(
        text,
        roundHalfEven(area.x + padding),
        roundHalfEven(area.y + padding / 2 + line * 0.8),
        size,
        canvas.colors.text,
      );
    }
  }

  private collect(): [Point3D, number][] {
    const labels: [Point3D, number][] = [];
    const scene = this.scene;
    const addGrid = (data: HeatmapData, x0: number, dx: number, y0: number, dy: number): void => {
      const step = Math.max(1, Math.ceil(Math.sqrt((data.width * data.height) / budget)));
      for (let row = 0; row < data.height; row += step) {
        for (let column = 0; column < data.width; column += step) {
          const value = data.at(column, row);
          if (Number.isFinite(value)) {
            labels.push([new Point3D(x0 + column * dx, y0 + row * dy, value), value]);
          }
        }
      }
    };
    const addArrays = (x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>): void => {
      const count = Math.min(x.length, y.length, z.length);
      for (let i = 0; i < count; i += stride(count)) {
        const value = z[i] as number;
        if (Number.isFinite(value)) {
          labels.push([new Point3D(x[i] as number, y[i] as number, value), value]);
        }
      }
    };
    // Columns at the middle of their cells, surfaces at the corners of their grid; both evenly thinned.
    for (const bars of scene.bars) {
      if (bars.showsValues) {
        const data = bars.data;
        const spanX = bars.x.max - bars.x.min;
        const spanY = bars.y.max - bars.y.min;
        addGrid(
          data,
          bars.x.min + (0.5 * spanX) / data.width,
          spanX / data.width,
          bars.y.min + (0.5 * spanY) / data.height,
          spanY / data.height,
        );
      }
    }
    for (const surface of scene.surfaces) {
      if (surface.showsValues) {
        const data = surface.data;
        addGrid(
          data,
          surface.x.min,
          (surface.x.max - surface.x.min) / Math.max(data.width - 1, 1),
          surface.y.min,
          (surface.y.max - surface.y.min) / Math.max(data.height - 1, 1),
        );
      }
    }
    for (const element of [...scene.lines, ...scene.scatters]) {
      if (element.showsValues) {
        const points = element.points;
        const count = points.count;
        for (let i = 0; i < count; i += stride(count)) {
          const point = points.read(i);
          if (Number.isFinite(point.z)) {
            labels.push([point, point.z]);
          }
        }
      }
    }
    for (const bubbles of scene.bubbles) {
      if (bubbles.showsValues) {
        addArrays(bubbles.x, bubbles.y, bubbles.z);
      }
    }
    for (const map of scene.maps) {
      if (map.showsValues) {
        addArrays(map.x, map.y, map.z);
      }
    }
    for (const cloud of scene.clouds) {
      if (cloud.showsValues) {
        addArrays(cloud.x, cloud.y, cloud.z);
      }
    }
    return labels;
  }
}
