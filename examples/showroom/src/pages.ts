// The pages of the showroom, written as the pages of the .NET showroom (Examples/ChartTypes/*Page.cs and
// Examples/Common/ChartTypeData.cs): each one describes its chart with the fluent API, in the theme Instrument.
import {
  AreaSeries,
  BandSeries,
  BarSeries,
  ColorAxis,
  ContourSeries,
  PolarGridOverlay,
  FrequencyMask,
  networkAnalyzer,
  NetworkDisplay,
  NetworkMarkerModifier,
  CandleData,
  candles,
  CrosshairModifier,
  oscilloscope,
  pie,
  ParallelAxesModifier,
  ParallelAxesOverlay,
  ParallelCoordinatesSeries,
  PolarSeries,
  ScopeDisplay,
  ScopeTrigger,
  spectrum,
  sweep,
  volume,
  volumeProfile,
  SweepData,
  SpectrumDisplay,
  SmithGridOverlay,
  SmithMarkerModifier,
  SmithMarkerOverlay,
  SmithSeries,
  TernaryGridOverlay,
  TernarySeries,
  ZoomPanModifier,
  HeatmapData,
  HeatmapSeries,
  SpectrogramData,
  SpectrogramSeries,
  BoxPlotSeries,
  computeHistogram,
  SolidFill,
  ViolinSeries,
  Colormap,
  DoubleRange,
  RasterSeries,
  DataSource,
  TimeGapMap,
  TooltipModifier,
  DigitalSeries,
  DigitalTransitions,
  FifoDataSource,
  ChartBuilder,
  rgba,
  findBuiltInTheme,
  gantt,
  VerticalLineAnnotation,
  TextAnnotation,
  LineAnnotation,
  HorizontalLineAnnotation,
  BoxAnnotation,
  BandAnnotation,
  AnnotationEditModifier,
  polygons,
  PolygonRing,
  Polygon,
  GanttData,
  linkDataSource,
  parseThemeColor,
  resolveTheme,
  StackedAreaSeries,
  type DigitalSource,
  type LimitLine,
  type SweepMode,
  type Rgba8,
  type DrawingPoint,
  Drawing,
  drawings,
  KeyboardNavigationModifier,
  RubberBandZoomModifier,
  AxisDragModifier,
  LegendModifier,
  RefiningOverlay,
  LoadingOverlay,
  SelectionModifier,
  MeasureCursorModifier,
  OverviewModifier,
  RolloverModifier,
  type ThemeDocument,
  type Axis,
  type ChartSurface,
} from '@tachyon-charts/core';
import {
  Bars3D,
  Bubbles3D,
  evenContours,
  Line3D,
  ClipPlane3D,
  Mesh3D,
  Pie3D,
  Point3D,
  Points3D,
  Scatter3D,
  scene3D,
  Surface3D,
  type Vertex3D,
  Waterfall3D,
} from '@tachyon-charts/3d';
import {
  BitColumn,
  BitFileWriter,
  ColumnFile,
  ColumnFileWriter,
  ColumnLineSeries,
  ColumnRecorder,
  FileRasterSeries,
  LargeRaster,
  PointDensitySeries,
  PointTiles,
  RasterFileWriter,
  csvToColumnFile,
  LargeColumn,
  opfsFile,
  opfsSource,
  writableSink,
} from '@tachyon-charts/large-data';
import { createAntenna, createKnot, measuredMap, pipeModel } from './models3d';
import { t } from './texts';

/**
 * A page: its name in the navigation, its group, the hint for the input and the chart. Names, groups and hints are the
 * English keys of texts.ts; `configure` gets the theme the chart is shown in.
 */
/** What a running page keeps: a worker or a timer to stop when the next page shows, and a line for the hint. */
// Writes the hint of a page and a status after it.
// The share refined of the series that start coarse, in the language of the page.
function refining(chart: ChartSurface): RefiningOverlay {
  const overlay = new RefiningOverlay(chart);
  overlay.format = (share) => `${t('Refining')} ${String(Math.floor(share * 100))} %`;
  return overlay;
}

function sayer(hint: string, loading?: LoadingOverlay): (text: string, share?: number) => void {
  return (text, share) => {
    const shown = share === undefined ? text : `${text} ${String(Math.floor(share * 100))} %`;
    const element = document.querySelector('#hint');
    if (element) {
      element.textContent = `${t(hint)} | ${shown}`;
    }
    // While the chart waits for its data it shows the same in the middle of the plot, with a bar where the share is
    // known; the chart with the data replaces it.
    loading?.show(text, share);
  };
}

// How long a build took, or that it was kept from before.
function took(opened: { isFromCache: boolean; buildMilliseconds: number }): string {
  return opened.isFromCache ? t('kept from before') : `${String(Math.round(opened.buildMilliseconds))} ms`;
}

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

// The radial axis of a polar chart: the axis of its only pane.
function radialAxis(chart: ChartSurface): Axis {
  return chart.panes[0]?.axes[0] as Axis;
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

// A CSV file converted into a column file in parse workers, then drawn through its pyramid: a sample of 200 MB the
// first visit writes, or a file of one's own.
const sampleCsv = { path: 'showroom/sample.csv', size: 200_000_000 };

async function writeSampleCsv(progress: (share: number) => void): Promise<void> {
  const handle = await opfsFile(sampleCsv.path, true);
  if ((await handle.getFile()).size >= sampleCsv.size) {
    return;
  }
  const stream = await handle.createWritable();
  await stream.write('time,value\n');
  let level = 0;
  for (let size = 0, row = 0; size < sampleCsv.size;) {
    let part = '';
    for (let i = 0; i < 100_000; i++, row++) {
      level += (Math.random() - 0.5) * 0.01;
      const value = Math.sin(row / 400_000) + 0.2 * Math.sin(row / 977) + level;
      part += `${(row / 1000).toFixed(3)},${value.toFixed(5)}\n`;
    }
    size += part.length;
    await stream.write(part);
    progress(size / sampleCsv.size);
  }
  await stream.close();
}

const pieValues = [32, 18, 15, 14, 9, 6, 3, 1.5, 1, 0.5];
const pieNames = ['Wind', 'Solar', 'Gas', 'Coal', 'Biomass', 'Hydro', 'Nuclear', 'Oil', 'Other', 'Geothermal'];

// Three temperatures arriving live, each with a plate of its newest value at the axis; plates that meet move apart,
// as the last value page of the .NET showroom.
function lastValuePage(): Page {
  const names = ['Inlet', 'Core', 'Outlet'];
  const colors: Rgba8[] = [
    { r: 76, g: 201, b: 240, a: 255 },
    { r: 255, g: 190, b: 11, a: 255 },
    { r: 247, g: 37, b: 133, a: 255 },
  ];
  // Three slow waves around 60 °C that cross now and then.
  const value = (line: number, t: number): number =>
    60 + 8 * Math.sin(t * 0.21 + line * 2.1) + 2 * Math.sin(t * 1.7 + line) + (line - 1);
  const lines = names.map(() => new FifoDataSource(3000));
  // The time goes on where it stopped when the page shows again, so that the lines stay sorted.
  let written = 0;
  return {
    id: 'last-value',
    name: 'Last value at the axis',
    group: 'Lines',
    hint: 'The marks at the axis show the newest value of each line and move apart when they meet | Wheel: zoom | Drag: pan',
    configure: (c) => {
      c.title(t('Temperatures, live'))
        .xAxis((a) => a.numeric('t').title(t('Time in s')).autoRange())
        .yAxis((a) => a.numeric('temperature').title(t('Temperature in °C')).range(45, 75).position('right'));
      lines.forEach((source, i) => {
        c.addLine(source, (s) =>
          s
            .name(t(names[i] ?? ''))
            .stroke(colors[i] as Rgba8)
            .thickness(1.5)
            .lastValue(),
        );
      });
      c.addModifier(() => new ZoomPanModifier());
    },
    start: () => {
      const begin = performance.now();
      const offset = written;
      const timer = setInterval(() => {
        const due = offset + Math.trunc(((performance.now() - begin) / 1000) * 50);
        for (; written < due; written++) {
          const time = written * 0.02;
          lines.forEach((source, line) => {
            source.append(time, value(line, time));
          });
        }
      }, 20);
      return {
        dispose: () => {
          clearInterval(timer);
        },
      };
    },
  };
}

// Bars and a target line with their values beside them; labels that would overlap are left out.
function valueLabelsPage(): Page {
  const target = new DataSource(8);
  for (let i = 0; i < 8; i++) {
    target.append(i, 52 + 4 * i);
  }
  return {
    id: 'value-labels',
    name: 'Values at points',
    group: 'Bars',
    hint: 'Wheel: zoom | Drag: pan | Labels that would overlap are left out',
    configure: (c) => {
      c.title(t('Sales per quarter'))
        .xAxis((a) => a.numeric('quarter').title(t('Quarter')).range(-0.6, 7.6))
        .yAxis((a) => a.numeric('sales').title(t('Sales in k€')).range(0, 110))
        .addSeries(
          (x, y) => {
            const bars = new BarSeries(
              [
                [48, 55, 61, 58, 70, 76, 81, 90],
                [35, 38, 42.5, 47, 44, 52, 57.25, 63],
              ],
              x,
              y,
            );
            bars.name = t('North and South');
            bars.showsValues = true;
            return bars;
          },
          'quarter',
          'sales',
        )
        .addLine(target, (s) => s.name(t('Target')).thickness(2).values())
        .addModifier(() => new ZoomPanModifier());
    },
  };
}

// Three lines with a line at the pointer and the value of each line there, labels stacked where they meet.
function rolloverPage(): Page {
  const wave = (fn: (x: number) => number): DataSource => {
    const source = new DataSource(240);
    for (let i = 0; i < 240; i++) {
      const x = (i * 10) / 239;
      source.append(x, fn(x));
    }
    return source;
  };
  return {
    id: 'rollover',
    name: 'Rollover',
    group: 'Interactive',
    hint: 'Pointer: the value of every line at its X | Wheel: zoom | Drag: pan',
    configure: (c) => {
      c.title(t('Rollover'))
        .xAxis((a) => a.numeric('x').title(t('Time in s')).range(0, 10))
        .yAxis((a) => a.numeric('y').range(-1.5, 1.5))
        .addLine(
          wave((x) => 0.9 * Math.sin(x * 1.3)),
          (s) => s.name(t('Pressure')).stroke({ r: 80, g: 170, b: 240, a: 255 }).thickness(2),
        )
        .addLine(
          wave((x) => 0.9 * Math.sin(x * 1.3) + 0.05),
          (s) => s.name(t('Set point')).stroke({ r: 110, g: 210, b: 130, a: 255 }).thickness(2),
        )
        .addLine(
          wave((x) => 0.6 * Math.cos(x * 0.8)),
          (s) => s.name(t('Temperature')).stroke({ r: 240, g: 130, b: 90, a: 255 }).thickness(2),
        )
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new RolloverModifier());
    },
  };
}

