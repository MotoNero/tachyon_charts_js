// Maps of regions in degrees, as GeoMap, GeoRegion and WorldMap of the .NET version, in the same packed form ("TGEO",
// version 1, gzip): the countries of the world come with the package, so a map works without the internet.
import { Polygon, PolygonRing } from '@tachyon-charts/core';
import type { GeoBounds } from './projection';
import type { Shapefile } from './shapefile';
import { triangulateArea, type GeoTriangles } from './triangulator';

const magic = 0x4f454754; // "TGEO"
const formatVersion = 1;

/** A region of a map, such as a country: its name, its code and its areas in degrees of longitude and latitude. */
export class GeoRegion {
  private readonly cut: (GeoTriangles | undefined)[];
  /** The box of the region in degrees. */
  readonly bounds: GeoBounds;

  /**
   * @param name - The name.
   * @param code - The code, such as ISO 3166 alpha-3 for countries.
   * @param polygons - The areas, X the longitude and Y the latitude in degrees.
   */
  constructor(
    /** The name. */
    readonly name: string,
    /** The code. */
    readonly code: string,
    /** The areas, X the longitude and Y the latitude in degrees. */
    readonly polygons: readonly Polygon[],
  ) {
    this.cut = new Array<GeoTriangles | undefined>(polygons.length);
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const polygon of polygons) {
      const outer = polygon.outer;
      for (let i = 0; i < outer.count; i++) {
        west = Math.min(west, outer.x[i] as number);
        south = Math.min(south, outer.y[i] as number);
        east = Math.max(east, outer.x[i] as number);
        north = Math.max(north, outer.y[i] as number);
      }
    }
    this.bounds = { west, south, east, north };
  }

  /** The triangles of an area, cut once when first asked for. */
  triangles(polygon: number): GeoTriangles {
    let cut = this.cut[polygon];
    if (!cut) {
      const area = this.polygons[polygon] as Polygon;
      cut = triangulateArea(area.outer, area.holes);
      this.cut[polygon] = cut;
    }
    return cut;
  }

  /** @internal Takes triangles cut before, as a packed map holds them. */
  setTriangles(polygon: number, triangles: GeoTriangles): void {
    this.cut[polygon] = triangles;
  }

  /** Whether a place in degrees lies in one of the areas. */
  contains(longitude: number, latitude: number): boolean {
    const box = this.bounds;
    if (longitude < box.west || longitude > box.east || latitude < box.south || latitude > box.north) {
      return false;
    }
    return this.polygons.some((polygon) => polygon.contains(longitude, latitude));
  }
}

/** A map file in its packed form that cannot be read. */
export class GeoMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoMapError';
  }
}

/**
 * A map: regions with names and codes, such as the countries of the world, in degrees of longitude and latitude. It
 * comes from a shapefile or from {@link WorldMap}, and keeps in a compact packed form of its own.
 */
export class GeoMap {
  private readonly byCode = new Map<string, GeoRegion>();

  /** @param regions - The regions. */
  constructor(
    /** The regions. */
    readonly regions: readonly GeoRegion[],
  ) {
    for (const region of regions) {
      const code = region.code.toUpperCase();
      if (code.length > 0 && !this.byCode.has(code)) {
        this.byCode.set(code, region);
      }
    }
  }

  /** Finds a region by its code, in any case. */
  find(code: string): GeoRegion | undefined {
    return this.byCode.get(code.toUpperCase());
  }

  /**
   * Makes a map of the areas of a shapefile in degrees of longitude and latitude: each shape a region, its outer rings
   * the areas, the rings inside them their holes.
   * @param file - The shapefile, of areas.
   * @param nameField - The field of the names, in any case.
   * @param codeField - The field of the codes, in any case.
   * @throws RangeError when the shapefile holds no areas.
   */
  static fromShapefile(file: Shapefile, nameField = 'NAME', codeField = 'ISO_A3'): GeoMap {
    if (file.kind !== 'polygon') {
      throw new RangeError(`A map needs areas; the shapefile holds ${file.kind} shapes.`);
    }
    const field = (attributes: ReadonlyMap<string, string>, wanted: string): string => {
      const direct = attributes.get(wanted);
      if (direct !== undefined) {
        return direct;
      }
      for (const [key, value] of attributes) {
        if (key.toUpperCase() === wanted.toUpperCase()) {
          return value;
        }
      }
      return '';
    };
    return new GeoMap(
      file.shapes.map(
        (shape) =>
          new GeoRegion(
            field(shape.attributes, nameField),
            field(shape.attributes, codeField),
            toPolygons(shape.parts),
          ),
      ),
    );
  }

