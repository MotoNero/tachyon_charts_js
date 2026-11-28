// The rings, spokes and labels of a polar chart, zooming of its radius, and the chart itself, as PolarGridOverlay,
// RadialZoomModifier and PolarChart of the .NET version.
import type { Axis } from '../axes/axis';
import type { ChartBuilder } from '../fluent/chart-builder';
import type { ChartSeries } from '../pipeline/chart-series';
import { NumericAxis } from '../axes/numeric-axis';
import { ZoomPanModifier } from '../input/navigation-modifiers';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import type { WheelInputEvent } from '../input/primitives';
import { invariantCulture } from '../locale/culture';
import { formatGeneral } from '../locale/format';
import { DoubleRange } from '../numerics/range';
import { ChartSurface } from '../pipeline/chart-surface';
import { PolarProjection } from '../series/polar-series';
import type { TextEngine } from '../text/engine';
import { ChartOverlay, type OverlayCanvas } from './chart-overlay';

const circleCount = 4;
const circleSegments = 72;
const labelSize = 12;
const labelGap = 6;
// Between the spokes of the usual layouts, where the labels of the rings stay free.
const labelAngle = 22.5;
const degrees = ['0°', '45°', '90°', '135°', '180°', '225°', '270°', '315°'];

/** The rings, spokes and their labels of a polar chart, following its radial axis. */
export class PolarGridOverlay extends ChartOverlay {
  /**
   * @param radialAxis - The radial axis.
   * @param spokes - The names of the spokes, evenly around the circle from the top.
   */
  constructor(
    private readonly radialAxis: Axis,
    private readonly spokes: readonly string[],
  ) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.radialAxis.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const pane = canvas.layout.panes[0];
    if (!pane) {
      return;
    }
    const range = this.radialAxis.visibleRange;
    const projection = PolarProjection.fit(pane.x, pane.y, pane.width, pane.height, range);
    const line = { ...canvas.colors.text, a: 70 };
    for (let circle = 1; circle <= circleCount; circle++) {
      const value = range.min + ((range.max - range.min) * circle) / circleCount;
      let previous = projection.toPoint(0, value);
      for (let step = 1; step <= circleSegments; step++) {
        const point = projection.toPoint((step * 360) / circleSegments, value);
        canvas.drawLine(previous, point, 1, line);
        previous = point;
      }
      const at = projection.toPoint(labelAngle, value);
      canvas.drawText(formatGeneral(value, 4, invariantCulture), at.x + 3, at.y + 4, labelSize, canvas.colors.text);
    }
    const center = { x: Math.fround(projection.centerX), y: Math.fround(projection.centerY) };
    const outside = projection.withRadius(projection.radius + labelGap);
    this.spokes.forEach((name, spoke) => {
      const angle = (spoke * 360) / this.spokes.length;
      canvas.drawLine(center, projection.toPoint(angle, range.max), 1, line);
      const tip = outside.toPoint(angle, range.max);
      const width = name.length * labelSize * 0.55;
      let x = angle > 0 && angle < 180 ? tip.x : tip.x - width;
      if (angle === 0 || angle === 180) {
        x = tip.x - width / 2;
      }
      canvas.drawText(name, x, tip.y + (angle > 90 && angle < 270 ? labelSize : 4), labelSize, canvas.colors.text);
    });
  }
}

/** Zooms the radial axis with the wheel: the middle stays, the outer circle moves. */
export class RadialZoomModifier extends ChartModifier {
  /** The change of the range per wheel step; 1.2 by default. */
  factorPerStep = 1.2;

  /** @param radialAxis - The radial axis; the Y axis of the first series when left out. */
  constructor(private readonly radialAxis?: Axis) {
    super(ZoomPanModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onWheel} */
  override onWheel(input: WheelInputEvent): ModifierResult {
    const interaction = this.interaction;
    const axis = this.radialAxis ?? interaction?.chart.series[0]?.yAxis;
    if (!interaction || !axis || input.delta.y === 0 || !interaction.hitPane(input.position)) {
      return 'ignored';
    }
    const factor = this.factorPerStep ** -input.delta.y;
    interaction.run(() => {
      const range = axis.visibleRange;
      axis.visibleRange = new DoubleRange(range.min, range.min + (range.max - range.min) * factor);
    });
    return 'handled';
  }
}

/** A chart with polar coordinates, its axes hidden, and the axes of angle and radius. */
export interface PolarChart {
  /** The chart. */
  readonly chart: ChartSurface;
  /** The hidden axis of the angle, 0 to 360 degrees. */
  readonly angle: NumericAxis;
  /** The hidden radial axis. */
  readonly radial: NumericAxis;
}

/**
 * Creates a chart with polar coordinates: hidden axes for the angle from 0 to 360 degrees and for the radius, and a
 * grid of rings and spokes, named after the degrees unless names are given.
 */
export function createPolarChart(textEngine: TextEngine, range: DoubleRange, spokes?: readonly string[]): PolarChart {
  const angle = new NumericAxis('angle', 'bottom');
  angle.visibleRange = new DoubleRange(0, 360);
  angle.isHidden = true;
  const radial = new NumericAxis('radial', 'left');
  radial.visibleRange = range;
  radial.isHidden = true;
  const chart = new ChartSurface([angle], [{ axes: [radial] }], textEngine);
  chart.addOverlay(new PolarGridOverlay(radial, spokes ?? degrees));
  return { chart, angle, radial };
}

/**
 * Describes a polar chart: hidden axes for the angle from 0 to 360 degrees and the radius from 0, the series, a grid
 * of rings and spokes, and zooming around the middle with the wheel.
 * @param builder - The description.
 * @param radius - The value at the outer ring.
 * @param spokes - The names of the spokes, evenly around the circle, such as degrees or the criteria of a radar.
 * @param series - Creates the series, a `PolarSeries`, from the axes.
 */
export function polar(
  builder: ChartBuilder,
  radius: number,
  spokes: readonly string[],
  series: (x: Axis, y: Axis) => ChartSeries,
): ChartBuilder {
  return builder
    .xAxis((a) => a.numeric('angle').range(0, 360).hidden())
    .yAxis((a) => a.numeric('radial').range(0, radius).hidden())
    .addSeries(series, 'angle', 'radial')
    .addOverlay((chart) => {
      const first = chart.series[0];
      if (!first) {
        throw new Error('A polar chart needs its series.');
      }
      return new PolarGridOverlay(first.yAxis, spokes);
    })
    .addModifier(() => new RadialZoomModifier());
}