// A live line of 50 000 points per second beside a fixed one, with all interactions of the chart: zooming, panning,
// the rubber band, dragging axes, crosshair, tooltip, legend, keys, selecting points and measuring, as the live chart
// page of the .NET showroom.
function liveChartPage(): Page {
  const perSecond = 50_000;
  const fixed = new DataSource(2000);
  for (let i = 0; i < 2000; i++) {
    const x = i * 0.01;
    fixed.append(x, Math.sin(x) + 0.3 * Math.sin(x * 7));
  }
  const live = new FifoDataSource(perSecond * 20);
  return {
    id: 'live-chart',
    name: 'Live chart (interactive)',
    group: 'Interactive',
    hint: 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Shift+drag: select points | Alt+drag: measure | Double click: all',
    configure: (c) => {
      c.title(t('Live: 50,000 points per second'))
        .xAxis((a) => a.numeric('x').title(t('Time in s')).autoRange())
        .yAxis((a) => a.numeric('y').title(t('Value')).range(-2, 2))
        .addLine(fixed, (s) => s.name(t('Fixed')).stroke({ r: 80, g: 170, b: 240, a: 255 }).thickness(2))
        .addLine(live, (s) => s.name('Live').stroke({ r: 240, g: 130, b: 90, a: 255 }).thickness(1))
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new RubberBandZoomModifier())
        .addModifier(() => new AxisDragModifier())
        .addModifier(() => new CrosshairModifier())
        .addModifier(() => new TooltipModifier())
        .addModifier(() => new LegendModifier())
        .addModifier(() => new KeyboardNavigationModifier())
        .addModifier(() => new SelectionModifier())
        .addModifier(() => new MeasureCursorModifier())
        .group('live-chart');
    },
    start: () => {
      // The overview below shows the whole signal and frames the window of the chart; dragging it moves the window.
      const main = document.querySelector<HTMLElement>('#chart');
      const overview = document.createElement('tachyon-chart');
      const theme = main?.getAttribute('theme');
      if (theme) {
        overview.setAttribute('theme', theme);
      }
      overview.chart = new ChartBuilder()
        .xAxis((a) => a.numeric('x').autoRange())
        .yAxis((a) => a.numeric('y').autoRange())
        .addLine(fixed, (s) => s.stroke({ r: 80, g: 170, b: 240, a: 255 }).thickness(1))
        .addLine(live, (s) => s.stroke({ r: 240, g: 130, b: 90, a: 255 }).thickness(1))
        .addModifier(() => OverviewModifier.of('live-chart'));
      main?.after(overview);
      main?.parentElement?.classList.add('with-overview');
      const x = new Float64Array(500);
      const y = new Float64Array(500);
      const begin = performance.now();
      let written = 0;
      const timer = setInterval(() => {
        // Blocks of 500 points: blocks are much cheaper than single points.
        while (written + x.length <= ((performance.now() - begin) / 1000) * perSecond) {
          for (let i = 0; i < x.length; i++) {
            const time = (written + i) / perSecond;
            x[i] = time;
            y[i] = Math.sin(time * 2) * Math.cos(time * 0.3) + (Math.random() - 0.5) * 0.2;
          }
          live.append(x, y);
          written += x.length;
        }
      }, 10);
      return {
        dispose: () => {
          clearInterval(timer);
          overview.remove();
          main?.parentElement?.classList.remove('with-overview');
        },
      };
    },
  };
}

// Three charts of one group with very different values: zooming one zooms all, the plots line up although the
// numbers of their axes differ in width, and the crosshair line runs through all three, as the group page of the .NET
// showroom.
function linkedChartsPage(): Page {
  const charts: [string, number][] = [
    ['Small', 1],
    ['Large', 100_000],
    ['Medium', 25],
  ];
  const describe = (c: ChartBuilder, title: string, scale: number): ChartBuilder => {
    const source = new DataSource(2000);
    for (let i = 0; i < 2000; i++) {
      source.append(i * 0.01, scale * Math.sin(i * 0.01 * (1 + (scale % 3))));
    }
    return c
      .title(t(title))
      .xAxis((a) => a.numeric('x').range(0, 20))
      .yAxis((a) => a.numeric('y').autoRange())
      .addLine(source, (s) => s.thickness(1.5))
      .group('linked-charts')
      .addModifier(() => new ZoomPanModifier())
      .addModifier(() => new CrosshairModifier());
  };
  const [first, ...others] = charts as [[string, number], ...[string, number][]];
  return {
    id: 'linked-charts',
    name: 'Group (3 charts)',
    group: 'Interactive',
    hint: 'Zoom and crosshair apply to all three charts',
    configure: (c) => {
      describe(c, first[0], first[1]);
    },
    start: () => {
      const main = document.querySelector<HTMLElement>('#chart');
      const theme = main?.getAttribute('theme');
      const added = others.map(([title, scale]) => {
        const chart = document.createElement('tachyon-chart');
        if (theme) {
          chart.setAttribute('theme', theme);
        }
        chart.chart = describe(new ChartBuilder(), title, scale);
        return chart;
      });
      main?.after(...added);
      main?.parentElement?.classList.add('with-linked');
      return {
        dispose: () => {
          for (const chart of added) {
            chart.remove();
          }
          main?.parentElement?.classList.remove('with-linked');
        },
      };
    },
  };
}

// The 3D pages of the .NET showroom: a chart with its scene, turned with the pointer.
const hint3D = 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start';
const hintPlanes =
  'Drag the orange outline: move the plane | Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start';

// A wave and a hill over 6 × 6, as ContourData.CreateField of the .NET version.
function field3D(side: number): HeatmapData {
  const values = new Float32Array(side * side);
  for (let row = 0; row < side; row++) {
    const y = (row * 6) / side;
    for (let column = 0; column < side; column++) {
      const x = (column * 6) / side;
      values[row * side + column] =
        Math.sin(x) * Math.cos(y * 1.3) + 0.6 * Math.exp(-((x - 2) * (x - 2) + (y - 4) * (y - 4)));
    }
  }
  const data = new HeatmapData(side, side);
  data.setValues(values);
  return data;
}

// A spectrum of 512 frequencies arriving 20 times a second, its rows one behind the other: a peak wanders across.
function waterfallPage(): Page {
  const columns = 512;
  const rows = 200;
  const data = new SpectrogramData(columns, rows);
  const row = new Float32Array(columns);
  let time = 0;
  const append = (): void => {
    const center = 0.5 + 0.3 * Math.sin(time * 0.02);
    for (let column = 0; column < columns; column++) {
      const place = column / (columns - 1);
      const peak = Math.exp(-Math.pow((place - center) / 0.03, 2));
      const second = 0.6 * Math.exp(-Math.pow((place - 0.8) / 0.02, 2));
      row[column] =
        -80 + 70 * Math.max(peak, second) + 0.5 * Math.sin(column * 0.13 + time * 0.21) + (Math.random() - 0.5) * 2;
    }
    data.appendRow(row);
    time++;
  };
  for (let i = 0; i < rows; i++) {
    append();
  }
  return {
    id: 'waterfall-3d',
    name: 'Waterfall, live',
    group: '3D',
    hint: hint3D,
    configure: (c) => {
      scene3D(c, (s) =>
        s
          .title(t('Waterfall'))
          .xAxis(0, 10, t('Frequency in MHz'))
          .yAxis(0, 20, t('Age in s'))
          .zAxis(-90, 0, t('Level in dBm'))
          .addWaterfall(new Waterfall3D(data, new DoubleRange(0, 10), new DoubleRange(0, 20))),
      );
    },
    start: () => {
      const timer = setInterval(append, 50);
      return {
        dispose: () => {
          clearInterval(timer);
        },
      };
    },
  };
}

