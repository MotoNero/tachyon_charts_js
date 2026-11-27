// Maps for the fluent description of a chart, as GeoCharts of the .NET version.
import type { ChartBuilder } from '@tachyon-charts/core';
import { WorldMap, type GeoMapLevel } from './geo-map';
import { GeoMapSeries } from './map-series';
import type { GeoProjection } from './projection';
import { AttributionOverlay, TileLayerSeries, type TileSource } from './tiles';

/**
 * Describes a map: X and Y axes over the world on the plane of the projection, without ticks, and the regions, by
 * default the countries of {@link WorldMap} in three levels of detail. Data layers go on the same axes, their places
 * projected with {@link GeoProjection.projectAll}.
 * @param builder - The chart.
 * @param projection - The projection.
 * @param configure - Sets colors and borders.
 * @param levels - The levels of detail, coarse to fine; the countries of the world when left out.
 */
export function map(
  builder: ChartBuilder,
  projection: GeoProjection,
  configure?: (series: GeoMapSeries) => void,
  levels?: readonly GeoMapLevel[],
): ChartBuilder {
  const bounds = projection.worldBounds;
  return builder
    .xAxis((axis) => axis.numeric('x').range(bounds.west, bounds.east).hidden())
    .yAxis((axis) => axis.numeric('y').range(bounds.south, bounds.north).hidden())
    .addSeries(
      (x, y) => {
        const series = new GeoMapSeries(levels ?? WorldMap.countryLevels, projection, x, y);
        configure?.(series);
        return series;
      },
      'x',
      'y',
    );
}

/**
 * Adds tiles of a server over a map of {@link GeoProjection.webMercator}, with the notice of their source in the corner.
 * Put a {@link map} of the same projection below it: where no tile is, without a network for instance, its countries
 * show.
 * @param builder - The chart.
 * @param source - Where the tiles come from.
 */
export function tiles(builder: ChartBuilder, source: TileSource): ChartBuilder {
  return builder
    .addSeries((x, y) => new TileLayerSeries(source, x, y), 'x', 'y')
    .addOverlay(() => new AttributionOverlay(source.attribution));
}