  /**
   * Reads a map in its packed form, its areas already cut into triangles.
   * @param packed - The bytes, gzip-packed or already unpacked, or a response that brings them.
   * @throws GeoMapError when the bytes hold no packed map.
   */
  static async load(packed: Uint8Array | ArrayBuffer | Response): Promise<GeoMap> {
    const raw =
      packed instanceof Response
        ? new Uint8Array(await packed.arrayBuffer())
        : packed instanceof Uint8Array
          ? packed
          : new Uint8Array(packed);
    // A server that sends the file with its packing named has the browser unpack it already.
    if (raw[0] !== 0x1f || raw[1] !== 0x8b) {
      return readMap(raw);
    }
    let bytes: Uint8Array;
    try {
      const stream = new Blob([raw.slice()]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      throw new GeoMapError('The bytes hold no gzip-packed map.');
    }
    return readMap(bytes);
  }

  /**
   * Writes the map in its packed form: corners as floats, areas already cut into triangles, gzip-packed; the form
   * {@link WorldMap} keeps the countries in.
   */
  async save(): Promise<Uint8Array> {
    const writer = new PackedWriter();
    writer.uint32(magic);
    writer.int32(formatVersion);
    writer.int32(this.regions.length);
    for (const region of this.regions) {
      writer.string(region.name);
      writer.string(region.code);
      // Areas too small to cut are left out.
      const cut = region.polygons.map((_, p) => region.triangles(p)).filter((polygon) => polygon.rings.length > 0);
      writer.int32(cut.length);
      for (const polygon of cut) {
        // The corners as the triangles count them: the outer ring, then the holes, each turned as the cutting turned it.
        writer.int32(polygon.rings.length);
        for (const ring of polygon.rings) {
          writer.int32(ring);
        }
        for (let i = 0; i < polygon.x.length; i++) {
          writer.float32(polygon.x[i] as number);
          writer.float32(polygon.y[i] as number);
        }
        writer.int32(polygon.triangles.length);
        for (const corner of polygon.triangles) {
          writer.int32(corner);
        }
      }
    }
    const packed = new Blob([writer.bytes()]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(packed).arrayBuffer());
  }
}

function readMap(bytes: Uint8Array): GeoMap {
  const reader = new PackedReader(bytes);
  if (bytes.length < 12 || reader.uint32() !== magic || reader.int32() !== formatVersion) {
    throw new GeoMapError('The bytes hold no packed map of version 1.');
  }
  const regions: GeoRegion[] = [];
  const total = reader.int32();
  for (let r = 0; r < total; r++) {
    const name = reader.string();
    const code = reader.string();
    const areas = reader.int32();
    const polygons: Polygon[] = [];
    const cuts: GeoTriangles[] = [];
    for (let p = 0; p < areas; p++) {
      const rings = reader.ints();
      const corners = rings.reduce((sum, ring) => sum + ring, 0);
      const x = new Float64Array(corners);
      const y = new Float64Array(corners);
      for (let i = 0; i < corners; i++) {
        x[i] = reader.float32();
        y[i] = reader.float32();
      }
      const triangles = reader.ints();
      let start = 0;
      const parts = Array.from(rings, (ring) => {
        const part = new PolygonRing(x.subarray(start, start + ring), y.subarray(start, start + ring));
        start += ring;
        return part;
      });
      polygons.push(new Polygon(parts[0] as PolygonRing, parts.slice(1)));
      cuts.push({ x, y, triangles, rings });
    }
    const region = new GeoRegion(name, code, polygons);
    cuts.forEach((cut, p) => {
      region.setTriangles(p, cut);
    });
    regions.push(region);
  }
  return new GeoMap(regions);
}

// The rings of a shape: those turning clockwise are outer rings, the others holes of the outer ring around them.
function toPolygons(parts: readonly { readonly x: Float64Array; readonly y: Float64Array }[]): Polygon[] {
  const outers: { ring: PolygonRing; holes: PolygonRing[] }[] = [];
  const holes: PolygonRing[] = [];
  for (const { x, y } of parts) {
    if (x.length < 3) {
      continue;
    }
    let area = 0;
    for (let i = 0, j = x.length - 1; i < x.length; j = i++) {
      area += ((x[j] as number) - (x[i] as number)) * ((y[j] as number) + (y[i] as number));
    }
    // The sum is negative for a ring turning clockwise, the outer rings of a shapefile.
    const ring = new PolygonRing(x, y);
    if (area < 0) {
      outers.push({ ring, holes: [] });
    } else {
      holes.push(ring);
    }
  }
  for (const hole of holes) {
    const home = outers.find((outer) => new Polygon(outer.ring).contains(hole.x[0] as number, hole.y[0] as number));
    if (home) {
      home.holes.push(hole);
    } else {
      // A ring turned the wrong way outside every area is an area of its own.
      outers.push({ ring: hole, holes: [] });
    }
  }
  return outers.map((outer) => new Polygon(outer.ring, outer.holes));
}

// Little-endian values and strings with a 7-bit length, as the .NET version writes them.
class PackedReader {
  private readonly view: DataView;
  private readonly text = new TextDecoder();
  private at = 0;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  uint32(): number {
    const value = this.view.getUint32(this.at, true);
    this.at += 4;
    return value;
  }

