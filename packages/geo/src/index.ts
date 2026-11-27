/** Version of the package `@tachyon-charts/geo`. */
export const version = '0.1.0-dev';

export { GeoProjection, type GeoBounds, type GeoPlace, type GeoPoint } from './projection';
export {
  ShapefileError,
  ShapefileReader,
  type GeoShape,
  type ShapeKind,
  type ShapePart,
  type Shapefile,
} from './shapefile';
export { GeoMap, GeoMapError, GeoRegion, WorldMap, type GeoMapLevel, type MapDetail } from './geo-map';
export type { GeoTriangles } from './triangulator';
export { GeoMapSeries } from './map-series';
export { AttributionOverlay, TileLayerSeries, TileSource, type TileImage, type TileSourceOptions } from './tiles';
export { map, tiles } from './charts';
