// Maps in the configurator, as GeoModule of the .NET version: the countries of the world in a projection, with colors
// by distance from the equator, and tiles of a server the application names, or a grid drawn locally.
import type { ChartModule, ChartTypeInfo } from './catalog';
import { num, str, type CodeWriter } from './code';
import { colorCode } from './series-code';
import { numberOf, textOf } from './spec';

const geo = '@tachyon-charts/geo';
const byLatitude = 'Distance from the equator';
const oneColor = 'One color';
const projections: Readonly<Record<string, string>> = {
  EqualEarth: 'equalEarth',
  WebMercator: 'webMercator',
  Equirectangular: 'equirectangular',
};

const capitals: readonly (readonly [string, number, number])[] = [
  ['Berlin', 13.4, 52.52],
  ['Paris', 2.35, 48.86],
  ['Madrid', -3.7, 40.42],
  ['Rome', 12.5, 41.9],
  ['Moscow', 37.62, 55.76],
  ['Cairo', 31.24, 30.04],
  ['Nairobi', 36.82, -1.29],
  ['Pretoria', 28.19, -25.75],
  ['New Delhi', 77.21, 28.61],
  ['Beijing', 116.41, 39.9],
  ['Tokyo', 139.69, 35.69],
  ['Canberra', 149.13, -35.28],
  ['Brasília', -47.88, -15.79],
  ['Buenos Aires', -58.38, -34.6],
  ['Mexico City', -99.13, 19.43],
  ['Washington', -77.04, 38.91],
  ['Ottawa', -75.7, 45.42],
  ['Jakarta', 106.85, -6.21],
  ['Wellington', 174.78, -41.29],
  ['Reykjavík', -21.94, 64.15],
];

function colorsByLatitudeHelper(writer: CodeWriter): string {
  const colormap = writer.useType('Colormap');
  const rgba = writer.useType('Rgba8');
  return writer.helper(
    'colorsByLatitude',
    [
      '// Each country by how far the middle of its box lies from the equator, on the colormap.',
      `async function colorsByLatitude(${writer.parameter('colormap', colormap)}) {`,
      `  const countries = await ${writer.use('WorldMap', geo)}.countries('coarse');`,
      `  const colors = new Map${writer.language === 'typescript' ? `<string, ${rgba}>` : ''}();`,
      '  for (const region of countries.regions) {',
      '    if (region.code.length > 0 && !colors.has(region.code)) {',
      '      colors.set(region.code, colormap.sample(Math.abs((region.bounds.north + region.bounds.south) / 2) / 70));',
      '    }',
      '  }',
      '  return colors;',
      '}',
    ].join('\n'),
  );
}

const geoMap: ChartTypeInfo = {
  id: 'geoMap',
  name: 'World map',
  category: 'twoD',
  shape: 'geoMap',
  defaultSample: 'world',
  parameters: [
    {
      name: 'projection',
      label: 'Projection',
      kind: 'choice',
      default: 'EqualEarth',
      choices: Object.keys(projections),
    },
    {
      name: 'colors',
      label: 'Colors of the countries',
      kind: 'choice',
      default: oneColor,
      choices: [oneColor, byLatitude],
    },
    {
      name: 'colormap',
      label: 'Colormap',
      kind: 'choice',
      default: 'Viridis',
      choices: ['Viridis', 'Inferno', 'Magma', 'Plasma', 'Turbo'],
    },
    { name: 'land', label: 'Land', kind: 'color', default: '', description: 'Empty for the usual pale green.' },
    { name: 'sea', label: 'Sea', kind: 'color', default: '', description: 'Empty for the usual pale blue.' },
    { name: 'border', label: 'Borders', kind: 'color', default: '', description: 'Empty for the usual gray.' },
    { name: 'borderThickness', label: 'Border thickness', kind: 'number', default: 0.6, minimum: 0, maximum: 5 },
  ],
  code(writer, series, data, axes) {
    const values = series.parameters;
    const projection = projections[textOf(values, 'projection', 'EqualEarth')] ?? 'equalEarth';
    const settings: string[] = [];
    if (textOf(values, 'colors', oneColor) === byLatitude) {
      const colormap = `${writer.use('Colormap')}.builtIn(${str(textOf(values, 'colormap', 'Viridis'))})`;
      settings.push(
        '// The countries come with the map file; their colors follow when it has arrived.',
        `${colorsByLatitudeHelper(writer)}(${colormap}).then(`,
        '  (colors) => {',
        '    map.setColors(colors);',
        '  },',
        '  () => undefined,',
        ');',
      );
    }
    for (const property of ['land', 'sea', 'border']) {
      const chosen = colorCode(values, property);
      if (chosen) {
        settings.push(`map.${property} = ${chosen};`);
      }
    }
    settings.push(`map.borderThickness = ${num(numberOf(values, 'borderThickness', 0.6))};`);
    return [
      'c.addSeries(',
      '  (x, y) => {',
      `    const map = new ${writer.use('GeoMapSeries', geo)}(${data}, ${writer.use('GeoProjection', geo)}.${projection}, x, y);`,
      ...settings.map((line) => `    ${line}`),
      '    return map;',
      '  },',
      `  ${str(axes.x)},`,
      `  ${str(axes.y)},`,
      ');',
    ].join('\n');
  },
};