// A ring around the z axis from triangles, colored along the ring from blue over green to orange.
function torusMesh(): Mesh3D {
  const around = 96;
  const across = 48;
  const vertices: Vertex3D[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= around; i++) {
    const u = (i / around) * 2 * Math.PI;
    const share = 0.5 + 0.5 * Math.cos(u);
    for (let j = 0; j <= across; j++) {
      const v = (j / across) * 2 * Math.PI;
      const radius = 3 + 1.2 * Math.cos(v);
      vertices.push({
        position: new Point3D(5 + radius * Math.cos(u), 5 + radius * Math.sin(u), 1.2 * Math.sin(v)),
        color: {
          r: Math.round(40 + 215 * share),
          g: Math.round(120 + 60 * Math.sin(u)),
          b: Math.round(230 - 190 * share),
          a: 255,
        },
      });
    }
  }
  for (let i = 0; i < around; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * (across + 1) + j;
      const b = a + across + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return new Mesh3D(vertices, indices, { material: { gloss: 0.6, sharpness: 48 } });
}

function pages3D(): Page[] {
  return [
    {
      id: 'cut-planes-3d',
      name: 'Cut planes',
      group: '3D',
      hint: hintPlanes,
      configure: (c) => {
        scene3D(c, (s) =>
          s
            .title(t('Surface'))
            .xAxis(0, 6, 'x')
            .yAxis(0, 6, 'y')
            .zAxis(-1.5, 2, 'z')
            .addSurface(new Surface3D(field3D(256), new DoubleRange(0, 6), new DoubleRange(0, 6)))
            .addPlane(new ClipPlane3D(new Point3D(-1, 0, 0), -0.35))
            .addPlane(new ClipPlane3D(new Point3D(-0.5, 1, 0), -0.5)),
        );
      },
    },
    {
      id: 'model-3d',
      name: 'Model with measuring points',
      group: '3D',
      hint: hintPlanes,
      configure: (c) => {
        scene3D(c, pipeModel);
      },
    },
    {
      id: 'map-3d',
      name: 'Map from measurements',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, measuredMap);
      },
    },
    {
      id: 'antenna-3d',
      name: 'Antenna pattern',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) => s.title(t('Antenna gain')).addAntenna(createAntenna()));
      },
    },
    {
      id: 'pie-3d',
      name: 'Pie 3D',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) => s.title(t('Power mix')).addPie(new Pie3D(pieValues, { names: pieNames, explodedIndex: 1 })));
      },
    },
    {
      id: 'donut-3d',
      name: 'Donut 3D',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) =>
          s.title(t('Power mix')).addPie(new Pie3D(pieValues, { names: pieNames, innerRadius: 0.55, height: 0.25 })),
        );
      },
    },
    {
      id: 'model-1m-triangles',
      name: 'Model of 1 million triangles',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const model = createKnot();
        const mesh = model.toValueMesh(
          model.positions.map((point) => point.z),
          Colormap.builtIn('viridis'),
          new DoubleRange(-1.4, 1.4),
          { gloss: 0.4, sharpness: 48 },
          t('Height in m'),
        );
        scene3D(c, (s) => model.addToScale(s.title(t('Knot of tube, colored by height')), mesh, 'm'));
      },
    },
    {
      id: 'mesh-3d',
      name: 'Lit mesh',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) =>
          s
            .title(t('A ring from triangles in the light'))
            .xAxis(0, 10, 'x')
            .yAxis(0, 10, 'y')
            .zAxis(-3, 3, 'z')
            .addMesh(torusMesh()),
        );
      },
    },
    {
      id: 'see-through-3d',
      name: 'See-through',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const side = 12;
        const values = new Float32Array(side * side);
        for (let row = 0; row < side; row++) {
          for (let column = 0; column < side; column++) {
            const x = (column + 0.5) / side;
            const y = (row + 0.5) / side;
            values[row * side + column] = 0.2 + 0.6 * Math.exp(-8 * ((x - 0.5) * (x - 0.5) + (y - 0.5) * (y - 0.5)));
          }
        }
        const data = new HeatmapData(side, side);
        data.setValues(values);
        scene3D(c, (s) =>
          s
            .title(t('A see-through surface over see-through columns'))
            .xAxis(0, 6, 'x')
            .yAxis(0, 6, 'y')
            .zAxis(-1.5, 2, 'z')
            .addBars(new Bars3D(data, new DoubleRange(0, 6), new DoubleRange(0, 6), { material: { opacity: 0.6 } }))
            .addSurface(
              new Surface3D(field3D(256), new DoubleRange(0, 6), new DoubleRange(0, 6), {
                material: { opacity: 0.5, gloss: 0.5 },
              }),
            ),
        );
      },
    },
    waterfallPage(),
    {
      id: 'axis-box',
      name: 'Axis box',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) =>
          s
            .title(t('Axis box'))
            .xAxis(0, 10, t('Time in s'))
            .yAxis(-5, 5, t('Offset in mm'))
            .zAxis(0, 100, t('Level in dB')),
        );
      },
    },
    {
      id: 'path-200000',
      name: 'Path of 200,000 points',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const count = 200_000;
        const viridis = Colormap.builtIn('viridis');
        const points = new Points3D(count);
        let [x, y, z] = [1, 1, 20];
        for (let i = 0; i < count; i++) {
          [x, y, z] = [x + 0.02 * (y - x), y + 0.002 * (x * (28 - z) - y), z + 0.002 * (x * y - (8 / 3) * z)];
          points.append(x, y, z, viridis.sample(i / count));
        }
        scene3D(c, (s) =>
          s
            .title(t('Path of a particle'))
            .xAxis(-25, 25, 'x')
            .yAxis(-30, 30, 'y')
            .zAxis(0, 55, 'z')
            .addLine(new Line3D(points)),
        );
      },
    },
    {
      id: 'scatter-3000',
      name: 'Scatter of 3,000 points',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const points = new Points3D(3000);
        const centers = [
          [-0.45, -0.3, -0.3],
          [0.4, 0.35, 0.1],
          [-0.1, 0.45, 0.5],
        ];
        const spread = (): number => 0.24 * (Math.random() + Math.random() + Math.random() - 1.5);
        const viridis = Colormap.builtIn('viridis');
        for (let i = 0; i < 3000; i++) {
          const center = centers[i % 3] as number[];
          const z = (center[2] as number) + spread();
          points.append(
            (center[0] as number) + spread(),
            (center[1] as number) + spread(),
            z,
            viridis.sample((z + 1) / 2),
            3 + 8 * Math.random(),
          );
        }
        scene3D(c, (s) =>
          s
            .title(t('Three clouds'))
            .xAxis(-1, 1, 'x')
            .yAxis(-1, 1, 'y')
            .zAxis(-1, 1, 'z')
            .addScatter(new Scatter3D(points)),
        );
      },
    },
    {
      id: 'height-lines',
      name: 'Height lines',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) =>
          s
            .title(t('Surface'))
            .xAxis(0, 6, 'x')
            .yAxis(0, 6, 'y')
            .zAxis(-1.5, 2, 'z')
            .addSurface(
              new Surface3D(field3D(512), new DoubleRange(0, 6), new DoubleRange(0, 6), {
                contours: { ...evenContours(new DoubleRange(-1.5, 2), 13), onWalls: true },
              }),
            ),
        );
      },
    },
    {
      id: 'columns-3d',
      name: 'Columns',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const side = 16;
        const values = new Float32Array(side * side);
        for (let row = 0; row < side; row++) {
          for (let column = 0; column < side; column++) {
            const x = (column + 0.5) / side;
            const y = (row + 0.5) / side;
            values[row * side + column] =
              0.15 +
              0.85 * Math.exp(-14 * ((x - 0.35) * (x - 0.35) + (y - 0.6) * (y - 0.6))) +
              0.35 * Math.exp(-30 * ((x - 0.8) * (x - 0.8) + (y - 0.25) * (y - 0.25)));
          }
        }
        const data = new HeatmapData(side, side);
        data.setValues(values);
        scene3D(c, (s) =>
          s
            .title(t('Columns over a raster'))
            .xAxis(0, 16, 'x')
            .yAxis(0, 16, 'y')
            .zAxis(0, 1.2, t('Value'))
            .addBars(new Bars3D(data, new DoubleRange(0, 16), new DoubleRange(0, 16), { material: { gloss: 0.4 } })),
        );
      },
    },
    {
      id: 'bubbles-3d',
      name: 'Bubbles',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const fields = [
          { r: 255, g: 190, b: 11, a: 255 },
          { r: 58, g: 134, b: 255, a: 255 },
          { r: 6, g: 214, b: 160, a: 255 },
        ];
        const middles = [
          [2.5, 3, 4],
          [7, 6.5, 6],
          [4.5, 7.5, 2.5],
        ];
        const gauss = (): number => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
        const x: number[] = [];
        const y: number[] = [];
        const z: number[] = [];
        const yields: number[] = [];
        const colors: Rgba8[] = [];
        for (let i = 0; i < 180; i++) {
          const field = Math.trunc(i / 60);
          const middle = middles[field] as number[];
          x.push((middle[0] as number) + gauss() * 1.3);
          y.push((middle[1] as number) + gauss() * 1.1);
          z.push((middle[2] as number) + gauss() * 0.9);
          yields.push(20 + 380 * Math.pow(Math.random(), 3));
          colors.push(fields[field] as Rgba8);
        }
        scene3D(c, (s) =>
          s
            .title(t('Wells, volume by yield in m³ per day'))
            .xAxis(0, 10, t('East in km'))
            .yAxis(0, 10, t('North in km'))
            .zAxis(0, 8, t('Depth in 100 m'))
            .addBubbles(new Bubbles3D(x, y, z, Bubbles3D.scaleToVolume(yields, 0.15, 0.9), { colors, values: yields })),
        );
      },
    },
    {
      id: 'surface-4096',
      name: 'Surface 4096 × 4096',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) =>
          s
            .title(t('Surface'))
            .xAxis(0, 6, 'x')
            .yAxis(0, 6, 'y')
            .zAxis(-1.5, 2, 'z')
            .addSurface(new Surface3D(field3D(4096), new DoubleRange(0, 6), new DoubleRange(0, 6))),
        );
      },
    },
  ];
}

// A share price of 160 days with drawing tools: keys 1 to 9 choose a tool, as the drawing tools page of the .NET
// showroom; the drawings of the first gallery picture are there from the start.
function drawingToolsPage(): Page {
  const day = 86_400_000;
  const prices = new CandleData(160);
  let price = 100;
  for (let i = 0; i < 160; i++) {
    const open = price;
    let high = open;
    let low = open;
    for (let step = 0; step < 8; step++) {
      price *= 1 + (Math.random() - 0.5) * 0.012;
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    prices.append(Date.UTC(2024, 0, 2) + day * i, open, high, low, price, 10_000);
  }
  const at = (index: number, isHigh: boolean): DrawingPoint => {
    const candle = prices.at(index);
    return { x: candle.time, y: isHigh ? candle.high : candle.low };
  };
  const colored = (drawing: Drawing, color: Rgba8): Drawing => Object.assign(drawing, { color });
  return {
    id: 'drawing-tools',
    name: 'Drawing tools',
    group: 'Business',
    hint: 'Keys 1 to 9: trend line, Fibonacci, extension, channel, pitchfork, Elliott, XABCD, head and shoulders, brush | Click: place points | Drag: move a drawing or its point | Delete | Ctrl+Z: undo | Esc, 0: stop',
    configure: (c) => {
      c.title(t('Drawing tools'))
        .xAxis((a) => a.dateTime('time'))
        .yAxis((a) => a.numeric('price').title(t('Price')).autoRange());
      candles(c, prices);
      drawings(c, (layer) => {
        layer.add(new Drawing('fibonacciRetracement', [at(10, false), at(45, true)]));
        layer.add(
          colored(new Drawing('trendChannel', [at(60, false), at(95, false), at(75, true)]), {
            r: 76,
            g: 201,
            b: 240,
            a: 255,
          }),
        );
        layer.add(
          colored(new Drawing('pitchfork', [at(100, false), at(112, true), at(122, false)]), {
            r: 6,
            g: 214,
            b: 160,
            a: 255,
          }),
        );
        layer.add(
          colored(new Drawing('xabcd', [at(125, true), at(132, false), at(139, true), at(146, false), at(155, true)]), {
            r: 247,
            g: 37,
            b: 133,
            a: 255,
          }),
        );
      })
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new KeyboardNavigationModifier());
    },
  };
}

// A share price of 250 days in candles and volume; the last day trades live, now and then a new day starts, as the
// candles page of the .NET showroom.
function candlesPage(): Page {
  const day = 86_400_000;
  const data = new CandleData(250);
  let price = 100;
  for (let i = 0; i < 250; i++) {
    const open = price;
    let high = open;
    let low = open;
    for (let step = 0; step < 8; step++) {
      price *= 1 + (Math.random() - 0.5) * 0.012;
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    const traded = Math.round(5000 + Math.random() * 20000 * (1 + (Math.abs(price - open) / open) * 50));
    data.append(Date.UTC(2024, 0, 2) + day * i, open, high, low, price, traded);
  }
  return {
    id: 'candles',
    name: 'Candles',
    group: 'Business',
    hint: 'Wheel: zoom | Drag: pan | Pointer: open, high, low, close and volume | Double click: all',
    configure: (c) => {
      c.title(t('Share price, the last day trades live'))
        .xAxis((a) => a.dateTime('time'))
        .yAxis((a) => a.numeric('price').title(t('Price')).autoRange())
        .yAxis((a) => a.numeric('volume').title(t('Volume')).autoRange().pane(1, 0.3));
      candles(c, data, undefined, 'price');
      volume(c, data, 'volume')
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new CrosshairModifier());
    },
    start: () => {
      const timer = setInterval(() => {
        const last = data.at(data.count - 1);
        const traded = last.close * (1 + (Math.random() - 0.5) * 0.004);
        data.addTick(traded, Math.round(Math.random() * 400));
        if (Math.random() < 0.04) {
          data.append(last.time + day, traded, traded, traded, traded, 0);
        }
      }, 200);
      return {
        dispose: () => {
          clearInterval(timer);
        },
      };
    },
  };
}

// 60 working days in candles on a time axis without the weekends, as the candles without weekends page of the .NET
// showroom.
function candlesWithoutWeekendsPage(): Page {
  const day = 86_400_000;
  const data = new CandleData(60);
  let price = 100;
  for (let i = 0; data.count < 60; i++) {
    const open = price;
    let high = open;
    let low = open;
    for (let step = 0; step < 8; step++) {
      price *= 1 + (Math.random() - 0.5) * 0.012;
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    const time = Date.UTC(2024, 0, 2) + day * i;
    const weekday = new Date(time).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const traded = Math.round(5000 + Math.random() * 20000 * (1 + (Math.abs(price - open) / open) * 50));
      data.append(time, open, high, low, price, traded);
    }
  }
  const gaps = TimeGapMap.weekends(data.at(0).time, data.at(data.count - 1).time);
  return {
    id: 'candles-without-weekends',
    name: 'Candles without weekends',
    group: 'Business',
    hint: 'Wheel: zoom | Drag: pan across the break | Pointer: values | Double click: all',
    configure: (c) => {
      c.title(t('Working days only, the weekends take no room'))
        .xAxis((a) => a.dateTime('time').autoRange().gaps(gaps))
        .yAxis((a) => a.numeric('price').title(t('Price')).autoRange());
      candles(c, data, undefined, 'price')
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new CrosshairModifier());
    },
  };
}

