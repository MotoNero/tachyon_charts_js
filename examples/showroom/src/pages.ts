// The pages of the showroom, written as the pages of the .NET showroom (Examples/ChartTypes/*Page.cs and
// Examples/Common/ChartTypeData.cs): each one describes its chart with the fluent API, in the theme Instrument.
import {
  AreaSeries,
  BandSeries,
  BarSeries,
  DataSource,
  FifoDataSource,
  ChartBuilder,
  findBuiltInTheme,
  linkDataSource,
  parseThemeColor,
  resolveTheme,
  StackedAreaSeries,
  type ThemeDocument,
} from '@tachyon-charts/core';
import { ColumnFile, ColumnLineSeries, LargeColumn, opfsSource } from '@tachyon-charts/large-data';
import { t } from './texts';

/**
 * A page: its name in the navigation, its group, the hint for the input and the chart. Names, groups and hints are the
 * English keys of texts.ts; `configure` gets the theme the chart is shown in.
 */
/** What a running page keeps: a worker or a timer to stop when the next page shows, and a line for the hint. */
export interface PageRun {
  dispose(): void;
  readonly status?: string;
}

export interface Page {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly hint: string;
  configure(builder: ChartBuilder, theme: ThemeDocument): void;
  /** Starts what the page runs beside its chart, after `configure`. */
  start?(): PageRun;
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

// A worker writes four million points while the chart draws: through shared memory on cross-origin isolated pages,
// else in transferred blocks.
// 24 charts in a grid, each streaming 100 000 points per second into its own ring: they share one device and one
// frame loop, and their frames go to the render worker together.
// 250 million values (1 GB) from the origin private file system: the first visit writes the file in a worker, the
// pyramid gives a coarse picture at once and refines; five spikes are never lost, however far out the view.
const largeFile = { path: 'showroom/line-250m.tcol', count: 250_000_000 };

async function hasLargeFile(): Promise<boolean> {
  try {
    const file = await ColumnFile.open(await opfsSource(largeFile.path));
    return file.rows === largeFile.count;
  } catch {
    return false;
  }
}

function lineFromALargeFile(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all';
  return {
    id: 'line-from-a-large-file',
    name: 'Line from a large file',
    group: 'Lines',
    hint,
    configure: (c) => {
      c.theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      // Asked through a function, so that the checks after each await see a stop that came meanwhile.
      const run = { stopped: false };
      const stopped = (): boolean => run.stopped;
      let column: LargeColumn | undefined;
      let worker: Worker | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = (text: string): void => {
        const element = document.querySelector('#hint');
        if (element) {
          element.textContent = `${t(hint)} | ${text}`;
        }
      };
      const percent = (share: number): string => `${String(Math.floor(share * 100))} %`;
      void (async () => {
        if (!(await hasLargeFile())) {
          worker = new Worker(new URL('./large-file-worker.ts', import.meta.url), { type: 'module' });
          const writing = worker;
          await new Promise<void>((resolve) => {
            writing.addEventListener('message', (event: MessageEvent<{ progress?: number; done?: boolean }>) => {
              if (event.data.done) {
                resolve();
              } else {
                say(`${t('The first visit writes a test file of 1 GB')} ${percent(event.data.progress ?? 0)}`);
              }
            });
            writing.postMessage(largeFile);
          });
          writing.terminate();
        }
        if (stopped()) {
          return;
        }
        const opened = await LargeColumn.open({ opfs: largeFile.path });
        if (stopped()) {
          opened.dispose();
          return;
        }
        column = opened;
        const status = (): void => {
          say(
            opened.isComplete
              ? `${t('250 million values, five spikes among them')} | ${t('Pyramid')} ${String(Math.round(opened.buildMilliseconds))} ms${opened.isFromCache ? ` (${t('kept from before')})` : ''}`
              : `${t('Refining')} ${percent(opened.progress)}`,
          );
        };
        opened.onChange(status);
        status();
        if (chart) {
          chart.chart = new ChartBuilder()
            .theme(instrument)
            .xAxis((a) => a.numeric('x').title(t('Time in s')).autoRange())
            .yAxis((a) => a.numeric('y').autoRange())
            .addSeries((x, y) => {
              const series = new ColumnLineSeries(opened, x, y);
              series.name = t('Signal');
              return series;
            });
        }
      })();
      return {
        dispose: () => {
          run.stopped = true;
          worker?.terminate();
          column?.dispose();
        },
      };
    },
  };
}

function manyCharts(): Page {
  return {
    id: 'many-charts',
    name: 'Many charts',
    group: 'Lines',
    hint: 'Every chart streams 100 000 points per second | Wheel: zoom | Drag: pan | Double click: all',
    configure: (c) => {
      c.theme(instrument).xAxis().yAxis();
    },
    start: () => {
      const main = document.querySelector<HTMLElement>('#chart');
      const theme = main?.getAttribute('theme');
      const grid = document.createElement('div');
      grid.className = 'grid';
      const sources: FifoDataSource[] = [];
      for (let i = 0; i < 24; i++) {
        const chart = document.createElement('tachyon-chart');
        if (theme) {
          chart.setAttribute('theme', theme);
        }
        const data = new FifoDataSource(100_000);
        sources.push(data);
        chart.chart = new ChartBuilder()
          .theme(instrument)
          .xAxis((a) => a.numeric('x').autoRange())
          .yAxis((a) => a.numeric('y').range(-1.6, 1.6))
          .addLine(data, (s) => s.name(`${t('Signal')} ${String(i + 1)}`));
        grid.append(chart);
      }
      main?.after(grid);
      if (main) {
        main.hidden = true;
      }
      const x = new Float64Array(4000);
      const y = new Float64Array(4000);
      let written = 0;
      let last = performance.now();
      let frame = requestAnimationFrame(function feed(now) {
        const n = Math.min(4000, Math.round(((now - last) / 1000) * 100_000));
        last = now;
        for (let s = 0; s < sources.length; s++) {
          for (let i = 0; i < n; i++) {
            const time = (written + i) / 100_000;
            x[i] = time;
            y[i] =
              Math.sin(time * (1 + s * 0.15) + s) + 0.25 * Math.sin(time * 41 + s * 3) + (Math.random() - 0.5) * 0.2;
          }
          sources[s]?.append(x.subarray(0, n), y.subarray(0, n));
        }
        written += n;
        frame = requestAnimationFrame(feed);
      });
      return {
        dispose: () => {
          cancelAnimationFrame(frame);
          grid.remove();
          if (main) {
            main.hidden = false;
          }
        },
      };
    },
  };
}

function dataFromAWorker(): Page {
  let data = new DataSource();
  return {
    id: 'data-from-a-worker',
    name: 'Data from a worker',
    group: 'Lines',
    hint: points,
    configure: (c) => {
      data = new DataSource();
      c.theme(instrument)
        .xAxis((a) => a.numeric('x').autoRange())
        .yAxis((a) => a.numeric('y').autoRange())
        .addLine(data, (s) => s.name(t('Signal')));
    },
    start: () => {
      const worker = new Worker(new URL('./stream-worker.ts', import.meta.url), { type: 'module' });
      const path = linkDataSource(data, worker, { capacity: 4_000_000 });
      return {
        dispose: () => {
          worker.terminate();
        },
        status: path === 'shared' ? 'Shared memory' : 'Transferred blocks',
      };
    },
  };
}

/** All pages, in the order of the navigation. */
export const pages: readonly Page[] = [
  {
    id: 'line',
    name: 'Line',
    group: 'Lines',
    hint: points,
    configure: (c) => numeric(c, 0, 10, -1.5, 1.5).addLine(sample(Math.sin), (s) => s.name(t('Sine')).thickness(2)),
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
      numeric(c, 0, 10, -1.5, 2.5).addLine(data, (s) => s.name(t('Noisy wave')));
    },
  },
  dataFromAWorker(),
  manyCharts(),
  lineFromALargeFile(),
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
          a.category(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(t), 'x'),
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
        .title(t('Temperature in Berlin, over the change to summer time'))
        .xAxis((a) => a.dateTime('time').title('Europe/Berlin'))
        .yAxis((a) => a.numeric('y').title('°C').autoRange())
        .addLine(temperatures(), (s) => s.name(t('Temperature')).thickness(2)),
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
    // As the theme scene of the .NET gallery: the line and the markers in the first two colors of the palette.
    configure: (c, theme) => {
      const resolved = resolveTheme(theme);
      const [first = '#50AAF0', second = '#F0825A'] = resolved.palette ?? [];
      c.title(t('Theme preview'))
        .xAxis((a) => a.numeric('x').range(0, 10).title(t('Time')))
        .yAxis((a) => a.numeric('y').range(-1.5, 1.5).title(t('Signal')))
        .addLine(
          sample((x) => Math.sin(x * 1.4) * 0.9, 180),
          (s) => s.name(t('Line')).stroke(parseThemeColor(first)).thickness(2.5),
        )
        .addScatter(
          sample((x) => Math.cos(x * 1.4) * 0.75, 18),
          (s) =>
            s
              .name(t('Markers'))
              .fill(parseThemeColor(second))
              .border(parseThemeColor(resolved.surface?.background ?? '#000000'), 1.5)
              .size(9),
        );
    },
  },
];
