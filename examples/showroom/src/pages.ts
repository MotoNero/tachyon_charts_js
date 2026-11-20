// The pages of the showroom, written as the pages of the .NET showroom (Examples/ChartTypes/*Page.cs and
// Examples/Common/ChartTypeData.cs): each one describes its chart with the fluent API, in the theme Instrument.
import {
  AreaSeries,
  BandSeries,
  BarSeries,
  DataSource,
  findBuiltInTheme,
  StackedAreaSeries,
  type ChartBuilder,
  type ThemeDocument,
} from '@tachyon-charts/core';

/** A page: its name in the navigation, its group, the hint for the input and the chart. */
export interface Page {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly hint: string;
  configure(builder: ChartBuilder): void;
}

const plain = 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all';
const points = `${plain} | Pointer: values`;
const bars = [
  [3, 5, 2, 6, 4, 7],
  [2, 1, 4, 3, 5, 2],
  [1, 3, 2, 2, 2, 3],
];

const instrument = findBuiltInTheme('instrument') as ThemeDocument;

/** Points of a curve at `count` places from 0 to `length`. */
function sample(curve: (x: number) => number, count = 300, length = 10): DataSource {
  const data = new DataSource(count);
  for (let i = 0; i < count; i++) {
    const x = (i * length) / (count - 1);
    data.append(x, curve(x));
  }
  return data;
}

function cloud(): DataSource {
  const data = new DataSource(40);
  for (let i = 0; i < 40; i++) {
    data.append(0.5 + 9 * ((i * 0.618) % 1), 0.5 + 9 * ((i * 0.7549) % 1));
  }
  return data;
}

function numeric(c: ChartBuilder, left: number, right: number, bottom: number, top: number): ChartBuilder {
  return c
    .theme(instrument)
    .xAxis((a) => a.numeric('x').range(left, right))
    .yAxis((a) => a.numeric('y').range(bottom, top));
}

// Two weeks in Berlin over the change to summer time, in milliseconds as Date gives them.
function temperatures(): DataSource {
  const start = Date.UTC(2026, 2, 22);
  const data = new DataSource();
  for (let hour = 0; hour <= 14 * 24; hour++) {
    const time = start + hour * 3_600_000;
    data.append(time, 8 + 6 * Math.sin(((hour - 9) / 24) * Math.PI * 2) + hour / 60);
  }
  return data;
}

function curve(): DataSource {
  const data = new DataSource(1001);
  for (let i = 0; i <= 1000; i++) {
    const x = -10 + i * 0.02;
    data.append(x, (x * Math.sin(x)) / 2 - 1);
  }
  return data;
}