const tileMap: ChartTypeInfo = {
  id: 'tileMap',
  name: 'Tile map',
  category: 'twoD',
  shape: 'geoMap',
  defaultSample: 'world',
  parameters: [
    {
      name: 'url',
      label: 'Tile address',
      kind: 'text',
      default: '',
      description:
        'The address of a tile with {z}, {x} and {y}. Tachyon Charts sets no server: the application names it and answers for its licence and terms. Empty for a grid drawn locally.',
    },
    {
      name: 'attribution',
      label: 'Source notice',
      kind: 'text',
      default: '',
      description: 'The notice the server asks for; the map shows it in the corner.',
    },
  ],
  code(writer, series, data, axes) {
    const values = series.parameters;
    const url = textOf(values, 'url');
    const attribution = textOf(values, 'attribution');
    const source = writer.use('TileSource', geo);
    const fromServer =
      url.includes('{z}') && url.includes('{x}') && url.includes('{y}') && attribution.trim().length > 0;
    return [
      '// The countries below the tiles: where no tile is, without a network for instance, they show.',
      `c.addSeries((x, y) => new ${writer.use('GeoMapSeries', geo)}(${data}, ${writer.use('GeoProjection', geo)}.webMercator, x, y), ${str(axes.x)}, ${str(axes.y)});`,
      `${writer.use('tiles', geo)}(c, ${fromServer ? `new ${source}(${str(url)}, ${str(attribution)})` : `${source}.grid()`});`,
    ].join('\n');
  },
};

/** The maps: the countries of the world and tiles of a server. */
export const geoModule: ChartModule = {
  types: [geoMap, tileMap],
  samples: [
    {
      id: 'world',
      name: 'The countries of the world (Natural Earth)',
      shape: 'geoMap',
      defaultCount: 1,
      hasCount: false,
      body: '// Three levels of detail, coarse to fine; each loads when the zoom first needs it.\nreturn WorldMap.countryLevels;',
      returns: 'readonly GeoMapLevel[]',
      uses: [`${geo}#WorldMap`, `${geo}#GeoMapLevel`],
    },
    {
      id: 'capitals',
      name: 'Twenty capitals on the Equal Earth map',
      shape: 'points',
      defaultCount: 20,
      hasCount: false,
      body: [
        `const longitudes = [${capitals.map((capital) => num(capital[1])).join(', ')}];`,
        `const latitudes = [${capitals.map((capital) => num(capital[2])).join(', ')}];`,
        'const places = GeoProjection.equalEarth.projectAll(longitudes, latitudes);',
        'const data = new DataSource(longitudes.length);',
        'data.append(places.x, places.y);',
        'return data;',
      ].join('\n'),
      returns: 'DataSource',
      uses: [`${geo}#GeoProjection`, 'DataSource'],
    },
  ],
  load: async () => ({ [geo]: { ...(await import('@tachyon-charts/geo')) } }),
};
