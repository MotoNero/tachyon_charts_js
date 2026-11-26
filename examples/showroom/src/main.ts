// The showroom: a page for every finished feature, as in the showroom of the .NET version. The pages are in pages.ts;
// this file builds the navigation, shows the chosen page in one <tachyon-chart> and switches theme and language.
import {
  builtInThemes,
  ChartBuilder,
  chartText,
  findBuiltInTheme,
  type ChartLanguage,
  type ThemeDocument,
} from '@tachyon-charts/core';
import { defineTachyonChart, preferredTheme, TachyonChartElement } from '@tachyon-charts/element';
import logo from '../../../shared/logo/tachyon-charts-lockup-dark-transparent.svg?url';
import icon from '../../../shared/logo/tachyon-charts-avatar-dark-32.png?url';
import { pages, type Page, type PageRun } from './pages';
import { t } from './texts';

const instrumentTheme = findBuiltInTheme('instrument') as ThemeDocument;

// ?render=main draws on the main thread instead of the render worker, to compare both.
TachyonChartElement.renderInWorker = new URLSearchParams(location.search).get('render') !== 'main';
// ?renderer=webgl2 or ?renderer=canvas2d draws with a fallback instead of WebGPU, ?renderer=webgpu only with WebGPU.
const renderer = new URLSearchParams(location.search).get('renderer');
if (renderer === 'webgl2' || renderer === 'webgpu' || renderer === 'canvas2d') {
  TachyonChartElement.renderer = renderer;
}
defineTachyonChart();

const chart = document.querySelector<TachyonChartElement>('#chart');
const navigation = document.querySelector<HTMLElement>('#navigation');
const title = document.querySelector<HTMLElement>('#title');
const hint = document.querySelector<HTMLElement>('#hint');
const themeChoice = document.querySelector<HTMLSelectElement>('#theme');
const languageChoice = document.querySelector<HTMLSelectElement>('#language');
const tip = document.querySelector<HTMLElement>('#tip');
document.querySelector<HTMLImageElement>('#logo')?.setAttribute('src', logo);
document.querySelector<HTMLLinkElement>('#icon')?.setAttribute('href', icon);

// The navigation, grouped as the pages say.
const links = new Map<string, HTMLAnchorElement>();
const headings: [HTMLElement, string][] = [];
let group = '';
for (const page of pages) {
  if (page.group !== group) {
    group = page.group;
    const heading = document.createElement('h2');
    headings.push([heading, group]);
    navigation?.append(heading);
  }
  const link = document.createElement('a');
  link.href = `#${page.id}`;
  links.set(page.id, link);
  navigation?.append(link);
}

// The texts of the page in the language of the charts.
function translate(): void {
  document.documentElement.lang = chartText.language === 'german' ? 'de' : 'en';
  for (const [heading, key] of headings) {
    heading.textContent = t(key);
  }
  for (const page of pages) {
    const link = links.get(page.id);
    if (link) {
      link.textContent = t(page.name);
    }
  }
  for (const label of document.querySelectorAll<HTMLElement>('[data-text]')) {
    label.textContent = t(label.dataset.text ?? '');
  }
  const thread = document.querySelector<HTMLElement>('#thread');
  if (thread && chart?.renderThread) {
    const place = t(chart.renderThread === 'worker' ? 'Drawn in the render worker' : 'Drawn on the main thread');
    // The renderer with the graphics card it runs on, such as WebGPU (nvidia lovelace); a software renderer such as
    // swiftshader means the processor draws.
    thread.textContent = chart.rendererName ? `${place} · ${chart.rendererName}` : place;
  }
  for (const option of themeChoice?.options ?? []) {
    if (option.dataset.text) {
      option.textContent = t(option.dataset.text);
    }
  }
}

// The theme the chart is shown in: the chosen one, the page's own (Instrument) or light or dark after the system.
function effectiveTheme(): ThemeDocument {
  const chosen = themeChoice?.value ?? '';
  if (chosen === '') {
    return instrumentTheme;
  }
  return (chosen === 'auto' ? undefined : findBuiltInTheme(chosen)) ?? preferredTheme();
}

let running: PageRun | undefined;

function show(page: Page): void {
  if (!chart) {
    return;
  }
  const builder = new ChartBuilder();
  running?.dispose();
  page.configure(builder, effectiveTheme());
  running = page.start?.();
  chart.chart = builder;
  if (title) {
    title.textContent = t(page.name);
  }
  if (hint) {
    hint.textContent = running?.status ? `${t(page.hint)} | ${t(running.status)}` : t(page.hint);
  }
  for (const [id, link] of links) {
    if (id === page.id) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
  document.title = `${t(page.name)} – Tachyon Charts`;
}

function route(): void {
  const id = location.hash.slice(1);
  show(pages.find((page) => page.id === id) ?? (pages[0] as Page));
}
window.addEventListener('hashchange', route);

// The theme: the one of the page, light or dark after the system, or a built-in one for every page.
if (themeChoice) {
  const options: [string, string][] = [
    ['', 'Of the page'],
    ['auto', 'Light or dark, as the system'],
    ...builtInThemes.map((theme): [string, string] => [theme.name, theme.name]),
  ];
  for (const [value, label] of options) {
    const option = new Option(label, value);
    if (value === '' || value === 'auto') {
      option.dataset.text = label;
    }
    themeChoice.append(option);
  }
  themeChoice.addEventListener('change', () => {
    if (themeChoice.value === '') {
      chart?.removeAttribute('theme');
    } else {
      chart?.setAttribute('theme', themeChoice.value);
    }
    chart?.surface?.invalidate();
    // The element takes the theme of the page again only with its chart.
    route();
  });
}

// The language of the charts and of the page; the pages are built anew for their titles and names.
languageChoice?.addEventListener('change', () => {
  chartText.language = languageChoice.value as ChartLanguage;
  translate();
  route();
});

translate();
route();
void chart?.ready.then(translate);
// A 3D page draws on the main thread with a device of its own: the label follows each new start.
chart?.addEventListener('tachyon-ready', translate);

// The point under the pointer, as the element reports it.
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

// Export of the chart shown: the file goes to the downloads, named after the page.
function download(content: Blob | string, extension: string, type: string): void {
  const blob = typeof content === 'string' ? new Blob([content], { type }) : content;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${location.hash.slice(1) || 'chart'}.${extension}`;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
  }, 1000);
}

function onExport(id: string, run: (button: HTMLButtonElement) => Promise<void>): void {
  const button = document.querySelector<HTMLButtonElement>(id);
  button?.addEventListener('click', () => {
    button.disabled = true;
    run(button)
      .catch((error: unknown) => {
        console.error(error);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

if (chart) {
  const size = (): { width: number; height: number } => ({
    width: Math.round(chart.clientWidth),
    height: Math.round(chart.clientHeight),
  });
  onExport('#export-png', async () => {
    download(await chart.exportPng({ ...size(), dpi: 192 }), 'png', 'image/png');
  });
  onExport('#export-svg', async () => {
    download(await chart.exportSvg(size()), 'svg', 'image/svg+xml');
  });
  onExport('#export-csv', async () => {
    download(await chart.exportCsv(), 'csv', 'text/csv');
  });
  // Three seconds of the chart as it is; a page that streams keeps streaming into the video.
  onExport('#export-video', async () => {
    download(await chart.recordVideo({ ...size(), duration: 3 }), 'webm', 'video/webm');
  });
}