// 400 days in candles with the volume per price level of the visible ones beside, as the market profile page of the
// .NET showroom.
function marketProfilePage(): Page {
  const day = 86_400_000;
  const data = new CandleData(400);
  let price = 100;
  for (let i = 0; i < 400; i++) {
    const open = price;
    let high = open;
    let low = open;
    for (let step = 0; step < 8; step++) {
      price *= 1 + (Math.random() - 0.5) * 0.012;
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    const traded = Math.round(5000 + Math.random() * 20000 * (1 + (Math.abs(price - open) / open) * 50));
    data.append(Date.UTC(2024, 0, 2) + day * i, open, high, low, price, traded);
  }
  return {
    id: 'market-profile',
    name: 'Market profile',
    group: 'Business',
    hint: 'Wheel: zoom | Drag: pan, the profile follows | Pointer on a bar: price and volume | Double click: all',
    configure: (c) => {
      c.title(t('Volume per price level of the visible days'))
        .xAxis((a) => a.dateTime('time'))
        .yAxis((a) => a.numeric('price').title(t('Price')).autoRange());
      candles(c, data, undefined, 'price');
      volumeProfile(
        c,
        data,
        (profile) => {
          profile.levels = 40;
        },
        'price',
      )
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new CrosshairModifier());
    },
  };
}

// A test bench of three temperatures and three pressures with a legend each, as the several legends page of the .NET
// showroom.
function benchCurve(seed: number, level: number, swing: number): DataSource {
  const data = new DataSource(601);
  for (let i = 0; i <= 600; i++) {
    const time = i * 0.1;
    data.append(time, level + swing * Math.sin(time * 0.15 + seed) + swing * 0.3 * Math.sin(time * 0.9 + seed * 2));
  }
  return data;
}

const legendHint =
  'Click in a legend: switch a series off and on | Pointer on a legend: highlight the series | Wheel: zoom | Drag: pan';

// The shapes of the polygon pages of the .NET showroom: rings, a star, wobbly areas and a field of hexagons.
function polygonCircle(cx: number, cy: number, radius: number, corners: number): PolygonRing {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < corners; i++) {
    const angle = (i * 2 * Math.PI) / corners;
    x.push(cx + radius * Math.cos(angle));
    y.push(cy + radius * Math.sin(angle));
  }
  return new PolygonRing(x, y);
}

function polygonStar(cx: number, cy: number, outer: number, inner: number, points: number): PolygonRing {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = Math.PI / 2 + (i * Math.PI) / points;
    const radius = i % 2 === 0 ? outer : inner;
    x.push(cx + radius * Math.cos(angle));
    y.push(cy + radius * Math.sin(angle));
  }
  return new PolygonRing(x, y);
}

function polygonBlob(
  cx: number,
  cy: number,
  radius: number,
  wobble: number,
  corners: number,
  seed: number,
): PolygonRing {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < corners; i++) {
    const angle = (i * 2 * Math.PI) / corners;
    const r =
      radius +
      wobble *
        (0.5 * Math.sin(angle * 3 + seed) + 0.3 * Math.sin(angle * 7 + seed * 2) + 0.2 * Math.sin(angle * 11 + seed));
    x.push(cx + r * Math.cos(angle));
    y.push(cy + r * Math.sin(angle));
  }
  return new PolygonRing(x, y);
}

const polygonHint = 'Wheel: zoom | Drag: pan | Pointer: the polygon under it | Double click: all';

// The test plan of three stations with linked steps and two milestones, and a test hall of 100 stations with 1000 tests
// each, as the Gantt pages of the .NET showroom.
const ganttDay = 86_400_000;
const ganttStart = Date.UTC(2026, 2, 2);

function testPlan(): GanttData {
  const data = new GanttData();
  const at = (days: number): number => ganttStart + days * ganttDay;
  const plan: [string, [string, number, number][]][] = [
    [
      'Climate chamber',
      [
        ['Prepare', 0, 1.5],
        ['Cold start', 1.5, 2],
        ['Heat soak', 3.5, 3],
        ['Report', 6.5, 1],
      ],
    ],
    [
      'Vibration',
      [
        ['Fixture', 2, 1],
        ['Sine sweep', 3, 2.5],
        ['Random', 5.5, 3],
      ],
    ],
    [
      'EMC',
      [
        ['Setup', 6, 1],
        ['Emission', 7, 2],
        ['Immunity', 9, 2.5],
        ['Report', 11.5, 1],
      ],
    ],
  ];
  let previous = -1;
  for (const [station, steps] of plan) {
    for (const [step, from, days] of steps) {
      const row = data.addRow(t(step), t(station));
      const task = data.add({ row, start: at(from), end: at(from + days), label: t(step) });
      if (previous >= 0) {
        data.link(previous, task);
      }
      previous = task;
    }
  }
  const gates = data.addRow(t('Milestones'));
  data.add({ row: gates, start: at(6.5), end: at(6.5), label: t('Climate done') });
  data.add({ row: gates, start: at(12.5), end: at(12.5), label: t('Release') });
  return data;
}

function testHall(): GanttData {
  const data = new GanttData();
  for (let station = 0; station < 100; station++) {
    const row = data.addRow(`Station ${String(station + 1)}`, `Hall ${String(Math.trunc(station / 10) + 1)}`);
    let time = Math.random() * 2;
    for (let test = 0; test < 1000; test++) {
      const length = 0.05 + Math.random() * 0.6;
      data.add({
        row,
        start: ganttStart + time * ganttDay,
        end: ganttStart + (time + length) * ganttDay,
        label: `Test ${String(test + 1)}`,
      });
      time += length + Math.random() * 0.2;
    }
  }
  return data;
}

// An oscilloscope with free-running signals at 30 records per second; only the trigger makes the picture stand
// still, as the interactive oscilloscope of the .NET showroom.
function scopeSignal(kind: number, time: number): number {
  const angle = 2 * Math.PI * 1000 * time;
  switch (kind) {
    case 0:
      return 1.5 * Math.sin(angle);
    case 1:
      return Math.sin(angle) >= 0 ? 1 : -1;
    case 2:
      return 2 * Math.exp(-Math.abs((((time + 0.01) * 1000) % 1) * 6)) * Math.cos(angle * 12);
    default:
      return (2 / Math.PI) * Math.asin(Math.sin(angle));
  }
}

function oscilloscopePage(): Page {
  const display = new ScopeDisplay();
  display.timePerDivision = 5e-4;
  display.triggerLevel = 0.5;
  for (let i = 0; i < 4; i++) {
    const channel = display.addChannel();
    channel.voltsPerDivision = i === 0 ? 1 : 0.5;
    channel.position = 3 - i * 2;
  }
  const trigger = new ScopeTrigger(display);
  const count = 20_000;
  const interval = 1e-6;
  const channels = display.channels.map(() => new Float32Array(count));
  return {
    id: 'oscilloscope',
    name: 'Oscilloscope',
    group: 'Instruments',
    hint: 'Drag at the left: channel | at the right: trigger | else: time | Wheel: time/div | Left, on V/div or Ctrl+wheel: volts/div',
    configure: (c) => {
      oscilloscope(c, display).theme(instrument);
    },
    start: () => {
      const acquire = (): void => {
        const shift = Math.random() / 1000;
        channels.forEach((values, c) => {
          for (let i = 0; i < count; i++) {
            values[i] = scopeSignal(c, i * interval - 0.01 + shift);
          }
        });
        trigger.process(interval, channels);
      };
      acquire();
      const timer = setInterval(acquire, 1000 / 30);
      return {
        dispose: () => {
          clearInterval(timer);
        },
      };
    },
  };
}

// A spectrum analyzer with 30 traces per second of noise and three carriers below a passing mask, as the interactive
// spectrum of the .NET showroom.
function spectrumPage(): Page {
  const display = new SpectrumDisplay();
  display.mask = new FrequencyMask([0, 3e6, 3.2e6, 1e7], [-5, -5, -9, -9]);
  display.showsDensity = true;
  display.setView(0, 1e7, 0);
  const frequencies = Float64Array.from({ length: 1500 }, (_, i) => (i * 1e7) / 1499);
  const levels = new Float32Array(frequencies.length);
  const carriers: readonly [number, number][] = [
    [2e6, -12],
    [4.5e6, -30],
    [7e6, -22],
  ];
  return {
    id: 'spectrum',
    name: 'Spectrum',
    group: 'Instruments',
    hint: 'Wheel: frequency | Left: dB/div | Ctrl+wheel: reference | Drag: pan | Click: marker | Ctrl+click: add or remove a marker | Double click: peak',
    configure: (c) => {
      spectrum(c, display).theme(instrument);
    },
    start: () => {
      const deliver = (): void => {
        for (let i = 0; i < levels.length; i++) {
          let level = -70 + 6 * Math.random();
          for (const [center, height] of carriers) {
            const distance = ((frequencies[i] as number) - center) / 8e4;
            level = Math.max(level, height - distance * distance * 6 + Math.random());
          }
          levels[i] = level;
        }
        display.setTrace(frequencies, levels);
      };
      deliver();
      const timer = setInterval(deliver, 1000 / 30);
      return {
        dispose: () => {
          clearInterval(timer);
        },
      };
    },
  };
}

// A network analyzer with a band-pass filter that keeps to its limits; markers can be dragged and toggled, as the
// interactive network analyzer of the .NET showroom.
function networkPage(): Page {
  return {
    id: 'network',
    name: 'Network analyzer',
    group: 'Instruments',
    hint: 'Drag a marker: move it | Ctrl+click: add or remove a marker | Wheel: zoom | Drag: pan',
    configure: (c) => {
      const display = new NetworkDisplay();
      const transmission = display.addTrace('S21');
      const reflection = display.addTrace('S11');
      const count = 801;
      const frequencies = Float64Array.from({ length: count }, (_, i) => 1e9 + (i * 1e9) / (count - 1));
      const responses = Array.from(frequencies, (frequency) => 1 / (1 + ((frequency - 1.5e9) / 1.2e8) ** 6));
      transmission.setSweep(
        frequencies,
        responses.map((response) => ({ re: Math.max(Math.sqrt(response), 1e-4), im: 0 })),
      );
      reflection.setSweep(
        frequencies,
        responses.map((response) => ({ re: Math.max(Math.sqrt(1 - response), 0.03), im: 0 })),
      );
      const limit = (kind: 'maximum' | 'minimum', from: number, to: number, level: number): LimitLine => ({
        kind,
        startFrequency: from,
        startLevel: level,
        stopFrequency: to,
        stopLevel: level,
      });
      transmission.addLimit(limit('minimum', 1.45e9, 1.55e9, -1));
      transmission.addLimit(limit('maximum', 1e9, 1.15e9, -20));
      reflection.addLimit(limit('maximum', 1.47e9, 1.53e9, -20));
      display.addMarker(1.5e9);
      display.addMarker(1.7e9);
      networkAnalyzer(c, display, 1e9, 2e9, -70, 5)
        .theme(instrument)
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new NetworkMarkerModifier(display));
    },
  };
}

