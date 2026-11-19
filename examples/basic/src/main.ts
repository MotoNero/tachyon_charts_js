// A line chart with two series and a million points, drawn on WebGPU and drawn again when the window changes size or
// the view moves: the wheel zooms, dragging pans, control and drag zooms into a rectangle, dragging an axis moves it,
// the keys move and zoom, a double click shows all data again, and a crosshair and a tooltip follow the pointer.
import {
  AxisDragModifier,
  ChartInteraction,
  ChartSurface,
  CrosshairModifier,
  DataSource,
  KeyboardNavigationModifier,
  LineSeries,
  ModifierPipeline,
  NumericAxis,
  rgba,
  RubberBandZoomModifier,
  TextEngine,
  TooltipModifier,
  version,
  ZoomPanModifier,
} from '@tachyon-charts/core';
import { bindChartInput, watchPreferredTheme } from '@tachyon-charts/element';
import { createWebGpuDevice } from '@tachyon-charts/render-webgpu';
import robotoUrl from '../../../shared/fonts/Roboto-Regular.ttf?url';

const status = document.querySelector<HTMLElement>('#status');
const canvas = document.querySelector('canvas');
const device = await createWebGpuDevice();
if (!device || !canvas) {
  if (status) {
    status.textContent = 'This browser has no WebGPU.';
  }
} else {
  const engine = new TextEngine(await (await fetch(robotoUrl)).arrayBuffer());
  const x = new NumericAxis('x', 'bottom');
  x.title = 'Time';
  const y = new NumericAxis('y', 'left');
  const chart = new ChartSurface([x], [{ axes: [y] }], engine);
  chart.title = `Tachyon Charts ${version}`;

  // A million points of a noisy wave: the line keeps every peak, reduced to the extremes per pixel column.
  const count = 1_000_000;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const t = i / 100_000;
    xs[i] = t;
    ys[i] = Math.sin(t * 1.3) + 0.15 * Math.sin(i / 7) + (i === 654_321 ? 1.5 : 0);
  }
  const noisy = new DataSource(count);
  noisy.append(xs, ys);
  const wave = new LineSeries(noisy, x, y);
  wave.color = rgba(80, 170, 240);

  const smooth = new DataSource(200);
  for (let i = 0; i < 200; i++) {
    smooth.append(i / 20, 0.9 * Math.cos((i / 20) * 1.3));
  }
  const line = new LineSeries(smooth, x, y);
  line.color = rgba(240, 130, 90);
  line.thickness = 3;
  chart.addSeries(wave);
  chart.addSeries(line);
  wave.name = 'Noisy wave';
  line.name = 'Smooth wave';

  // The interactions, as in the .NET version.
  const pipeline = new ModifierPipeline();
  pipeline.interaction = new ChartInteraction(chart);
  for (const modifier of [
    new ZoomPanModifier(),
    new RubberBandZoomModifier(),
    new AxisDragModifier(),
    new KeyboardNavigationModifier(),
  ]) {
    pipeline.add(modifier);
  }
  const crosshair = new CrosshairModifier();
  crosshair.showsValues = true;
  pipeline.add(crosshair);
  const tooltip = new TooltipModifier();
  const tip = document.querySelector<HTMLElement>('#tooltip');
  tooltip.onChanged = (data) => {
    if (!tip) {
      return;
    }
    tip.hidden = !data;
    if (data) {
      tip.textContent = `${data.seriesName ?? ''}  x ${data.xText}  y ${data.yText}`;
      tip.style.left = `${String(data.position.x + 16)}px`;
      tip.style.top = `${String(data.position.y + 16)}px`;
    }
  };
  pipeline.add(tooltip);
  bindChartInput(canvas, pipeline);
  // Light or dark after the system, switching while the page is open.
  watchPreferredTheme((theme) => {
    chart.theme = theme;
    document.body.style.background = theme.surface?.background ?? '';
  });

  const size = (): { width: number; height: number } => ({
    width: Math.max(Math.round(canvas.clientWidth * devicePixelRatio), 1),
    height: Math.max(Math.round(canvas.clientHeight * devicePixelRatio), 1),
  });
  const target = device.createSurfaceTarget({ kind: 'canvas', canvas }, size(), devicePixelRatio);
  const frame = (): void => {
    const now = size();
    if (now.width !== target.size.width || now.height !== target.size.height || target.dpiScale !== devicePixelRatio) {
      target.resize(now, devicePixelRatio);
    }
    if (chart.hasChanges(target)) {
      chart.render(device, target);
      // The number of frames drawn, for whoever waits for the first one, such as a test.
      canvas.dataset.frames = String(chart.frameCount);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
