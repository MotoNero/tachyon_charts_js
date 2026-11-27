// Tiles of a server of the application's choice over a map in Web Mercator, as TileSource, TileLayerSeries and
// AttributionOverlay of the .NET version. The library names no server: the application gives the address and the
// notice of its source, and keeps to the rules of that server.
import {
  ChartOverlay,
  ChartSeries,
  DoubleRange,
  type Axis,
  type CommandList,
  type GpuTexture,
  type OverlayCanvas,
  type RenderDevice,
  type SeriesFrame,
} from '@tachyon-charts/core';

/** The pixels of a tile, four bytes each (red, green, blue, alpha), row by row from the top. */
export interface TileImage {
  /** The pixels. */
  readonly pixels: Uint8Array | Uint8ClampedArray;
  /** The width in pixels. */
  readonly width: number;
  /** The height in pixels. */
  readonly height: number;
}

/** How a tile source is set up beyond its address. */
export interface TileSourceOptions {
  /** The finest level the server has; 19 by default. */
  readonly maxZoom?: number;
  /** The tiles kept in memory; 512 by default. */
  readonly memoryTiles?: number;
  /** The name of a cache of the browser (Cache Storage) that keeps tiles for the next visit; none by default. */
  readonly cacheName?: string;
  /** Fetches the bytes of a tile, such as with headers the server asks for; `fetch` by default. */
  readonly fetch?: (address: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  /** Decodes the bytes of a tile; PNG and JPEG through the browser by default. */
  readonly decode?: (bytes: ArrayBuffer) => Promise<TileImage | undefined>;
}

type Painter = (z: number, x: number, y: number) => TileImage;

/** Where the tiles of a map come from: the address of a server with `{z}`, `{x}` and `{y}`, and the notice of its source. */
export class TileSource {
  /** The finest level the server has. */
  readonly maxZoom: number;
  /** The tiles kept in memory. */
  readonly memoryTiles: number;
  /** The name of the cache of the browser that keeps tiles, if any. */
  readonly cacheName: string | undefined;
  private readonly fetcher: ((address: string, signal: AbortSignal) => Promise<ArrayBuffer>) | undefined;
  private readonly decoder: (bytes: ArrayBuffer) => Promise<TileImage | undefined>;
  private painter: Painter | undefined;

  /**
   * @param urlTemplate - The address of a tile, with `{z}`, `{x}` and `{y}`.
   * @param attribution - The notice of the source the server asks for, shown in the corner of the map.
   * @param options - Levels, memory, cache, fetching and decoding.
   * @throws RangeError when the address lacks `{z}`, `{x}` or `{y}`, or the notice is empty.
   */
  constructor(
    /** The address of a tile, with `{z}`, `{x}` and `{y}`. */
    readonly urlTemplate: string,
    /** The notice of the source, shown in the corner of the map. */
    readonly attribution: string,
    options: TileSourceOptions = {},
  ) {
    if (!['{z}', '{x}', '{y}'].every((part) => urlTemplate.includes(part))) {
      throw new RangeError('The address needs {z}, {x} and {y}.');
    }
    if (attribution.trim().length === 0) {
      throw new RangeError('Tiles need the notice of their source.');
    }
    this.maxZoom = options.maxZoom ?? 19;
    this.memoryTiles = options.memoryTiles ?? 512;
    this.cacheName = options.cacheName;
    this.fetcher = options.fetch;
    this.decoder = options.decode ?? decodeImage;
  }

  /** A grid of tiles drawn on the spot, without a server: it shows how the levels stack. */
  static grid(): TileSource {
    const source = new TileSource('{z}/{x}/{y}', 'Grid of tiles drawn locally');
    source.painter = paintGrid;
    return source;
  }

  /** The address of a tile. */
  addressOf(z: number, x: number, y: number): string {
    return this.urlTemplate.replaceAll('{z}', String(z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y));
  }

  /** @internal Brings a tile: drawn, from the cache of the browser, or from the server. */
  async load(z: number, x: number, y: number, signal: AbortSignal): Promise<TileImage | undefined> {
    if (this.painter) {
      return this.painter(z, x, y);
    }
    const address = this.addressOf(z, x, y);
    const cache =
      this.cacheName !== undefined && typeof caches !== 'undefined' ? await caches.open(this.cacheName) : undefined;
    const kept = await cache?.match(address);
    if (kept) {
      return this.decoder(await kept.arrayBuffer());
    }
    let bytes: ArrayBuffer;
    if (this.fetcher) {
      bytes = await this.fetcher(address, signal);
    } else {
      const response = await fetch(address, { signal });
      if (!response.ok) {
        throw new Error(`The tile ${address} came with ${String(response.status)}.`);
      }
      bytes = await response.arrayBuffer();
    }
    await cache?.put(address, new Response(bytes.slice(0)));
    return this.decoder(bytes);
  }
}

async function decodeImage(bytes: ArrayBuffer): Promise<TileImage | undefined> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return undefined;
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return { pixels: data.data, width: data.width, height: data.height };
}