// A patient monitor at 25 000 samples per second: two ECG leads, the pulse and the breath, written into a window of
// six seconds, as the sweep and stepping monitors of the .NET showroom.
function monitorBell(x: number, center: number, width: number): number {
  return Math.exp(-((x - center) * (x - center)) / (2 * width * width));
}

function monitorPage(mode: SweepMode): Page {
  const rate = 25_000;
  const window = 6;
  const names = ['ECG I', 'ECG II', 'Pleth', 'Resp'];
  const ranges = [
    new DoubleRange(-0.6, 1.4),
    new DoubleRange(-0.6, 1.4),
    new DoubleRange(-0.1, 1.1),
    new DoubleRange(-1.2, 1.2),
  ];
  const data = new SweepData(names.length, rate * (window + 1), window);
  data.mode = mode;
  const block = rate / 100;
  const times = new Float64Array(block);
  const values = new Float32Array(block * names.length);
  const fill = (first: number): void => {
    for (let i = 0; i < block; i++) {
      const t = (first + i) / rate;
      times[i] = t;
      const beat = ((t * 72) / 60) % 1;
      const ecg =
        0.12 * monitorBell(beat, 0.18, 0.025) -
        0.15 * monitorBell(beat, 0.36, 0.008) +
        monitorBell(beat, 0.39, 0.01) -
        0.25 * monitorBell(beat, 0.42, 0.01) +
        0.3 * monitorBell(beat, 0.62, 0.045);
      const pulse = (beat + 0.85) % 1;
      values[i * 4] = ecg;
      values[i * 4 + 1] = ecg * 0.8 + 0.05 * Math.sin(t * 2 * Math.PI * 0.3);
      values[i * 4 + 2] = 0.9 * monitorBell(pulse, 0.25, 0.07) + 0.3 * monitorBell(pulse, 0.5, 0.06);
      values[i * 4 + 3] = Math.sin(t * 2 * Math.PI * 0.25);
    }
  };
  return {
    id: mode === 'sweep' ? 'sweep' : 'stepping',
    name: mode === 'sweep' ? 'Sweep monitor' : 'Stepping monitor',
    group: 'Instruments',
    hint: 'The trace writes from the left over the previous one | Wheel on an axis: zoom the values',
    configure: (c) => {
      sweep(c.title(mode === 'sweep' ? 'Sweep' : 'Stepping').theme(instrument), data, ranges, names);
    },
    start: () => {
      // Blocks of 10 ms on a clock, so that the sample rate holds however the timer runs.
      const begin = performance.now();
      let written = 0;
      data.clear();
      const timer = setInterval(() => {
        const due = Math.trunc(((performance.now() - begin) / 1000) * rate);
        while (written + block <= due) {
          fill(written);
          data.append(times, values);
          written += block;
        }
      }, 10);
      return {
        dispose: () => {
          clearInterval(timer);
        },
      };
    },
  };
}

// A recording of a million values per second into a ring of 8 files of 16 Mi values in OPFS: the line shows the last
// two minutes and more while they grow, and zooming in reads the values back from the files.
function recording(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Double click: all, rolling';
  return {
    id: 'recording',
    name: 'Recording',
    group: 'Lines',
    hint,
    configure: (c) => {
      c.theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      const run = { stopped: false, frame: 0 };
      const stopped = (): boolean => run.stopped;
      let recorder: ColumnRecorder | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(hint);
      void (async () => {
        const started = await ColumnRecorder.start({
          folder: 'showroom',
          name: 'recording',
          fileValues: 1 << 24,
          maxFiles: 8,
          xStep: 1e-6,
        });
        if (stopped()) {
          started.dispose();
          return;
        }
        recorder = started;
        if (chart) {
          chart.chart = new ChartBuilder()
            .theme(instrument)
            .xAxis((a) => a.numeric('x').title(t('Time in s')).autoRange())
            .yAxis((a) => a.numeric('y').autoRange())
            .addSeries((x, y) => new ColumnLineSeries(started, x, y));
        }
        // A million values per second, appended each frame: a slow wave, a fast one and noise.
        let last = performance.now();
        let level = 0;
        const chunk = new Float32Array(100_000);
        const feed = (now: number): void => {
          if (stopped()) {
            return;
          }
          const count = Math.min(chunk.length, Math.round(now - last) * 1000);
          last = now;
          const first = started.recorded;
          for (let i = 0; i < count; i++) {
            const row = first + i;
            level += (Math.random() - 0.5) * 0.002;
            chunk[i] = Math.sin(row / 3e6) + 0.3 * Math.sin(row / 997) + level + (Math.random() - 0.5) * 0.1;
          }
          started.append(chunk.subarray(0, count));
          const files = started.fileCount;
          say(
            `${(started.recorded / 1e6).toFixed(1)} M ${t('values recorded')} | ${String(files)} ${t('files')}, ` +
              `${String(Math.round((started.rows * 4) / 1e6))} MB ${t('on the disk')}`,
          );
          run.frame = requestAnimationFrame(feed);
        };
        run.frame = requestAnimationFrame(feed);
      })();
      return {
        dispose: () => {
          run.stopped = true;
          cancelAnimationFrame(run.frame);
          recorder?.dispose();
        },
      };
    },
  };
}

// 16 digital channels of a billion points each, one point a nanosecond: 15 kept as their changes in memory, the
// first read from a bit file of 125 MB in OPFS with one pulse of a single nanosecond. Every edge shows, however far out.
const bitFile = { path: 'showroom/channel.tcol', count: 1_000_000_000, pulse: 612_345_678 };

async function writeBitFile(progress: (share: number) => void): Promise<void> {
  const handle = await opfsFile(bitFile.path, true);
  if ((await handle.getFile()).size >= 64 + bitFile.count / 8) {
    return;
  }
  const writer = new BitFileWriter(writableSink(await handle.createWritable()), 0, 1e-9);
  // A clock that slows down, and the pulse.
  let level = false;
  for (let at = 0, period = 2048; at < bitFile.count;) {
    const run = Math.min(period, bitFile.count - at);
    if (at <= bitFile.pulse && bitFile.pulse < at + run && !level) {
      await writer.append(false, bitFile.pulse - at);
      await writer.append(true, 1);
      await writer.append(false, at + run - bitFile.pulse - 1);
    } else {
      await writer.append(level, run);
    }
    at += run;
    level = !level;
    period = at < bitFile.count / 2 ? 2048 : 4_000_000;
    if (at % (1 << 26) < run) {
      progress(at / bitFile.count);
    }
  }
  await writer.close();
}

function digitalChannels(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Double click: all';
  const loading = new LoadingOverlay();
  const colors = [rgba(110, 210, 130), rgba(80, 170, 240), rgba(240, 130, 90), rgba(230, 200, 80)];
  return {
    id: 'digital-channels',
    name: 'Digital channels',
    group: 'Lines',
    hint,
    configure: (c) => {
      loading.show(t('Loading data'));
      c.addOverlay(() => loading)
        .theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      const run = { stopped: false };
      const stopped = (): boolean => run.stopped;
      let file: BitColumn | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(hint, loading);
      void (async () => {
        await writeBitFile((share) => {
          say(t('The first visit writes a bit file of 125 MB'), share);
        });
        if (stopped()) {
          return;
        }
        const opened = await BitColumn.open({ opfs: bitFile.path });
        if (stopped()) {
          opened.dispose();
          return;
        }
        file = opened;
        const status = (): void => {
          say(
            opened.isComplete
              ? t('16 channels of a billion points; channel 1 from a file, with one pulse of a nanosecond')
              : `${t('Refining')} ${String(Math.floor(opened.progress * 100))} %`,
          );
        };
        opened.onChange(status);
        status();
        // 15 channels in memory as a bus would carry them: quiet stretches of 20 to 120 ms, then bursts of 5 to 30 ms
        // whose clock differs from channel to channel.
        const sources: DigitalSource[] = [opened];
        for (let channel = 1; channel < 16; channel++) {
          const transitions = new DigitalTransitions(0, 1e-9);
          let seed = channel * 7919;
          const random = (range: number): number => {
            seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
            return seed % range;
          };
          const half = 500 * channel;
          for (let at = 0; at < 1_000_000_000;) {
            const quiet = Math.min(20_000_000 + random(100_000_000), 1_000_000_000 - at);
            transitions.append(false, quiet);
            at += quiet;
            const end = Math.min(at + 5_000_000 + random(25_000_000), 1_000_000_000);
            let level = true;
            while (at < end) {
              const length = Math.min(half + random(half), end - at);
              transitions.append(level, length);
              at += length;
              level = !level;
            }
          }
          sources.push(transitions);
        }
        if (chart) {
          let builder = new ChartBuilder()
            .theme(instrument)
            .xAxis((a) => a.numeric('x').title(t('Time in s')).autoRange())
            .yAxis((a) => a.numeric('y').range(-0.5, 16));
          sources.forEach((source, channel) => {
            builder = builder.addSeries((x, y) => {
              const series = new DigitalSeries(source, x, y);
              series.low = 15 - channel;
              series.high = 15 - channel + 0.7;
              series.color = colors[channel % colors.length] ?? series.color;
              return series;
            });
          });
          chart.chart = builder;
        }
      })();
      return {
        dispose: () => {
          run.stopped = true;
          file?.dispose();
        },
      };
    },
  };
}

function lineFromACsvFile(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all';
  const loading = new LoadingOverlay();
  return {
    id: 'line-from-a-csv-file',
    name: 'Line from a CSV file',
    group: 'Lines',
    hint,
    configure: (c) => {
      loading.show(t('Loading data'));
      c.addOverlay(() => loading)
        .theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      const run = { stopped: false, conversion: 0 };
      const stopped = (): boolean => run.stopped;
      let column: LargeColumn | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(hint, loading);
      // A file of one's own: the first column is X, the second the line.
      const picker = document.createElement('label');
      picker.className = 'picker';
      picker.textContent = `${t('CSV file of your own')} `;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      picker.append(input);
      chart?.after(picker);

      const show = async (csv: Blob, conversion: number): Promise<void> => {
        column?.dispose();
        column = undefined;
        const handle = await opfsFile('showroom/converted.tcol', true);
        const started = performance.now();
        const summary = await csvToColumnFile(csv, writableSink(await handle.createWritable()), {
          xColumn: 0,
          columns: [1],
          onProgress: (share) => {
            say(t('Converting'), share);
          },
        });
        if (stopped() || conversion !== run.conversion) {
          return;
        }
        const seconds = (performance.now() - started) / 1000;
        const converted = `${summary.rows.toLocaleString()} ${t('rows converted in')} ${seconds.toFixed(1)} s (${(csv.size / 1e6 / seconds).toFixed(0)} MB/s)`;
        const opened = await LargeColumn.open({ opfs: 'showroom/converted.tcol' }, { cache: false });
        if (stopped() || conversion !== run.conversion) {
          opened.dispose();
          return;
        }
        column = opened;
        say(converted);
        if (chart) {
          chart.chart = new ChartBuilder()
            .addOverlay((built) => refining(built))
            .theme(instrument)
            .xAxis((a) => a.numeric('x').title(t('Time in s')).autoRange())
            .yAxis((a) =>
              a
                .numeric('y')
                .title(summary.names[0] ?? '')
                .autoRange(),
            )
            .addSeries((x, y) => new ColumnLineSeries(opened, x, y));
        }
      };
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) {
          run.conversion++;
          void show(file, run.conversion).catch((error: unknown) => {
            say(error instanceof Error ? error.message : String(error));
          });
        }
      });
      void (async () => {
        await writeSampleCsv((share) => {
          say(t('The first visit writes a sample CSV of 200 MB'), share);
        });
        if (!stopped() && run.conversion === 0) {
          await show(await (await opfsFile(sampleCsv.path)).getFile(), 0);
        }
      })();
      return {
        dispose: () => {
          run.stopped = true;
          picker.remove();
          column?.dispose();
        },
      };
    },
  };
}