/** All pages, in the order of the navigation. */
export const pages: readonly Page[] = [
  {
    id: 'line',
    name: 'Line',
    group: 'Lines',
    hint: points,
    configure: (c) => numeric(c, 0, 10, -1.5, 1.5).addLine(sample(Math.sin), (s) => s.name('Sine').thickness(2)),
  },
  {
    id: 'spline',
    name: 'Spline',
    group: 'Lines',
    hint: points,
    configure: (c) => numeric(c, 0, 10, -1.5, 1.5).addLine(sample(Math.sin, 14), (s) => s.spline().thickness(2)),
  },
  {
    id: 'step-line',
    name: 'Step line',
    group: 'Lines',
    hint: points,
    configure: (c) =>
      numeric(c, 0, 10, -1.5, 1.5).addLine(
        sample((t) => Math.round(Math.sin(t) * 3) / 3, 60),
        (s) => s.step().thickness(2),
      ),
  },
  {
    id: 'million-points',
    name: 'A million points',
    group: 'Lines',
    hint: points,
    configure: (c) => {
      const count = 1_000_000;
      const data = new DataSource(count);
      const x = new Float64Array(count);
      const y = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        x[i] = i / 100_000;
        y[i] = Math.sin((i / 100_000) * 1.3) + 0.15 * Math.sin(i / 7) + (i === 654_321 ? 1.5 : 0);
      }
      data.append(x, y);
      numeric(c, 0, 10, -1.5, 2.5).addLine(data, (s) => s.name('Noisy wave'));
    },
  },
  {
    id: 'scatter',
    name: 'Scatter',
    group: 'Points and areas',
    hint: points,
    configure: (c) => numeric(c, 0, 10, 0, 10).addScatter(cloud(), (s) => s.size(6)),
  },
  {
    id: 'area',
    name: 'Area',
    group: 'Points and areas',
    hint: plain,
    configure: (c) =>
      numeric(c, 0, 10, -1, 3).addSeries(
        (x, y) =>
          new AreaSeries(
            sample((t) => 1.2 + Math.sin(t)),
            x,
            y,
          ),
      ),
  },
  {
    id: 'stacked-area',
    name: 'Stacked area',
    group: 'Points and areas',
    hint: plain,
    configure: (c) =>
      numeric(c, 0, 10, 0, 9).addSeries(
        (x, y) =>
          new StackedAreaSeries(
            [
              sample((t) => 2 + Math.sin(t)),
              sample((t) => 2 + Math.cos(t * 0.7)),
              sample((t) => 1.5 + 0.5 * Math.sin(t * 2)),
            ],
            x,
            y,
          ),
      ),
  },
  {
    id: 'band',
    name: 'Band',
    group: 'Points and areas',
    hint: plain,
    configure: (c) =>
      numeric(c, 0, 10, -1.5, 1.5).addSeries(
        (x, y) =>
          new BandSeries(
            sample(Math.sin),
            sample((t) => 0.8 * Math.cos(t * 0.8)),
            x,
            y,
          ),
      ),
  },
  {
    id: 'bars',
    name: 'Bars',
    group: 'Bars',
    hint: plain,
    configure: (c) => numeric(c, -0.5, 5.5, 0, 8).addSeries((x, y) => new BarSeries(bars, x, y)),
  },
  {
    id: 'stacked-bars',
    name: 'Stacked bars',
    group: 'Bars',
    hint: plain,
    configure: (c) =>
      numeric(c, -0.5, 5.5, 0, 14).addSeries((x, y) => {
        const series = new BarSeries(bars, x, y);
        series.layout = 'stacked';
        return series;
      }),
  },
  {
    id: 'horizontal-bars',
    name: 'Horizontal bars',
    group: 'Bars',
    hint: plain,
    configure: (c) =>
      numeric(c, 0, 8, -0.5, 5.5).addSeries((x, y) => {
        const series = new BarSeries(bars, x, y);
        series.isHorizontal = true;
        return series;
      }),
  },
  {
    id: 'logarithmic-axis',
    name: 'Logarithmic axis',
    group: 'Axes',
    hint: points,
    configure: (c) =>
      c
        .theme(instrument)
        .xAxis((a) => a.numeric('x').range(0, 10))
        .yAxis((a) => a.log('y').range(0.01, 10000))
        .addLine(
          sample((t) => 5000 * Math.exp(-t * 1.2)),
          (s) => s.thickness(2),
        ),
  },
  {
    id: 'categories',
    name: 'Categories',
    group: 'Axes',
    hint: plain,
    configure: (c) =>
      c
        .theme(instrument)
        .xAxis((a) =>
          a.category(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], 'x'),
        )
        .yAxis((a) => a.numeric('y').range(0, 10))
        .addSeries((x, y) => new BarSeries([[3, 4, 5, 6, 7, 8, 9, 8, 7, 6, 5, 4]], x, y)),
  },
  {
    id: 'time-axis',
    name: 'Time axis',
    group: 'Axes',
    hint: `${points} | Zoom in: days, hours, minutes`,
    configure: (c) =>
      c
        .theme(instrument)
        .title('Temperature in Berlin, over the change to summer time')
        .xAxis((a) => a.dateTime('time').title('Europe/Berlin'))
        .yAxis((a) => a.numeric('y').title('°C').autoRange())
        .addLine(temperatures(), (s) => s.name('Temperature').thickness(2)),
  },
  {
    id: 'axes-in-the-origin',
    name: 'Axes in the origin',
    group: 'Axes',
    hint: 'Wheel: zoom | Drag: pan, the axes stay at zero or at the nearest edge | Double click: all',
    configure: (c) =>
      c
        .title('y = x · sin(x) / 2 − 1')
        .xAxis((a) => a.numeric('x').range(-10, 10).crossesAt(0))
        .yAxis((a) => a.numeric('y').range(-6, 6).crossesAt(0))
        .addLine(curve(), (s) => s.name('y').thickness(2)),
  },
  {
    id: 'themes',
    name: 'Themes',
    group: 'Look',
    hint: 'Choose a theme at the top | Pointer: values',
    configure: (c) =>
      c
        .title('Theme preview')
        .xAxis((a) => a.numeric('x').range(0, 10).title('Time'))
        .yAxis((a) => a.numeric('y').range(-1.5, 1.5).title('Signal'))
        .addLine(
          sample((t) => Math.sin(t * 1.4) * 0.9, 180),
          (s) => s.name('Line').thickness(2.5),
        )
        .addScatter(
          sample((t) => Math.cos(t * 1.4) * 0.75, 18),
          (s) => s.name('Markers').size(9),
        ),
  },
];