// A tile mostly clear, with its border and a soft tint that changes with the level, so the stacking shows.
function paintGrid(z: number, x: number, y: number): TileImage {
  const size = 256;
  const pixels = new Uint8Array(size * size * 4);
  const tint = [60 + ((z * 37) % 120), 90 + ((x * 23) % 100), 140 + ((y * 41) % 100), 40];
  const edge = [40, 60, 90, 200];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      pixels.set(row < 2 || column < 2 ? edge : tint, (row * size + column) * 4);
    }
  }
  return { pixels, width: size, height: size };
}

const workers = 6;
const coarser = 6;
const retryMilliseconds = 30_000;

const keyOf = (z: number, x: number, y: number): number => (z * 2 ** 20 + y) * 2 ** 20 + x;

/**
 * The tiles of a server below the series of a map in Web Mercator: they arrive in the background, the newest view
 * first, and where a tile is missing a coarser one stands in, or the map below shows.
 */
export class TileLayerSeries extends ChartSeries {
  private readonly tiles = new Map<number, TileImage>();
  private readonly failed = new Map<number, number>();
  private readonly pending = new Set<number>();
  private readonly wanted: [number, number, number][] = [];
  private readonly stop = new AbortController();
  private texture: GpuTexture | undefined;
  private device: RenderDevice | undefined;
  private pixels = new Uint8Array(0);
  private arrived = 0;
  private built = -1;
  private builtFrame: SeriesFrame | undefined;
  private running = 0;
  private zoomLevel = 0;

  /**
   * @param source - Where the tiles come from.
   * @param xAxis - The X axis of the map.
   * @param yAxis - The Y axis of the map.
   */
  constructor(
    /** Where the tiles come from. */
    readonly source: TileSource,
    xAxis: Axis,
    yAxis: Axis,
  ) {
    super(xAxis, yAxis);
  }

  /** The level of the tiles of the last frame. */
  get zoom(): number {
    return this.zoomLevel;
  }

  /** The tiles in memory. */
  get tileCount(): number {
    return this.tiles.size;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.version} */
  get version(): number {
    return this.arrived;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.dataRange} */
  override dataRange(): DoubleRange | undefined {
    return new DoubleRange(-Math.PI, Math.PI);
  }

  /** Stops the tiles on their way and frees the texture. */
  dispose(): void {
    this.stop.abort();
    this.releaseResources();
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.releaseResources} */
  override releaseResources(): void {
    this.texture?.dispose();
    this.texture = undefined;
    this.device = undefined;
    this.built = -1;
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.prepare} */
  override prepare(device: RenderDevice, frame: SeriesFrame): void {
    const width = Math.max(Math.trunc(frame.bounds.width), 1);
    const height = Math.max(Math.trunc(frame.bounds.height), 1);
    if (this.device !== device || this.texture?.size.width !== width || this.texture.size.height !== height) {
      this.texture?.dispose();
      this.texture = device.createTexture({ size: { width, height }, format: 'rgba8unorm' });
      this.device = device;
      this.built = -1;
    }
    if (this.arrived === this.built && frame === this.builtFrame) {
      return;
    }
    this.built = this.arrived;
    this.builtFrame = frame;
    if (this.pixels.length !== width * height * 4) {
      this.pixels = new Uint8Array(width * height * 4);
    }
    // The level whose tiles come closest to 256 pixels; a tile spans 2π / 2^z of the plane.
    const bounds = frame.bounds;
    const unitsPerPixel = Math.abs(frame.x.toData(bounds.x + 1) - frame.x.toData(bounds.x));
    const zoom = Math.min(
      Math.max(Math.ceil(Math.log2((2 * Math.PI) / (256 * unitsPerPixel))), 0),
      this.source.maxZoom,
    );
    this.zoomLevel = zoom;
    const x0 = frame.x.toData(bounds.x + 0.5);
    const y0 = frame.y.toData(bounds.y + 0.5);
    const dx = frame.x.toData(bounds.x + 1.5) - x0;
    const dy = frame.y.toData(bounds.y + 1.5) - y0;
    this.want(zoom, x0, y0, x0 + dx * width, y0 + dy * height);
    this.fill(zoom, width, height, x0, y0, dx, dy);
    this.texture.write(this.pixels);
  }

  /** {@inheritDoc @tachyon-charts/core#ChartSeries.draw} */
  draw(commands: CommandList, frame: SeriesFrame): void {
    if (this.texture) {
      commands.drawImage(this.texture, frame.bounds);
    }
  }