function lineFromALargeFile(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all';
  const loading = new LoadingOverlay();
  return {
    id: 'line-from-a-large-file',
    name: 'Line from a large file',
    group: 'Lines',
    hint,
    configure: (c) => {
      loading.show(t('Loading data'));
      c.addOverlay(() => loading)
        .theme(instrument)
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
      const say = sayer(hint, loading);
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
                say(t('The first visit writes a test file of 1 GB'), event.data.progress ?? 0);
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
              ? `${t('250 million values, five spikes among them')} | ${t('Pyramid')} ${took(opened)}`
              : `${t('Refining')} ${percent(opened.progress)}`,
          );
        };
        opened.onChange(status);
        status();
        if (chart) {
          chart.chart = new ChartBuilder()
            .addOverlay((built) => refining(built))
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
  lineFromACsvFile(),
  recording(),
  digitalChannels(),
  raster(),
  heatmap(),
  spectrogram(),
  contour(),
  rasterFromALargeFile(),
  scatterDensityFromAFile(),
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
    id: 'histogram',
    name: 'Histogram',
    group: 'Statistics',
    hint: plain,
    configure: (c) => {
      // 5000 waiting times, binned after Freedman and Diaconis.
      const values = Float64Array.from({ length: 5000 }, (_, i) => -Math.log(1 - ((i * 0.618_034) % 1)) * 2);
      return numeric(c, 0, 12, 0, 1200).addSeries((x, y) =>
        BarSeries.fromHistogram(computeHistogram(values, 'freedmanDiaconis'), x, y),
      );
    },
  },
  {
    id: 'box-and-violin',
    name: 'Box and violin',
    group: 'Statistics',
    hint: plain,
    configure: (c) => {
      const wave = (i: number, k: number): number => (Math.sin(i * k) + 1) / 2;
      const samples = [
        Array.from({ length: 300 }, (_, i) => (wave(i, 1.7) + wave(i, 2.9) + wave(i, 4.3)) * 2),
        Array.from({ length: 300 }, (_, i) => -Math.log(1 - wave(i, 7.1) * 0.999) + 1),
        Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? 2 : 5) + wave(i, 3.7)),
      ];
      return c
        .theme(instrument)
        .xAxis((a) => a.category([t('Normal'), t('Skewed'), t('Two peaks')], 'x'))
        .yAxis((a) => a.numeric('boxes').range(0, 8).pane(0))
        .yAxis((a) => a.numeric('violins').range(0, 8).pane(1))
        .addSeries((x, y) => new BoxPlotSeries(samples, x, y), 'x', 'boxes')
        .addSeries(
          (x, y) =>
            Object.assign(new ViolinSeries(samples, x, y), {
              fill: new SolidFill({ r: 247, g: 37, b: 133, a: 64 }),
            }),
          'x',
          'violins',
        );
    },
  },
  {
    id: 'polar',
    name: 'Polar',
    group: 'Coordinates',
    hint: 'Double click: all',
    configure: (c) => {
      const degrees = Array.from({ length: 361 }, (_, i) => i);
      return c
        .theme(instrument)
        .xAxis((a) => a.numeric('angle').range(0, 360).hidden())
        .yAxis((a) => a.numeric('radial').range(0, 10).hidden())
        .addSeries((x, y) =>
          Object.assign(
            new PolarSeries(
              degrees,
              degrees.map((d) => 5 + 3 * Math.sin((d * Math.PI) / 45)),
              x,
              y,
            ),
            {
              parts: { area: true, line: true },
              isClosed: true,
            },
          ),
        )
        .addSeries((x, y) =>
          Object.assign(
            new PolarSeries(
              degrees,
              degrees.map((d) => d / 40),
              x,
              y,
            ),
            {
              color: { r: 255, g: 183, b: 3, a: 255 },
              thickness: 2,
            },
          ),
        )
        .addOverlay(
          (chart) =>
            new PolarGridOverlay(radialAxis(chart), ['0°', '45°', '90°', '135°', '180°', '225°', '270°', '315°']),
        );
    },
  },
  {
    id: 'radar',
    name: 'Radar',
    group: 'Coordinates',
    hint: 'Double click: all',
    configure: (c) => {
      const names = [t('Speed'), t('Price'), t('Quality'), t('Service'), t('Design'), t('Range')];
      return c
        .theme(instrument)
        .xAxis((a) => a.numeric('angle').range(0, 360).hidden())
        .yAxis((a) => a.numeric('radial').range(0, 100).hidden())
        .addSeries((x, y) => PolarSeries.radar([80, 60, 90, 70, 50, 75], x, y))
        .addSeries((x, y) =>
          Object.assign(PolarSeries.radar([50, 90, 60, 85, 80, 40], x, y), {
            color: { r: 247, g: 37, b: 133, a: 255 },
            fill: new SolidFill({ r: 247, g: 37, b: 133, a: 60 }),
          }),
        )
        .addOverlay((chart) => new PolarGridOverlay(radialAxis(chart), names));
    },
  },
  {
    id: 'smith',
    name: 'Smith',
    group: 'Coordinates',
    hint: 'Drag: move the marker along the curve',
    configure: (c) => {
      const count = 200;
      const detuning = Array.from({ length: count }, (_, i) => (i - count / 2) / (count / 2));
      return c
        .theme(instrument)
        .xAxis((a) => a.numeric('x').range(-1, 1).hidden())
        .yAxis((a) => a.numeric('y').range(-1, 1).hidden())
        .addSeries(
          (x, y) =>
            new SmithSeries(
              detuning.map((d) => 20 + 10 * d * d),
              detuning.map((d) => 120 * d),
              x,
              y,
            ),
        )
        .addOverlay(() => new SmithGridOverlay())
        .addOverlay((chart) => new SmithMarkerOverlay(chart.series[0] as SmithSeries, count / 2))
        .addModifier(() => new SmithMarkerModifier());
    },
  },
  {
    id: 'ternary',
    name: 'Ternary',
    group: 'Coordinates',
    hint: 'Three parts of 100 % per point',
    configure: (c) => {
      const steps = Array.from({ length: 60 }, (_, i) => i);
      return c
        .theme(instrument)
        .xAxis((a) => a.numeric('x').range(0, 1).hidden())
        .yAxis((a) => a.numeric('y').range(0, 1).hidden())
        .addSeries((x, y) =>
          Object.assign(
            new TernarySeries(
              steps.map((i) => 0.2 + (0.5 * i) / 59),
              steps.map((i) => 0.6 - (0.4 * i) / 59 + 0.1 * Math.sin(i * 0.9)),
              steps.map((i) => 0.2 + 0.1 * Math.cos(i * 1.7)),
              x,
              y,
            ),
            { color: { r: 240, g: 130, b: 90, a: 255 } },
          ),
        )
        .addOverlay(() => new TernaryGridOverlay('A', 'B', 'C'));
    },
  },
  {
    id: 'parallel-coordinates',
    name: 'Parallel coordinates',
    group: 'Coordinates',
    hint: 'Drag at a name: move the axis | Drag along an axis: filter | Double click: all',
    configure: (c) => {
      // 20 000 rows of a machine under changing load, as the parallel page of the .NET showroom: voltage, current,
      // temperature and level follow the load, pressure and frequency scatter around their values.
      const rows = 20_000;
      const columns: number[][] = Array.from({ length: 6 }, () => new Array<number>(rows));
      const at = (column: number): number[] => columns[column] as number[];
      for (let row = 0; row < rows; row++) {
        const load = Math.random();
        at(0)[row] = 3 + 2 * load + Math.random() * 0.3;
        at(1)[row] = 10 * load * load;
        at(2)[row] = 25 + 40 * load + Math.random() * 5;
        at(3)[row] = 1000 + Math.random() * 50;
        at(4)[row] = 50 + Math.random() * 0.2;
        at(5)[row] = -60 + 30 * load;
      }
      return c
        .theme(instrument)
        .xAxis((a) => a.numeric('x').range(0, 1).hidden())
        .yAxis((a) => a.numeric('y').range(0, 1).hidden())
        .addSeries((x, y) => new ParallelCoordinatesSeries(columns, x, y))
        .addOverlay(
          (chart) =>
            new ParallelAxesOverlay(chart.series[0] as ParallelCoordinatesSeries, ['V', 'A', '°C', 'hPa', 'Hz', 'dB']),
        )
        .addModifier(() => new ParallelAxesModifier());
    },
  },
  {
    id: 'pie',
    name: 'Pie',
    group: 'Business',
    hint: 'Pointer: name, value and share | Click: pull a slice out, again: back',
    configure: (c) => {
      pie(c.title(t('Power mix')), pieValues, pieNames, (series) => {
        series.explodedIndex = 1;
      });
    },
  },
  {
    id: 'donut',
    name: 'Donut',
    group: 'Business',
    hint: 'Pointer: name, value and share | Click: pull a slice out, again: back',
    configure: (c) => {
      pie(c.title(t('Power mix')), pieValues, pieNames, (series) => {
        series.innerRadius = 0.55;
      });
    },
  },
  {
    id: 'gantt',
    name: 'Gantt',
    group: 'Business',
    hint: 'Wheel: zoom | Drag: pan | Click on a group: collapse or expand | Pointer: start, end and duration',
    configure: (c) => {
      gantt(
        c.title(t('Test plan')).xAxis((a) => a.dateTime('time').autoRange()),
        testPlan(),
      ).addModifier(() => new ZoomPanModifier());
    },
  },
  {
    id: 'gantt-test-hall',
    name: 'Gantt, 100 000 tasks',
    group: 'Business',
    hint: 'Wheel: zoom | Drag: pan | Click on a group: collapse or expand | Pointer: start, end and duration',
    configure: (c) => {
      gantt(
        c.title(t('Test hall: 100 stations, 100 000 tests')).xAxis((a) => a.dateTime('time').autoRange()),
        testHall(),
      ).addModifier(() => new ZoomPanModifier());
    },
  },
  {
    id: 'polygons',
    name: 'Polygons',
    group: 'Business',
    hint: polygonHint,
    configure: (c) => {
      polygons(
        c
          .title(t('Polygons with holes'))
          .xAxis((a) => a.numeric('x').range(0, 10))
          .yAxis((a) => a.numeric('y').range(0, 10)),
        [
          new Polygon(polygonCircle(3, 7, 2, 48), [polygonCircle(3, 7, 1, 32)], t('Ring')),
          new Polygon(polygonStar(7.5, 7, 2, 0.9, 5), [], t('Star')),
          new Polygon(
            polygonBlob(5, 2.6, 2.2, 0.6, 80, 5),
            [polygonCircle(5.6, 2.4, 0.6, 24), polygonCircle(4.2, 3, 0.4, 20)],
            t('Island with two lakes'),
          ),
        ],
        (series) => {
          series.thickness = 1.5;
        },
      )
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new CrosshairModifier())
        .addModifier(() => new TooltipModifier());
    },
  },
  {
    id: 'ten-thousand-polygons',
    name: '10 000 polygons',
    group: 'Business',
    hint: polygonHint,
    configure: (c) => {
      const hexagons: Polygon[] = [];
      for (let row = 0; row < 100; row++) {
        for (let column = 0; column < 100; column++) {
          hexagons.push(
            new Polygon(
              polygonCircle(column * 1.5 + (row % 2) * 0.75, row * 0.433, 0.48, 6),
              [],
              `Cell ${String(row)}/${String(column)}`,
            ),
          );
        }
      }
      polygons(
        c
          .title(t('10 000 hexagons'))
          .xAxis((a) => a.numeric('x').range(-1, 150))
          .yAxis((a) => a.numeric('y').range(-1, 44)),
        hexagons,
        (series) => {
          series.thickness = 0.5;
        },
      )
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new TooltipModifier());
    },
  },
  {
    id: 'heatmap-in-an-area',
    name: 'Heatmap in an area',
    group: 'Business',
    hint: polygonHint,
    configure: (c) => {
      const region = new Polygon(
        polygonBlob(5, 5, 4.2, 0.9, 120, 3),
        [polygonBlob(6, 5.6, 1.1, 0.25, 40, 7)],
        t('Region'),
      );
      const length = 400;
      const data = new HeatmapData(length, length);
      const values = new Float32Array(length * length);
      for (let row = 0; row < length; row++) {
        for (let column = 0; column < length; column++) {
          const x = ((column + 0.5) / length) * 10;
          const y = ((row + 0.5) / length) * 10;
          values[row * length + column] = Math.sin(x * 0.8) * Math.cos(y * 0.6) + 0.3 * Math.sin((x + y) * 0.4);
        }
      }
      data.setValues(values);
      c.title(t('A measurement inside a region'))
        .xAxis((a) => a.numeric('x').range(0, 10))
        .yAxis((a) => a.numeric('y').range(0, 10))
        .yAxis((a) => a.color('Turbo', 'color'))
        .addSeries((x, y, axis) =>
          Object.assign(new HeatmapSeries(data, x, y, axis('color') as ColorAxis), {
            xStep: 10 / length,
            yStep: 10 / length,
            mask: [region],
          }),
        );
      polygons(c, [region], (series) => {
        series.fillAlpha = 0;
      })
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new TooltipModifier());
    },
  },
  candlesPage(),
  drawingToolsPage(),
  liveChartPage(),
  lastValuePage(),
  valueLabelsPage(),
  rolloverPage(),
  ...pages3D(),
  linkedChartsPage(),
  marketProfilePage(),
  candlesWithoutWeekendsPage(),
  {
    id: 'legend',
    name: 'Legend',
    group: 'Legends',
    hint: legendHint,
    configure: (c) => {
      c.title(t('Measurements'))
        .xAxis((a) => a.numeric('t').title(t('Time in s')).range(0, 60))
        .yAxis((a) => a.numeric('y').range(0, 120));
      ['Inlet', 'Core', 'Outlet'].forEach((name, i) => {
        const stroke = [
          { r: 80, g: 170, b: 240, a: 255 },
          { r: 240, g: 130, b: 90, a: 255 },
          { r: 110, g: 210, b: 130, a: 255 },
        ][i] as Rgba8;
        c.addLine(benchCurve(i, 40 + i * 25, 8), (line) => line.name(t(name)).stroke(stroke).thickness(1.5));
      });
      c.legend()
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new CrosshairModifier());
    },
  },
  {
    id: 'several-legends',
    name: 'Several legends',
    group: 'Legends',
    hint: legendHint,
    configure: (c) => {
      const temperatures = [t('Inlet'), t('Core'), t('Outlet')];
      const pressures = [t('Pump'), t('Filter'), t('Valve')];
      const colors = [
        { r: 255, g: 190, b: 11, a: 255 },
        { r: 251, g: 86, b: 7, a: 255 },
        { r: 247, g: 37, b: 133, a: 255 },
        { r: 76, g: 201, b: 240, a: 255 },
        { r: 58, g: 134, b: 255, a: 255 },
        { r: 6, g: 214, b: 160, a: 255 },
      ];
      c.title(t('Test bench'))
        .xAxis((a) => a.numeric('t').title(t('Time in s')).range(0, 60))
        .yAxis((a) => a.numeric('temperature').title(t('Temperature in °C')).range(0, 120))
        .yAxis((a) => a.numeric('pressure').title(t('Pressure in bar')).range(0, 12).position('right'));
      temperatures.forEach((name, i) => {
        c.addLine(benchCurve(i, 40 + i * 25, 8), (line) =>
          line
            .name(name)
            .stroke(colors[i] as (typeof colors)[number])
            .thickness(1.5)
            .yAxis('temperature'),
        );
      });
      pressures.forEach((name, i) => {
        c.addLine(benchCurve(i + 3, 3 + i * 2.5, 0.8), (line) =>
          line
            .name(name)
            .stroke(colors[i + 3] as (typeof colors)[number])
            .thickness(1.5)
            .yAxis('pressure'),
        );
      });
      c.legend((l) =>
        l
          .title(t('Temperatures'))
          .series(...temperatures)
          .place('topLeft'),
      )
        .legend((l) =>
          l
            .title(t('Pressures'))
            .series(...pressures)
            .place('bottom'),
        )
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new CrosshairModifier());
    },
  },
  {
    id: 'annotations',
    name: 'Annotations',
    group: 'Annotations',
    hint: 'Drag an annotation: move it | Drag a handle or the lower right corner: resize | Delete: remove | Ctrl+Z, Ctrl+Y: undo, redo',
    configure: (c) => {
      const red = { r: 240, g: 90, b: 90, a: 255 };
      const green = { r: 110, g: 210, b: 130, a: 255 };
      const orange = { r: 240, g: 130, b: 90, a: 255 };
      const clear = { r: 0, g: 0, b: 0, a: 0 };
      const x = (chart: ChartSurface): Axis => chart.horizontalAxes[0] as Axis;
      const y = (chart: ChartSurface): Axis => chart.panes[0]?.axes[0] as Axis;
      c.title(t('Annotations'))
        .xAxis((a) => a.numeric('x').title(t('Time in s')).range(0, 10))
        .yAxis((a) => a.numeric('y').range(-1.5, 1.5))
        .addLine(
          sample((v) => 0.9 * Math.sin(v * 1.3), 240),
          (line) => line.stroke({ r: 80, g: 170, b: 240, a: 255 }).thickness(2),
        )
        .addOverlay((chart) =>
          Object.assign(new HorizontalLineAnnotation(y(chart)), {
            y: 1.1,
            label: t('Upper limit'),
            color: red,
            isEditable: true,
            appearance: {
              labelPlace: 'end',
              labelIcon: 'warning',
              labelColor: { r: 255, g: 255, b: 255, a: 255 },
              dash: 'dashed',
            },
          }),
        )
        .addOverlay((chart) =>
          Object.assign(new VerticalLineAnnotation(x(chart)), {
            x: 6,
            label: t('Trigger'),
            color: green,
            isEditable: true,
            appearance: { labelTurn: 'alongLine', labelFill: clear, labelSize: 14, thickness: 2 },
          }),
        )
        .addOverlay((chart) => {
          const band = Object.assign(new BandAnnotation(x(chart)), {
            color: { ...green, a: 45 },
            isEditable: true,
            label: t('Window'),
            appearance: { labelFill: clear, labelBorder: green, labelColor: green, dash: 'dotted', thickness: 1.5 },
          });
          band.setRange(7.5, 9);
          return band;
        })
        .addOverlay((chart) => {
          const box = Object.assign(new BoxAnnotation(x(chart), y(chart)), {
            color: orange,
            isEditable: true,
            label: t('Peak'),
            appearance: { labelIcon: 'info', labelBorder: { r: 30, g: 30, b: 30, a: 255 }, dash: 'dashed' },
          });
          box.setCorners(1.9, 1.25, 3.6, 0.55);
          return box;
        })
        .addOverlay((chart) => {
          const trend = Object.assign(new LineAnnotation(x(chart), y(chart)), {
            color: { r: 150, g: 110, b: 230, a: 255 },
            isEditable: true,
            label: t('Trend'),
            appearance: { labelTurn: 'alongLine', labelPlace: 'middle', labelIcon: 'arrow', dash: 'dotted' },
          });
          trend.setEnds(0.4, -1.3, 4.6, -0.5);
          return trend;
        })
        .addOverlay((chart) => {
          const note = Object.assign(new TextAnnotation(x(chart), y(chart)), {
            text: t('Turned note'),
            isEditable: true,
            color: red,
            appearance: {
              labelTurn: 'angle',
              labelAngle: 15,
              labelFill: { ...red, a: 60 },
              labelBorder: red,
              labelColor: red,
            },
          });
          note.moveTo(6.6, -1.05);
          return note;
        })
        .addModifier(() => new AnnotationEditModifier())
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new CrosshairModifier());
    },
  },
  oscilloscopePage(),
  spectrumPage(),
  networkPage(),
  monitorPage('sweep'),
  monitorPage('stepping'),
  {
    id: 'scale-break',
    name: 'Scale break',
    group: 'Axes',
    hint: 'Wheel: zoom | Drag: pan across the break | Pointer: values | Double click: all',
    configure: (c) => {
      const data = new DataSource(2000);
      for (let i = 0; i < 2000; i++) {
        const x = i / 100;
        data.append(
          x,
          20 + 10 * Math.sin(x * 3) + 5 * Math.sin(x * 11) + 960 * Math.exp(-((x - 12) * (x - 12)) / 0.02),
        );
      }
      c.title(t('A peak and the small values beside it'))
        .xAxis((a) => a.numeric('x').title(t('Time in s')).range(0, 20))
        .yAxis((a) => a.numeric('y').title(t('Counts')).range(0, 1010).breaks(new DoubleRange(45, 960)))
        .addLine(data, (line) => line.name(t('Counts')).thickness(1.5))
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new CrosshairModifier())
        .addModifier(() => new TooltipModifier());
    },
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

