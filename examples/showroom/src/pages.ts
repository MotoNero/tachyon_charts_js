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
  DoubleRange,
  DataSource,
  TimeGapMap,
  TooltipModifier,
  FifoDataSource,
  ChartBuilder,
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
  SelectionModifier,
  MeasureCursorModifier,
  OverviewModifier,
  RolloverModifier,
  type Axis,
  type ChartSurface,
  RasterSeries,
  Colormap,
} from '@tachyon-charts/core';

import { t } from './texts';
import {
  type Page,
  plain,
  points,
  bars,
  instrument,
  sample,
  cloud,
  radialAxis,
  numeric,
  temperatures,
  curve,
  pieValues,
  pieNames,
  type PageEntry,
  lazyPages,
} from './page-kit';

/**
 * A page: its name in the navigation, its group, the hint for the input and the chart. Names, groups and hints are the
 * English keys of texts.ts; `configure` gets the theme the chart is shown in.
 */
/** What a running page keeps: a worker or a timer to stop when the next page shows, and a line for the hint. */
// Writes the hint of a page and a status after it.
// The share refined of the series that start coarse, in the language of the page.
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
// The pages of 3D, maps and medical images and those with large files come with their code when first shown.
const heavy = lazyPages(
  [
    {
      id: 'spectrum-waterfall-3d',
      name: 'Spectrum waterfall',
      group: '3D',
      hint: 'Above: drag to turn | Below: wheel: frequency, Ctrl+click: add or remove a marker',
    },
    {
      id: 'coupled-3d',
      name: 'Coupled with 2D',
      group: '3D',
      hint: 'Below: wheel and drag zoom the box above, the crosshair shows in it | Above: drag to turn',
    },
    {
      id: 'cut-3d',
      name: 'Cut as a 2D chart',
      group: '3D',
      hint: 'Above: drag the orange outline to move the cut | Below: the cut as a line, wheel and drag zoom both',
    },
    {
      id: 'cloud-pages-3d',
      name: 'Cloud from pages, 50 million',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it | The first visit writes a test file of 600 MB',
    },
    {
      id: 'cut-planes-3d',
      name: 'Cut planes',
      group: '3D',
      hint: 'Drag the orange outline: move the plane | Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start',
    },
    {
      id: 'model-3d',
      name: 'Model with measuring points',
      group: '3D',
      hint: 'Drag the orange outline: move the plane | Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start',
    },
    {
      id: 'planes-and-limits-3d',
      name: 'Planes and limits',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'cloud-3d',
      name: 'Point cloud',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'cloud-10m-3d',
      name: 'Point cloud, 10 million',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'cloud-from-las-3d',
      name: 'Cloud from a LAS file',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'volume-slices-3d',
      name: 'Volume slices',
      group: '3D',
      hint: 'Drag the orange outline: move the plane | Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start',
    },
    {
      id: 'volume-maximum-3d',
      name: 'Maximum projection',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'volume-surface-3d',
      name: 'Surface of equal value',
      group: '3D',
      hint: 'Drag the orange outline: move the slice | Drag a point or the slider at the top right: change the look | Drag: turn | Wheel: zoom',
    },
    {
      id: 'volume-through-3d',
      name: 'Through a volume',
      group: '3D',
      hint: 'Drag the orange outline: move the slice | Drag a point or the slider at the top right: change the look | Drag: turn | Wheel: zoom',
    },
    {
      id: 'volume-nifti-3d',
      name: 'Volume from a NIfTI file',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'map-3d',
      name: 'Map from measurements',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'antenna-3d',
      name: 'Antenna pattern',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'pie-3d',
      name: 'Pie 3D',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'donut-3d',
      name: 'Donut 3D',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'model-1m-triangles',
      name: 'Model of 1 million triangles',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'mesh-3d',
      name: 'Lit mesh',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'see-through-3d',
      name: 'See-through',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'waterfall-3d',
      name: 'Waterfall, live',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'axis-box',
      name: 'Axis box',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'path-200000',
      name: 'Path of 200,000 points',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'scatter-3000',
      name: 'Scatter of 3,000 points',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'height-lines',
      name: 'Height lines',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'columns-3d',
      name: 'Columns',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'bubbles-3d',
      name: 'Bubbles',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'surface-4096',
      name: 'Surface 4096 × 4096',
      group: '3D',
      hint: 'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it',
    },
    {
      id: 'world-map',
      name: 'World map',
      group: 'Maps',
      hint: 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all',
    },
    {
      id: 'tile-map',
      name: 'Tile map',
      group: 'Maps',
      hint: 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all | Server: ?tiles=<address with {z}, {x}, {y}>&attribution=<notice>',
    },
    {
      id: 'medical-files',
      name: 'Medical files',
      group: 'Medical',
      hint: 'Left drag: window and level | Keys 1, 2, 3: brain, bone, lung | Middle drag: pan | Wheel: zoom | Pointer: value and position',
    },
    {
      id: 'medical-mpr',
      name: 'Medical MPR',
      group: 'Medical',
      hint: 'Wheel or arrows: slices | Space: play, + and -: speed | Click: place | Drag: window and level | Keys 1, 2, 3: brain, bone, lung | Keys D, A, C, R, F: measure | Del: delete | Ctrl+Z: undo',
    },
    {
      id: 'medical-analysis',
      name: 'Medical analysis',
      group: 'Medical',
      hint: 'Drag a point of the line or the circle: profile and histogram follow | Drag elsewhere: window, the band in the histogram follows | Wheel: slices',
    },
    {
      id: 'medical-reformat',
      name: 'Medical oblique and curved',
      group: 'Medical',
      hint: 'Drag an end of the line: the oblique plane follows | Drag a point of the arc: the curved section follows | Wheel on the oblique plane: move it | Key V on the oblique plane: it faces the 3D view | Drag elsewhere: window',
    },
    {
      id: 'medical-segmentation',
      name: 'Medical segmentation',
      group: 'Medical',
      hint: 'Wheel or arrows: slices | Space: play, + and -: speed | Click: place | Drag: window and level | Keys 1, 2, 3: brain, bone, lung | Keys D, A, C, R, F: measure | Del: delete | Ctrl+Z: undo',
    },
    {
      id: 'medical-measurements',
      name: 'Medical measurements',
      group: 'Medical',
      hint: 'Keys D, A, C, R, F or the bar: distance, angle, circle, rectangle, freehand, then drag | Drag a point: change | Delete: remove | Ctrl+Z: undo | Left drag elsewhere: window',
    },
    {
      id: 'medical-image',
      name: 'Medical image',
      group: 'Medical',
      hint: 'Left drag: window and level | Keys 1, 2, 3: brain, bone, lung | Middle drag: pan | Wheel: zoom | Pointer: value and position',
    },
  ],
  async () => (await import('./pages-3d')).heavyPages(),
);
const large = lazyPages(
  [
    {
      id: 'line-from-a-large-file',
      name: 'Line from a large file',
      group: 'Lines',
      hint: 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all',
    },
    {
      id: 'line-from-a-csv-file',
      name: 'Line from a CSV file',
      group: 'Lines',
      hint: 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all',
    },
    {
      id: 'recording',
      name: 'Recording',
      group: 'Lines',
      hint: 'Wheel: zoom | Drag: pan | Double click: all, rolling',
    },
    {
      id: 'digital-channels',
      name: 'Digital channels',
      group: 'Lines',
      hint: 'Wheel: zoom | Drag: pan | Double click: all',
    },
    {
      id: 'raster-from-a-large-file',
      name: 'Raster from a large file',
      group: 'Rasters',
      hint: 'Wheel: zoom | Drag: pan | Double click: all',
    },
    {
      id: 'scatter-density-from-a-file',
      name: 'Scatter density from a file',
      group: 'Points and areas',
      hint: 'Wheel: zoom | Drag: pan | Double click: all',
    },
  ],
  async () => (await import('./pages-large')).largePages(),
);
const largePage = (id: string): PageEntry => large.find((page) => page.id === id) as PageEntry;

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

export const pages: readonly PageEntry[] = [
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
  largePage('line-from-a-large-file'),
  largePage('line-from-a-csv-file'),
  largePage('recording'),
  largePage('digital-channels'),
  raster(),
  heatmap(),
  spectrogram(),
  contour(),
  largePage('raster-from-a-large-file'),
  largePage('scatter-density-from-a-file'),
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
  ...heavy,
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
export type { Page, PageEntry, PageRun } from './page-kit';