  // The tiles of the view at its level, asked for when they are neither here, on their way, nor failed a short while ago.
  private want(zoom: number, left: number, top: number, right: number, bottom: number): void {
    const count = 2 ** zoom;
    const tx0 = column(Math.min(left, right), zoom);
    const tx1 = column(Math.max(left, right), zoom);
    const ty0 = row(Math.max(top, bottom), zoom);
    const ty1 = row(Math.min(top, bottom), zoom);
    const now = performance.now();
    for (let ty = Math.max(0, ty0); ty <= Math.min(count - 1, ty1); ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const x = ((tx % count) + count) % count;
        const key = keyOf(zoom, x, ty);
        const failedAt = this.failed.get(key);
        if (
          this.tiles.has(key) ||
          this.pending.has(key) ||
          (failedAt !== undefined && now - failedAt < retryMilliseconds)
        ) {
          continue;
        }
        this.pending.add(key);
        this.wanted.push([zoom, x, ty]);
      }
    }
    while (this.running < workers && this.wanted.length > 0) {
      this.running++;
      void this.work();
    }
  }

  // A worker takes the newest wish first, so that the tiles of the current view come before older ones.
  private async work(): Promise<void> {
    try {
      for (let next = this.wanted.pop(); next && !this.stop.signal.aborted; next = this.wanted.pop()) {
        const [z, x, y] = next;
        const key = keyOf(z, x, y);
        try {
          const image = await this.source.load(z, x, y, this.stop.signal);
          if (image) {
            this.keep(key, image);
          } else {
            this.failed.set(key, performance.now());
          }
        } catch {
          // Without a network the map below shows; the tile is asked for again after a while.
          this.failed.set(key, performance.now());
        } finally {
          this.pending.delete(key);
        }
      }
    } finally {
      this.running--;
    }
  }

  private keep(key: number, image: TileImage): void {
    this.tiles.set(key, image);
    // A map keeps the order of arrival: the oldest tile leaves first.
    while (this.tiles.size > this.source.memoryTiles) {
      const oldest = this.tiles.keys().next().value as number;
      this.tiles.delete(oldest);
    }
    this.arrived++;
  }

  // Each pixel takes the finest tile there is at its place, from the level of the view up to six coarser ones.
  private fill(zoom: number, width: number, height: number, x0: number, y0: number, dx: number, dy: number): void {
    const pixels = this.pixels;
    for (let line = 0; line < height; line++) {
      const y = y0 + dy * line;
      const start = line * width * 4;
      if (Math.abs(y) > Math.PI) {
        pixels.fill(0, start, start + width * 4);
        continue;
      }
      const ty = (Math.PI - y) / (2 * Math.PI);
      for (let column = 0; column < width; column++) {
        let tx = (x0 + dx * column + Math.PI) / (2 * Math.PI);
        tx -= Math.floor(tx);
        this.sample(zoom, tx, ty, start + column * 4);
      }
    }
  }

  private sample(zoom: number, tx: number, ty: number, at: number): void {
    const pixels = this.pixels;
    for (let z = zoom; z >= Math.max(0, zoom - coarser); z--) {
      const count = 2 ** z;
      const fx = tx * count;
      const fy = ty * count;
      const x = Math.trunc(fx);
      const y = Math.trunc(fy);
      const tile = y >= 0 && y < count ? this.tiles.get(keyOf(z, Math.min(x, count - 1), y)) : undefined;
      if (!tile) {
        continue;
      }
      const px = Math.min(tile.width - 1, Math.trunc((fx - x) * tile.width));
      const py = Math.min(tile.height - 1, Math.trunc((fy - y) * tile.height));
      const from = (py * tile.width + px) * 4;
      pixels[at] = tile.pixels[from] as number;
      pixels[at + 1] = tile.pixels[from + 1] as number;
      pixels[at + 2] = tile.pixels[from + 2] as number;
      pixels[at + 3] = tile.pixels[from + 3] as number;
      return;
    }
    pixels[at] = 0;
    pixels[at + 1] = 0;
    pixels[at + 2] = 0;
    pixels[at + 3] = 0;
  }
}

function column(x: number, zoom: number): number {
  return Math.floor(((x + Math.PI) / (2 * Math.PI)) * 2 ** zoom);
}

function row(y: number, zoom: number): number {
  return Math.floor(((Math.PI - y) / (2 * Math.PI)) * 2 ** zoom);
}

/** The notice of the source of tiles or of a map, in the lower right corner of the plot. */
export class AttributionOverlay extends ChartOverlay {
  /** @param text - The notice. */
  constructor(
    /** The notice. */
    readonly text: string,
  ) {
    super();
  }

  /** {@inheritDoc @tachyon-charts/core#ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const margin = 4;
    const plot = canvas.layout.plotArea;
    const width = canvas.measureWidth(this.text, canvas.labelSize) + 8;
    const height = canvas.lineHeight(canvas.labelSize) + 8;
    canvas.drawLabel(
      this.text,
      plot.right - width - margin,
      plot.bottom - height - margin,
      { ...canvas.colors.background, a: 200 },
      canvas.colors.text,
    );
  }
}