// A raster of 8192 x 6144 cells (200 MB) in OPFS: hills, a lake without values, and fine ripples that only the
// A waterfall of 512 frequencies and 512 rows: a new row every frame, the newest at 0; the GPU gets one row each time.
function spectrogram(): Page {
  const data = new SpectrogramData(512, 512);
  let index = 0;
  const row = new Float32Array(512);
  const append = (): void => {
    const center = 256 + 200 * Math.sin(index * 0.03);
    for (let i = 0; i < 512; i++) {
      const distance = (i - center) / 6;
      const overtone = (i - center / 2) / 10;
      row[i] = Math.exp(-distance * distance) + 0.4 * Math.exp(-overtone * overtone) + 0.05 * Math.sin(i * 0.9);
    }
    data.appendRow(row);
    index++;
  };
  return {
    id: 'spectrogram',
    name: 'Spectrogram',
    group: 'Rasters',
    hint: 'Wheel over the color bar: values',
    configure: (c) =>
      c
        .theme(instrument)
        .xAxis((a) => a.numeric('x').range(0, 512).title(t('Frequency')))
        .yAxis((a) => a.numeric('y').range(-512, 0))
        .yAxis((a) => a.color('Plasma', 'values').range(-0.1, 1.1))
        .addSeries((x, y, axis) => new SpectrogramSeries(data, x, y, axis('values') as ColorAxis)),
    start: () => {
      let frame = 0;
      const feed = (): void => {
        append();
        frame = requestAnimationFrame(feed);
      };
      frame = requestAnimationFrame(feed);
      return {
        dispose: () => {
          cancelAnimationFrame(frame);
        },
      };
    },
  };
}

