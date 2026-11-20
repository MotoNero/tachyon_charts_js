// Two charts as <tachyon-chart> elements in a Vite application: a line chart described with the fluent API, which
// follows light and dark of the system, and bars in the light theme. Each element follows its size and the pixel ratio
// of the screen and frees its GPU resources when it leaves the page.
import { BarSeries, ChartBuilder, DataSource } from '@tachyon-charts/core';
import { defineTachyonChart, type TachyonChartElement } from '@tachyon-charts/element';

defineTachyonChart();

const sine = new DataSource();
const cosine = new DataSource();
for (let i = 0; i <= 400; i++) {
  const t = i / 40;
  sine.append(t, Math.sin(t * 1.3));
  cosine.append(t, 0.7 * Math.cos(t * 0.9));
}

const waves = document.querySelector<TachyonChartElement>('#waves');
if (waves) {
  waves.chart = new ChartBuilder()
    .title('Waves')
    .xAxis((a) => a.title('Time').autoRange())
    .yAxis((a) => a.autoRange())
    .addLine(sine, (l) => l.name('Sine').thickness(2))
    .addLine(cosine, (l) => l.name('Cosine').stroke({ r: 240, g: 130, b: 90, a: 255 }).thickness(2));
}

const bars = document.querySelector<TachyonChartElement>('#bars');
if (bars) {
  bars.chart = new ChartBuilder()
    .title('Bars')
    .xAxis((a) => a.range(-0.5, 5.5))
    .yAxis((a) => a.range(0, 14))
    .addSeries((x, y) => {
      const series = new BarSeries(
        [
          [3, 5, 2, 6, 4, 7],
          [2, 1, 4, 3, 5, 2],
          [1, 3, 2, 2, 2, 3],
        ],
        x,
        y,
      );
      series.layout = 'stacked';
      return series;
    });
}

// The point under the pointer, as the elements report it.
const tip = document.querySelector<HTMLElement>('#tip');
for (const chart of [waves, bars]) {
  chart?.addEventListener('tachyon-tooltip', (event) => {
    const data = (
      event as CustomEvent<
        { seriesName?: string; xText: string; yText: string; position: { x: number; y: number } } | undefined
      >
    ).detail;
    if (!tip) {
      return;
    }
    tip.hidden = !data;
    if (data) {
      const bounds = chart.getBoundingClientRect();
      tip.textContent = `${data.seriesName ?? ''}  x ${data.xText}  y ${data.yText}`;
      tip.style.left = `${String(bounds.left + data.position.x + 14)}px`;
      tip.style.top = `${String(bounds.top + data.position.y + 14)}px`;
    }
  });
}
