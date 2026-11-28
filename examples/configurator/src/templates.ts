// The descriptions of the showroom pages of the .NET version, as templates; loaded apart from the app.
import pageList from '../../../shared/configurator/pages.json';

const files = import.meta.glob<string>('../../../shared/configurator/pages/*.chart.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The pages with their name, id and description text. */
export const pages = pageList.flatMap((entry) => {
  const text = files[`../../../shared/configurator/${entry.file}`];
  const id = entry.file.replace(/^pages\//u, '').replace(/\.chart\.json$/u, '');
  return text === undefined ? [] : [{ name: entry.page, id, text }];
});
