// The configurator as a web app: a description of a chart is edited on the right, the chart shows in the middle and
// its code below it. The preview runs exactly the code shown, so what is copied draws the same chart.
import {
  ChartCatalog,
  ChartSpecProblem,
  applyChartSpecs,
  chartCode,
  coreModule,
  medicalModule,
  newChartSpec,
  readChartSpec,
  writeChartSpec,
  type ChartSpec,
  type CodeLanguage,
  type ParameterInfo,
  type SeriesSpec,
  type SpecValues,
} from '@tachyon-charts/configurator';
import { ChartBuilder } from '@tachyon-charts/core';
import { defineTachyonChart, type TachyonChartElement } from '@tachyon-charts/element';
import logo from '../../../shared/logo/tachyon-charts-lockup-dark-transparent.svg?url';
import icon from '../../../shared/logo/tachyon-charts-avatar-dark-32.png?url';

defineTachyonChart();

const catalog = new ChartCatalog([coreModule, medicalModule]);
const themes = ['TachyonDark', 'TachyonLight', 'Instrument', 'Paper', 'Signal', 'Neon', 'HighContrast'];

const element = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`The page lacks #${id}.`);
  }
  return found;
};
const chart = element('chart') as TachyonChartElement;
const editor = element('editor');
const viewGrid = element('views');
const codeView = element('code');
const problemView = element('problem');
const language = element('language') as HTMLSelectElement;
(element('logo') as HTMLImageElement).src = logo;
(element('icon') as HTMLLinkElement).href = icon;

interface Template {
  readonly name: string;
  readonly id: string;
  readonly spec: ChartSpec;
  readonly ready: boolean;
}

let templates: Template[] = [];

let spec: ChartSpec = newChartSpec();
let code = '';
const running: (() => void)[] = [];

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function row(label: string, input: HTMLElement, title?: string): HTMLLabelElement {
  const node = make('label', { className: 'row' }, make('span', { textContent: label }), input);
  if (title !== undefined) {
    node.title = title;
  }
  return node;
}

function select(
  choices: readonly string[],
  value: string,
  change: (value: string) => void,
  names?: readonly string[],
): HTMLSelectElement {
  const node = make('select');
  choices.forEach((choice, i) => {
    node.append(make('option', { value: choice, textContent: names?.[i] ?? choice }));
  });
  node.value = value;
  node.addEventListener('change', () => {
    change(node.value);
  });
  return node;
}

function parameterEditor(info: ParameterInfo, values: SpecValues): HTMLElement {
  const current = values[info.name] ?? info.default;
  const set = (value: number | boolean | string): void => {
    values[info.name] = value;
    refresh();
  };
  switch (info.kind) {
    case 'flag': {
      const input = make('input', { type: 'checkbox', checked: current === true });
      input.addEventListener('change', () => {
        set(input.checked);
      });
      return row(info.label, input, info.description);
    }
    case 'choice':
      return row(info.label, select(info.choices ?? [], String(current), set), info.description);
    case 'number':
    case 'integer': {
      const input = make('input', {
        type: 'number',
        value: String(current),
        step: info.kind === 'integer' ? '1' : 'any',
      });
      if (info.minimum !== undefined) {
        input.min = String(info.minimum);
      }
      if (info.maximum !== undefined) {
        input.max = String(info.maximum);
      }
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (Number.isFinite(value)) {
          set(value);
        }
      });
      return row(info.label, input, info.description);
    }
    default: {
      const input = make('input', {
        type: 'text',
        value: String(current),
        placeholder: info.kind === 'color' ? '#RRGGBB' : '',
      });
      input.addEventListener('change', () => {
        set(input.value.trim());
      });
      return row(info.label, input, info.description);
    }
  }
}

function newSeries(typeId: string): SeriesSpec {
  const type = catalog.findType(typeId);
  const sample = catalog.findSample(type?.defaultSample ?? '');
  return {
    type: typeId,
    name: type?.name ?? typeId,
    parameters: {},
    data: { kind: 'sample', sample: sample?.id ?? '', count: sample?.defaultCount ?? 100, options: {} },
  };
}

