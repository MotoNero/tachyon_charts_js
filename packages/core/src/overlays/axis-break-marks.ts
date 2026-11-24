// The marks of breaks and gaps of axes: a thin line across the plot and two slanted strokes on the edge of the axis,
// as AxisBreakMarks of the .NET version. The chart draws them itself in the overlay pass.
import { TimeGapScaling } from '../axes/time-gaps';
import type { AxisPlacement, ChartLayoutResult } from '../layout/chart-layout';
import { BreakScaling } from '../numerics/break-scaling';
import type { OverlayCanvas } from './chart-overlay';

const f = Math.fround;
const stroke = 5;
const closest = 6;

/** @internal Whether an axis of the layout has breaks or gaps. Runs every frame without allocating. */
export function hasAxisBreaks(layout: ChartLayoutResult): boolean {
  const axes = layout.axes;
  for (const placement of axes) {
    const scaling = placement.axis.scaling;
    if (scaling instanceof BreakScaling || scaling instanceof TimeGapScaling) {
      return true;
    }
  }
  return false;
}

/** @internal Draws the marks of all breaks and gaps. */
export function drawAxisBreaks(canvas: OverlayCanvas, layout: ChartLayoutResult): void {
  for (const placement of layout.axes) {
    const scaling = placement.axis.scaling;
    if (scaling instanceof BreakScaling) {
      for (const range of scaling.breaks) {
        drawMarks(canvas, layout, placement, [range.min]);
      }
    } else if (scaling instanceof TimeGapScaling) {
      const starts: number[] = [];
      for (let i = 0; i < scaling.gaps.count; i++) {
        starts.push(Number(scaling.gaps.startOf(i) - scaling.origin));
      }
      drawMarks(canvas, layout, placement, starts);
    }
  }
}

function drawMarks(canvas: OverlayCanvas, layout: ChartLayoutResult, placement: AxisPlacement, values: number[]): void {
  const axis = placement.axis;
  const bounds = placement.bounds;
  const transform = axis.isHorizontal
    ? axis.createTransform(bounds.x, bounds.width)
    : axis.createTransform(bounds.y, bounds.height);
  const low = axis.isHorizontal ? bounds.x : bounds.y;
  const high = axis.isHorizontal ? bounds.right : bounds.bottom;
  const line = { ...canvas.colors.text, a: 70 };
  const mark = { ...canvas.colors.text, a: 220 };
  const area = layout.plotArea;
  let last = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const at = transform.toPixel(value);
    if (!Number.isFinite(at) || at <= low || at >= high || Math.abs(at - last) < closest) {
      continue;
    }
    last = at;
    const position = f(at);
    if (axis.isHorizontal) {
      const edge = f(axis.position === 'top' ? area.y : area.bottom);
      canvas.drawLine({ x: position, y: f(area.y) }, { x: position, y: f(area.bottom) }, 1, line);
      canvas.drawLine(
        { x: f(position - 4), y: f(edge + stroke) },
        { x: f(position - 1), y: f(edge - stroke) },
        1.5,
        mark,
      );
      canvas.drawLine(
        { x: f(position + 1), y: f(edge + stroke) },
        { x: f(position + 4), y: f(edge - stroke) },
        1.5,
        mark,
      );
    } else {
      const edge = f(axis.position === 'right' ? area.right : area.x);
      canvas.drawLine({ x: f(area.x), y: position }, { x: f(area.right), y: position }, 1, line);
      canvas.drawLine(
        { x: f(edge - stroke), y: f(position + 4) },
        { x: f(edge + stroke), y: f(position + 1) },
        1.5,
        mark,
      );
      canvas.drawLine(
        { x: f(edge - stroke), y: f(position - 1) },
        { x: f(edge + stroke), y: f(position - 4) },
        1.5,
        mark,
      );
    }
  }
}