// Height lines of a field of 256 × 256 samples over filled bands, with their values along the lines.
function contour(): Page {
  return {
    id: 'contour',
    name: 'Contour',
    group: 'Rasters',
    hint: 'Wheel: zoom | Drag: pan, the labels move along | Double click: all',
    configure: (c) => {
      const size = 256;
      const values = new Float32Array(size * size);
      for (let row = 0; row < size; row++) {
        const y = (row * 6) / size;
        for (let column = 0; column < size; column++) {
          const x = (column * 6) / size;
          values[row * size + column] =
            Math.sin(x) * Math.cos(y * 1.3) + 0.6 * Math.exp(-((x - 2) * (x - 2) + (y - 4) * (y - 4)));
        }
      }
      const data = new HeatmapData(size, size);
      data.setValues(values);
      return c
        .theme(instrument)
        .xAxis((a) => a.numeric('x').range(0, 6))
        .yAxis((a) => a.numeric('y').range(0, 6))
        .yAxis((a) => a.color('Viridis', 'values'))
        .addSeries((x, y, axis) => {
          const series = new ContourSeries(data, x, y, axis('values') as ColorAxis);
          series.isFilled = true;
          series.showsLabels = true;
          series.levels = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25];
          series.xStep = 6 / size;
          series.yStep = 6 / size;
          return series;
        });
    },
  };
}

// A grid of 1024 × 1024 values, two waves and a hill with a gap, in the colors of a color axis beside the plot.
function heatmap(): Page {
  return {
    id: 'heatmap',
    name: 'Heatmap',
    group: 'Rasters',
    hint: 'Wheel: zoom | Drag: pan | Wheel over the color bar: values',
    configure: (c) => {
      const size = 1024;
      const values = new Float32Array(size * size);
      for (let row = 0; row < size; row++) {
        const y = (row * 8) / size;
        for (let column = 0; column < size; column++) {
          const x = (column * 8) / size;
          const missing = x > 5 && x < 6.5 && y > 1 && y < 2.5;
          values[row * size + column] = missing
            ? Number.NaN
            : Math.sin(x * x * 0.6) * Math.cos(y * 2.1) + Math.exp(-((x - 3) * (x - 3) + (y - 5) * (y - 5)));
        }
      }
      const data = new HeatmapData(size, size);
      data.setValues(values);
      return c
        .theme(instrument)
        .xAxis((a) => a.numeric('x').range(0, 8))
        .yAxis((a) => a.numeric('y').range(0, 8))
        .yAxis((a) => a.color('Inferno', 'values'))
        .addSeries((x, y, axis) => {
          const series = new HeatmapSeries(data, x, y, axis('values') as ColorAxis);
          series.xStep = 8 / size;
          series.yStep = 8 / size;
          return series;
        });
    },
  };
}

// raster itself holds; the stages show the whole of it at once.
const rasterFile = { path: 'showroom/terrain.tras', width: 8192, height: 6144 };

async function writeRasterFile(progress: (share: number) => void): Promise<void> {
  const handle = await opfsFile(rasterFile.path, true);
  const { width, height } = rasterFile;
  if ((await handle.getFile()).size >= 64 + width * height * 4) {
    return;
  }
  const writer = new RasterFileWriter(writableSink(await handle.createWritable()), {
    width,
    xStart: 0,
    xStep: 1 / 1024,
    yStart: 0,
    yStep: 1 / 1024,
  });
  const sine = Float32Array.from({ length: 4096 }, (_, i) => Math.sin((i / 4096) * Math.PI * 2));
  const wave = (turns: number): number => sine[Math.floor(turns * 4096) & 4095] as number;
  const rows = 128;
  const batch = new Float32Array(rows * width);
  for (let first = 0; first < height; first += rows) {
    for (let r = 0; r < rows; r++) {
      const y = first + r;
      for (let x = 0; x < width; x++) {
        const lake = (x - 5600) * (x - 5600) + 2 * (y - 2300) * (y - 2300) < 700 * 700;
        batch[r * width + x] = lake
          ? Number.NaN
          : 40 +
            25 * wave(x / 5000) * wave(y / 3700 + 0.25) +
            12 * wave((x + y) / 1900) +
            5 * wave(x / 23) * wave(y / 19);
      }
    }
    await writer.append(batch);
    progress((first + rows) / height);
  }
  await writer.close();
}

function rasterFromALargeFile(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Double click: all';
  const loading = new LoadingOverlay();
  return {
    id: 'raster-from-a-large-file',
    name: 'Raster from a large file',
    group: 'Rasters',
    hint,
    configure: (c) => {
      loading.show(t('Loading data'));
      c.addOverlay(() => loading)
        .theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      const run = { stopped: false };
      const stopped = (): boolean => run.stopped;
      let raster: LargeRaster | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(hint, loading);
      void (async () => {
        await writeRasterFile((share) => {
          say(t('The first visit writes a raster file of 200 MB'), share);
        });
        if (stopped()) {
          return;
        }
        const opened = await LargeRaster.open({ opfs: rasterFile.path });
        if (stopped()) {
          opened.close();
          return;
        }
        raster = opened;
        const status = (): void => {
          say(
            opened.isReady
              ? `${t('50 million cells; zoom in for the ripples')} | ${t('Stages')} ${took(opened)}`
              : `${t('Stages')} ${String(Math.floor(opened.progress * 100))} %`,
          );
        };
        opened.onChange(status);
        status();
        if (chart) {
          chart.chart = new ChartBuilder()
            .addOverlay((built) => refining(built))
            .theme(instrument)
            .xAxis((a) => a.numeric('x').title(t('East in km')).autoRange())
            .yAxis((a) => a.numeric('y').title(t('North in km')).autoRange())
            .addSeries((x, y) => {
              const series = new FileRasterSeries(opened, x, y);
              series.colormap = Colormap.builtIn('Turbo');
              return series;
            });
        }
      })();
      return {
        dispose: () => {
          run.stopped = true;
          raster?.close();
        },
      };
    },
  };
}

function raster(): Page {
  return {
    id: 'raster',
    name: 'Raster',
    group: 'Rasters',
    hint: 'Wheel: zoom | Drag: pan | Double click: all',
    configure: (c) => {
      // A field of 400 x 300 cells: two peaks and a valley, colored by Inferno.
      const columns = 400;
      const rows = 300;
      const values = new Float32Array(columns * rows);
      for (let r = 0; r < rows; r++) {
        for (let col = 0; col < columns; col++) {
          const x = col / 40 - 5;
          const y = r / 40 - 3.75;
          values[r * columns + col] =
            Math.exp(-((x - 1.5) ** 2 + (y - 1) ** 2)) +
            0.8 * Math.exp(-((x + 2) ** 2 + (y + 1) ** 2) / 1.5) -
            0.5 * Math.exp(-((x - 0.5) ** 2 + (y + 2) ** 2) / 0.5);
        }
      }
      numeric(c, -5, 5, -3.75, 3.75).addSeries((x, y) => {
        const series = new RasterSeries(x, y);
        series.colormap = Colormap.builtIn('Inferno');
        series.valueRange = new DoubleRange(-0.5, 1);
        series.setValues(values, columns, rows, { left: -5, right: 5, bottom: -3.75, top: 3.75 });
        return series;
      });
    },
  };
}

// 20 million points in clusters and a ring (160 MB as two float32 columns in OPFS), drawn as a density: the grid of
// the point tiles for the whole of it, the points of the visible tiles when zoomed in.
const pointsFile = { path: 'showroom/points.tcol', count: 20_000_000 };

async function writePointsFile(progress: (share: number) => void): Promise<void> {
  const handle = await opfsFile(pointsFile.path, true);
  if ((await handle.getFile()).size >= 64 + pointsFile.count * 8) {
    return;
  }
  const writer = new ColumnFileWriter(writableSink(await handle.createWritable()), { type: 'float32', columns: 2 });
  const centers = [
    [2, 3, 0.6],
    [6, 7, 1.2],
    [7.5, 2.5, 0.35],
    [4, 5.5, 2.5],
  ] as const;
  let seed = 12_345;
  const uniform = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  // Normal, by Box and Muller.
  const normal = (): number => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
  const chunk = new Float32Array(2 * (1 << 20));
  for (let first = 0; first < pointsFile.count; first += chunk.length / 2) {
    const size = Math.min(chunk.length / 2, pointsFile.count - first);
    for (let i = 0; i < size; i++) {
      const pick = uniform();
      if (pick < 0.15) {
        // A thin ring around the middle.
        const angle = uniform() * Math.PI * 2;
        const radius = 3.6 + normal() * 0.03;
        chunk[i * 2] = 5 + radius * Math.cos(angle);
        chunk[i * 2 + 1] = 5 + radius * Math.sin(angle);
      } else {
        const [x, y, spread] = centers[Math.floor(uniform() * centers.length)] ?? centers[0];
        chunk[i * 2] = x + normal() * spread * 0.5;
        chunk[i * 2 + 1] = y + normal() * spread * 0.5;
      }
    }
    await writer.append(size * 2 === chunk.length ? chunk : chunk.subarray(0, size * 2));
    progress((first + size) / pointsFile.count);
  }
  await writer.close();
}

function scatterDensityFromAFile(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Double click: all';
  const loading = new LoadingOverlay();
  return {
    id: 'scatter-density-from-a-file',
    name: 'Scatter density from a file',
    group: 'Points and areas',
    hint,
    configure: (c) => {
      loading.show(t('Loading data'));
      c.addOverlay(() => loading)
        .theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      const run = { stopped: false };
      const stopped = (): boolean => run.stopped;
      let tiles: PointTiles | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(hint, loading);
      void (async () => {
        await writePointsFile((share) => {
          say(t('The first visit writes 20 million points (160 MB)'), share);
        });
        if (stopped()) {
          return;
        }
        const opened = await PointTiles.open({ opfs: pointsFile.path });
        if (stopped()) {
          opened.close();
          return;
        }
        tiles = opened;
        const status = (): void => {
          say(
            opened.isReady
              ? `${t('20 million points as a density; zoom in down to single points')} | ${t('Tiles')} ${took(opened)}`
              : `${t('Tiles')} ${String(Math.floor(opened.progress * 100))} %`,
          );
        };
        opened.onChange(status);
        status();
        if (chart) {
          chart.chart = new ChartBuilder()
            .addOverlay((built) => refining(built))
            .theme(instrument)
            .xAxis((a) => a.numeric('x').autoRange())
            .yAxis((a) => a.numeric('y').autoRange())
            .addSeries((x, y) => {
              const series = new PointDensitySeries(opened, x, y);
              series.colormap = Colormap.builtIn('Inferno');
              return series;
            });
        }
      })();
      return {
        dispose: () => {
          run.stopped = true;
          tiles?.close();
        },
      };
    },
  };
}