  int32(): number {
    const value = this.view.getInt32(this.at, true);
    this.at += 4;
    return value;
  }

  float32(): number {
    const value = this.view.getFloat32(this.at, true);
    this.at += 4;
    return value;
  }

  ints(): Int32Array {
    const length = this.int32();
    const values = new Int32Array(length);
    for (let i = 0; i < length; i++) {
      values[i] = this.int32();
    }
    return values;
  }

  string(): string {
    let length = 0;
    let shift = 0;
    for (;;) {
      const byte = this.data[this.at++];
      if (byte === undefined) {
        throw new GeoMapError('The packed map is cut off.');
      }
      length |= (byte & 0x7f) << shift;
      if (byte < 0x80) {
        break;
      }
      shift += 7;
    }
    const value = this.text.decode(this.data.subarray(this.at, this.at + length));
    this.at += length;
    return value;
  }
}

class PackedWriter {
  private data = new Uint8Array(1 << 16);
  private view = new DataView(this.data.buffer);
  private at = 0;
  private readonly text = new TextEncoder();

  bytes(): Uint8Array<ArrayBuffer> {
    return this.data.slice(0, this.at);
  }

  uint32(value: number): void {
    this.room(4);
    this.view.setUint32(this.at, value, true);
    this.at += 4;
  }

  int32(value: number): void {
    this.room(4);
    this.view.setInt32(this.at, value, true);
    this.at += 4;
  }

  float32(value: number): void {
    this.room(4);
    this.view.setFloat32(this.at, value, true);
    this.at += 4;
  }

  string(value: string): void {
    const bytes = this.text.encode(value);
    this.room(bytes.length + 5);
    let length = bytes.length;
    while (length >= 0x80) {
      this.data[this.at++] = (length & 0x7f) | 0x80;
      length >>>= 7;
    }
    this.data[this.at++] = length;
    this.data.set(bytes, this.at);
    this.at += bytes.length;
  }

  private room(bytes: number): void {
    if (this.at + bytes <= this.data.length) {
      return;
    }
    let size = this.data.length * 2;
    while (size < this.at + bytes) {
      size *= 2;
    }
    const grown = new Uint8Array(size);
    grown.set(this.data.subarray(0, this.at));
    this.data = grown;
    this.view = new DataView(grown.buffer);
  }
}

/** How fine the countries of {@link WorldMap} are. */
export type MapDetail = 'coarse' | 'medium' | 'fine';

const mapFiles: Record<MapDetail, string> = {
  coarse: 'countries-110m.tgeo.gz',
  medium: 'countries-50m.tgeo.gz',
  fine: 'countries-10m.tgeo.gz',
};

// Each file named in full, so that a bundler finds and copies it.
function packagedFile(detail: MapDetail): URL {
  switch (detail) {
    case 'coarse':
      return new URL('../maps/countries-110m.tgeo.gz', import.meta.url);
    case 'medium':
      return new URL('../maps/countries-50m.tgeo.gz', import.meta.url);
    default:
      return new URL('../maps/countries-10m.tgeo.gz', import.meta.url);
  }
}

/** A level of detail of a map: the map, or a function that brings it when it is first needed. */
export type GeoMapLevel = GeoMap | (() => Promise<GeoMap>);

const loaded = new Map<MapDetail, Promise<GeoMap>>();

/**
 * The countries of the world from Natural Earth 5.1.1 (public domain), in three levels of detail, inside the package:
 * usable without the internet. Each region has the name and the code (ADM0_A3) of its country.
 */
export const WorldMap = {
  /** Where the files of the countries lie, if not beside the package, such as on a server of the application. */
  folder: undefined as URL | string | undefined,

  /** The countries at a level of detail (1:110, 1:50 or 1:10 million), read once. */
  countries(detail: MapDetail = 'medium'): Promise<GeoMap> {
    let map = loaded.get(detail);
    if (!map) {
      const address = WorldMap.folder === undefined ? packagedFile(detail) : new URL(mapFiles[detail], WorldMap.folder);
      map = fetch(address).then((response) => {
        if (!response.ok) {
          throw new GeoMapError(`The map ${mapFiles[detail]} could not be read (${String(response.status)}).`);
        }
        return GeoMap.load(response);
      });
      // A failed read is tried again next time.
      map.catch(() => {
        loaded.delete(detail);
      });
      loaded.set(detail, map);
    }
    return map;
  },

  /** The countries at every level, coarse to fine, each read when a map first needs it. */
  get countryLevels(): readonly GeoMapLevel[] {
    return [() => WorldMap.countries('coarse'), () => WorldMap.countries('medium'), () => WorldMap.countries('fine')];
  },

  /** The notice of the source of the countries, to show with a map. */
  attribution: 'Made with Natural Earth',
};
