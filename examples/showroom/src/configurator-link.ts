// The description of a showroom page in the configurator, as ConfiguratorLink of the .NET version: by the id of the
// page, by its name, or by the table below where the two differ.
import pageList from '../../../shared/configurator/pages.json';

const files = new Set(pageList.map((entry) => entry.file.replace(/^pages\//u, '').replace(/\.chart\.json$/u, '')));
const byName = new Map(
  pageList.map((entry) => [
    entry.page.toLowerCase(),
    entry.file.replace(/^pages\//u, '').replace(/\.chart\.json$/u, ''),
  ]),
);
const aliases: Readonly<Record<string, string>> = {
  'live-chart': 'live-chart-interaktiv',
  'linked-charts': 'gruppe-3-charts',
  'spectrum-waterfall-3d': 'waterfall-live',
  'cut-3d': 'cut-live',
  'cloud-3d': 'cloud-of-20-million-points',
  'cloud-10m-3d': 'cloud-of-20-million-points',
  'cloud-pages-3d': 'cloud-from-a-file',
  'volume-slices-3d': 'volume-slices-512',
  'volume-maximum-3d': 'maximum-projection-512',
  'volume-surface-3d': 'surface-of-equal-value-512',
  'volume-through-3d': 'through-a-volume-512',
  'path-200000': 'path-of-200-000-points',
  'scatter-3000': 'scatter-of-3000-points',
  'mesh-3d': 'surface-with-light',
  heatmap: 'heatmap4k',
  raster: 'raster-interaktiv',
  'error-bars-and-stems': 'error-bars',
  'box-and-violin': 'box-violin',
  themes: 'theme-dark',
  'line-from-a-large-file': 'large-file',
  'raster-from-a-large-file': 'heatmap-from-a-file',
  'scatter-density-from-a-file': 'scatter-from-a-file',
};

/** The template of the configurator for a page of the showroom, or undefined when it has none. */
export function configuratorTemplate(id: string, name: string): string | undefined {
  return aliases[id] ?? (files.has(id) ? id : byName.get(name.toLowerCase()));
}
