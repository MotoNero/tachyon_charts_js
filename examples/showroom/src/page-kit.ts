// What the pages of the showroom share: their form, the pages loaded on demand and small helpers.
import {
  DataSource,
  ChartBuilder,
  findBuiltInTheme,
  RefiningOverlay,
  LoadingOverlay,
  type ThemeDocument,
  type Axis,
  type ChartSurface,
} from '@tachyon-charts/core';
import { t } from './texts';
export function refining(chart: ChartSurface): RefiningOverlay {
  const overlay = new RefiningOverlay(chart);
  overlay.format = (share) => `${t('Refining')} ${String(Math.floor(share * 100))} %`;
  return overlay;
}

export function sayer(hint: string, loading?: LoadingOverlay): (text: string, share?: number) => void {
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
export function took(opened: { isFromCache: boolean; buildMilliseconds: number }): string {
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

export const plain = 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all';
export const points = `${plain} | Pointer: values`;
export const bars = [
  [3, 5, 2, 6, 4, 7],
  [2, 1, 4, 3, 5, 2],
  [1, 3, 2, 2, 2, 3],
];

export const instrument = findBuiltInTheme('instrument') as ThemeDocument;

/** Points of a curve at `count` places from 0 to `length`. */
export function sample(curve: (x: number) => number, count = 300, length = 10): DataSource {
  const data = new DataSource(count);
  for (let i = 0; i < count; i++) {
    const x = (i * length) / (count - 1);
    data.append(x, curve(x));
  }
  return data;
}

export function cloud(): DataSource {
  const data = new DataSource(40);
  for (let i = 0; i < 40; i++) {
    data.append(0.5 + 9 * ((i * 0.618) % 1), 0.5 + 9 * ((i * 0.7549) % 1));
  }
  return data;
}

// The radial axis of a polar chart: the axis of its only pane.
export function radialAxis(chart: ChartSurface): Axis {
  return chart.panes[0]?.axes[0] as Axis;
}

export function numeric(c: ChartBuilder, left: number, right: number, bottom: number, top: number): ChartBuilder {
  return c
    .theme(instrument)
    .xAxis((a) => a.numeric('x').range(left, right))
    .yAxis((a) => a.numeric('y').range(bottom, top));
}

// Two weeks in Berlin over the change to summer time, in milliseconds as Date gives them.
export function temperatures(): DataSource {
  const start = Date.UTC(2026, 2, 22);
  const data = new DataSource();
  for (let hour = 0; hour <= 14 * 24; hour++) {
    const time = start + hour * 3_600_000;
    data.append(time, 8 + 6 * Math.sin(((hour - 9) / 24) * Math.PI * 2) + hour / 60);
  }
  return data;
}

export function curve(): DataSource {
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
export const pieValues = [32, 18, 15, 14, 9, 6, 3, 1.5, 1, 0.5];
export const pieNames = ['Wind', 'Solar', 'Gas', 'Coal', 'Biomass', 'Hydro', 'Nuclear', 'Oil', 'Other', 'Geothermal'];

// Three temperatures arriving live, each with a plate of its newest value at the axis; plates that meet move apart,
// as the last value page of the .NET showroom.

/** A page whose code comes when it is first shown: its place in the navigation first, the rest on demand. */
export interface LazyPage {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly hint: string;
  load(): Promise<Page>;
}

/** A page of the navigation, ready or still to load. */
export type PageEntry = Page | LazyPage;

/** The pages of a module loaded on demand, each with its place in the navigation. */
export function lazyPages(
  entries: readonly Omit<LazyPage, 'load'>[],
  load: () => Promise<readonly Page[]>,
): LazyPage[] {
  return entries.map((entry) => ({
    ...entry,
    load: async () => {
      const found = (await load()).find((page) => page.id === entry.id);
      if (!found) {
        throw new Error(`The page ${entry.id} is missing in its module.`);
      }
      return found;
    },
  }));
}