function seriesEditor(series: SeriesSpec, index: number): HTMLElement {
  const box = make('div', { className: 'series' });
  const remove = make('button', { textContent: 'Remove', title: 'Remove the series' });
  remove.addEventListener('click', () => {
    spec.series.splice(index, 1);
    showEditor();
    refresh();
  });
  box.append(
    make('div', { className: 'head' }, make('strong', { textContent: `Series ${String(index + 1)}` }), remove),
  );
  const types = catalog.types;
  box.append(
    row(
      'Type',
      select(
        types.map((type) => type.id),
        series.type,
        (value) => {
          spec.series[index] = { ...newSeries(value), name: series.name };
          const first = spec.xAxes[0];
          if (catalog.findType(value)?.usesTime === true && first) {
            first.kind = 'dateTime';
          }
          showEditor();
          refresh();
        },
        types.map((type) => type.name),
      ),
    ),
  );
  const name = make('input', { type: 'text', value: series.name });
  name.addEventListener('change', () => {
    series.name = name.value;
    refresh();
  });
  box.append(row('Name', name));
  const type = catalog.findType(series.type);
  const samples = catalog.samples.filter((sample) => sample.shape === type?.shape);
  box.append(
    row(
      'Data',
      select(
        samples.map((sample) => sample.id),
        series.data.sample,
        (value) => {
          series.data.sample = value;
          series.data.count = catalog.findSample(value)?.defaultCount ?? series.data.count;
          showEditor();
          refresh();
        },
        samples.map((sample) => sample.name),
      ),
    ),
  );
  if (catalog.findSample(series.data.sample)?.hasCount !== false) {
    box.append(
      parameterEditor(
        { name: 'count', label: 'Values', kind: 'integer', default: series.data.count, minimum: 2 },
        {
          get count(): number {
            return series.data.count;
          },
          set count(value: number) {
            series.data.count = Math.max(2, Math.round(value));
          },
        },
      ),
    );
  }
  for (const parameter of type?.parameters ?? []) {
    box.append(parameterEditor(parameter, series.parameters));
  }
  return box;
}

function showEditor(): void {
  editor.replaceChildren();
  editor.append(make('h2', { textContent: 'Chart' }));
  const title = make('input', { type: 'text', value: spec.title });
  title.addEventListener('change', () => {
    spec.title = title.value;
    refresh();
  });
  editor.append(row('Title', title));
  editor.append(
    row(
      'Theme',
      select(
        ['', ...themes],
        spec.theme ?? '',
        (value) => {
          spec.theme = value.length > 0 ? value : undefined;
          refresh();
        },
        ['Of the page', ...themes],
      ),
    ),
  );
  editor.append(make('h2', { textContent: 'Series' }));
  spec.series.forEach((series, index) => {
    editor.append(seriesEditor(series, index));
  });
  const add = make('button', { textContent: 'Add a series' });
  add.addEventListener('click', () => {
    spec.series.push(newSeries('line'));
    showEditor();
    refresh();
  });
  editor.append(add);
  editor.append(make('h2', { textContent: 'Interactions' }));
  for (const info of catalog.modifiers) {
    const at = spec.modifiers.findIndex((modifier) => modifier.type === info.id);
    const input = make('input', { type: 'checkbox', checked: at >= 0 });
    input.dataset.modifier = info.id;
    input.addEventListener('change', () => {
      if (input.checked) {
        spec.modifiers.push({ type: info.id, parameters: {} });
      } else {
        spec.modifiers = spec.modifiers.filter((modifier) => modifier.type !== info.id);
      }
      showEditor();
      refresh();
    });
    editor.append(row(info.name, input));
    const chosen = spec.modifiers[at];
    if (chosen) {
      for (const parameter of info.parameters) {
        editor.append(parameterEditor(parameter, chosen.parameters));
      }
    }
  }
  const legend = make('input', { type: 'checkbox', checked: spec.legend !== undefined });
  legend.addEventListener('change', () => {
    spec.legend = legend.checked ? { title: '', placement: 'TopRight', series: '' } : undefined;
    refresh();
  });
  editor.append(make('h2', { textContent: 'Legend' }), row('Show a legend', legend));
}

