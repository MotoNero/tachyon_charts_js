// Map projections as GeoProjection of the .NET version: from longitude and latitude in degrees to X and Y on the plane
// of the chart, and back. The X axis of the chart runs east, the Y axis north.

const radians = (degrees: number): number => (degrees * Math.PI) / 180;
const degrees = (value: number): number => (value * 180) / Math.PI;
const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);
const a1 = 1.340264;
const a2 = -0.081106;
const a3 = 0.000893;
const a4 = 0.003796;
const equalEarthM = Math.sqrt(3) / 2;

/** A place on the plane of a projection. */
export interface GeoPoint {
  /** The X on the plane, east. */
  readonly x: number;
  /** The Y on the plane, north. */
  readonly y: number;
}

/** A place on the earth in degrees. */
export interface GeoPlace {
  /** The longitude in degrees, east positive. */
  readonly longitude: number;
  /** The latitude in degrees, north positive. */
  readonly latitude: number;
}

/** A box on the plane or on the earth: west, south, east, north. */
export interface GeoBounds {
  /** The west edge. */
  readonly west: number;
  /** The south edge. */
  readonly south: number;
  /** The east edge. */
  readonly east: number;
  /** The north edge. */
  readonly north: number;
}

/** A map projection: from longitude and latitude in degrees to X and Y on the plane of the chart, and back. */
export abstract class GeoProjection {
  /** Longitude and latitude as they are, in degrees: simple and good for small areas and data grids. */
  static readonly equirectangular: GeoProjection = new (class extends GeoProjection {
    readonly name = 'Equirectangular';
    project(longitude: number, latitude: number): GeoPoint {
      return { x: longitude, y: latitude };
    }
    unproject(x: number, y: number): GeoPlace | undefined {
      return Math.abs(x) <= 180 && Math.abs(y) <= 90 ? { longitude: x, latitude: y } : undefined;
    }
  })();

  /** The projection of web maps and their tiles, in units of the earth radius, up to 85.05° north and south. */
  static readonly webMercator: GeoProjection = new (class extends GeoProjection {
    readonly name = 'WebMercator';
    private readonly limit = 85.0511287798066;
    project(longitude: number, latitude: number): GeoPoint {
      const phi = radians(clamp(latitude, -this.limit, this.limit));
      return { x: radians(longitude), y: Math.log(Math.tan(Math.PI / 4 + phi / 2)) };
    }
    unproject(x: number, y: number): GeoPlace | undefined {
      const longitude = degrees(x);
      const latitude = degrees(2 * Math.atan(Math.exp(y)) - Math.PI / 2);
      return Math.abs(longitude) <= 180 && Math.abs(latitude) <= this.limit ? { longitude, latitude } : undefined;
    }
  })();

  /** An equal-area projection of the whole world: areas keep their sizes against each other. */
  static readonly equalEarth: GeoProjection = new (class extends GeoProjection {
    // Šavrič, Patterson and Jenny, "The Equal Earth map projection", 2018; X and Y in units of the earth radius.
    readonly name = 'EqualEarth';
    project(longitude: number, latitude: number): GeoPoint {
      const theta = Math.asin(equalEarthM * Math.sin(radians(clamp(latitude, -90, 90))));
      const t2 = theta * theta;
      const t6 = t2 * t2 * t2;
      const x =
        (2 * Math.sqrt(3) * radians(longitude) * Math.cos(theta)) /
        (3 * (9 * a4 * t6 * t2 + 7 * a3 * t6 + 3 * a2 * t2 + a1));
      const y = theta * (a1 + a2 * t2 + a3 * t6 + a4 * t6 * t2);
      return { x, y };
    }
    unproject(x: number, y: number): GeoPlace | undefined {
      // Newton steps on theta for y, then the longitude from x.
      let theta = y;
      for (let step = 0; step < 12; step++) {
        const t2 = theta * theta;
        const t6 = t2 * t2 * t2;
        const value = theta * (a1 + a2 * t2 + a3 * t6 + a4 * t6 * t2) - y;
        const derivative = a1 + 3 * a2 * t2 + 7 * a3 * t6 + 9 * a4 * t6 * t2;
        theta -= value / derivative;
      }
      const u2 = theta * theta;
      const u6 = u2 * u2 * u2;
      const lambda =
        (3 * x * (9 * a4 * u6 * u2 + 7 * a3 * u6 + 3 * a2 * u2 + a1)) / (2 * Math.sqrt(3) * Math.cos(theta));
      const sine = Math.sin(theta) / equalEarthM;
      const longitude = degrees(lambda);
      const latitude = Math.abs(sine) <= 1 ? degrees(Math.asin(sine)) : Number.NaN;
      return Math.abs(longitude) <= 180 + 1e-9 && Number.isFinite(latitude) ? { longitude, latitude } : undefined;
    }
  })();

  /** The name. */
  abstract readonly name: string;

  /** Projects a place in degrees, longitude east and latitude north positive. */
  abstract project(longitude: number, latitude: number): GeoPoint;

  /** The place of a point on the plane, or undefined when it lies off the map. */
  abstract unproject(x: number, y: number): GeoPlace | undefined;

  /**
   * The box of the world on the plane: the widest place lies at the equator, the highest near the poles (Web Mercator
   * stops at 85°).
   */
  get worldBounds(): GeoBounds {
    return {
      west: this.project(-180, 0).x,
      south: this.project(0, -85).y,
      east: this.project(180, 0).x,
      north: this.project(0, 85).y,
    };
  }

  /** Projects many places, such as the points of a data layer. */
  projectAll(
    longitudes: ArrayLike<number>,
    latitudes: ArrayLike<number>,
  ): { readonly x: Float64Array; readonly y: Float64Array } {
    if (longitudes.length !== latitudes.length) {
      throw new RangeError(`${String(longitudes.length)} longitudes, ${String(latitudes.length)} latitudes.`);
    }
    const x = new Float64Array(longitudes.length);
    const y = new Float64Array(longitudes.length);
    for (let i = 0; i < x.length; i++) {
      const point = this.project(longitudes[i] as number, latitudes[i] as number);
      x[i] = point.x;
      y[i] = point.y;
    }
    return { x, y };
  }
}