let shown = 0;

function refresh(): void {
  const ticket = ++shown;
  catalog.load(spec).then(
    () => {
      if (ticket === shown) {
        show();
      }
    },
    (error: unknown) => {
      problemView.textContent = error instanceof Error ? error.message : String(error);
    },
  );
}

// The chart and its code, once the packages of its modules have arrived.
function show(): void {
  try {
    code = chartCode(spec, catalog, language.value as CodeLanguage);
    codeView.textContent = code;
    problemView.textContent = '';
    // Live data of the chart before stop; those of the new one start.
    for (const stop of running.splice(0)) {
      stop();
    }
    const described = applyChartSpecs(spec, catalog, running, new ChartBuilder());
    const [first] = described.charts;
    if (described.charts.length === 1 && first) {
      chart.hidden = false;
      viewGrid.hidden = true;
      viewGrid.replaceChildren();
      chart.chart = first;
    } else {
      // Linked charts stand in a grid of their own; the single chart rests meanwhile.
      chart.hidden = true;
      viewGrid.hidden = false;
      viewGrid.style.gridTemplateColumns = `repeat(${String(described.columns)}, minmax(0, 1fr))`;
      viewGrid.replaceChildren(
        ...described.charts.map((builder) => {
          const view = document.createElement('tachyon-chart');
          view.chart = builder;
          return view;
        }),
      );
    }
  } catch (error: unknown) {
    problemView.textContent =
      error instanceof ChartSpecProblem
        ? error.problems.join(' ')
        : error instanceof Error
          ? error.message
          : String(error);
  }
}

function open(next: ChartSpec, id?: string): void {
  spec = next;
  for (const link of document.querySelectorAll('nav a')) {
    if (link.getAttribute('href') === `#${id ?? ''}`) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
  showEditor();
  refresh();
}

function showTemplates(): void {
  const nav = element('templates');
  nav.append(make('h2', { textContent: 'Templates' }));
  for (const template of templates.filter((item) => item.ready)) {
    nav.append(make('a', { href: `#${template.id}`, textContent: template.name }));
  }
  nav.append(make('h2', { textContent: 'In a later version' }));
  for (const template of templates.filter((item) => !item.ready)) {
    nav.append(
      make('a', {
        className: 'later',
        textContent: template.name,
        title: 'Not yet in the configurator for JavaScript.',
      }),
    );
  }
}

function openFromHash(): void {
  const id = location.hash.slice(1);
  const template = templates.find((item) => item.ready && item.id === id) ?? templates.find((item) => item.ready);
  if (template) {
    open(structuredClone(template.spec), template.id);
  }
}

element('new').addEventListener('click', () => {
  const next = newChartSpec();
  next.series.push(newSeries('line'));
  next.modifiers.push({ type: 'zoompan', parameters: {} });
  history.replaceState(null, '', location.pathname + location.search);
  open(next);
});
const fileInput = element('file') as HTMLInputElement;
element('open').addEventListener('click', () => {
  fileInput.click();
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) {
    return;
  }
  file.text().then(
    (text) => {
      open(readChartSpec(text));
    },
    (error: unknown) => {
      problemView.textContent = error instanceof Error ? error.message : String(error);
    },
  );
  fileInput.value = '';
});
element('save').addEventListener('click', () => {
  const link = make('a', {
    href: URL.createObjectURL(new Blob([writeChartSpec(spec)], { type: 'application/json' })),
    download: `${spec.title.length > 0 ? spec.title.replace(/\W+/gu, '-').toLowerCase() : 'chart'}.chart.json`,
  });
  link.click();
  URL.revokeObjectURL(link.href);
});
element('copy').addEventListener('click', () => {
  void navigator.clipboard.writeText(code);
});
language.addEventListener('change', refresh);
window.addEventListener('hashchange', openFromHash);

const { pages } = await import('./templates');
templates = pages.map(({ name, id, text }) => {
  const spec = readChartSpec(text);
  const ready = spec.charts.length === 0 && Object.keys(spec.scene).length === 0 && catalog.check(spec).length === 0;
  return { name, id, spec, ready };
});
showTemplates();
openFromHash();
