<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="shared/logo/tachyon-charts-lockup-dark-transparent.svg">
    <img alt="Tachyon Charts" src="shared/logo/tachyon-charts-lockup-light-transparent.svg" width="440">
  </picture>
</h1>

**Tachyon Charts for JavaScript**

Fast charts for the browser, drawn on the GPU with WebGPU, with fallbacks to WebGL 2 and Canvas 2D. Made for large
data: millions of points in real time and files larger than memory.

**Status:** early development. Charts with lines, scatter markers, areas, bands, bars, digital channels and rasters
draw on WebGPU, with axes, time axes, layout, text, interaction and themes as in the .NET version, in a render worker
and with data from workers. Column files, rasters and point tiles larger than memory come from the origin private
file system, files or servers.
There is no release yet and the API will change. The packages will appear on npm under
`@tachyon-charts/…`.

## A first chart

![A line of a million points with a single spike, and a smooth line above it](docs/images/line-million-points.png)

```ts
import { ChartSurface, DataSource, LineSeries, NumericAxis, TextEngine } from '@tachyon-charts/core';
import { createWebGpuDevice } from '@tachyon-charts/render-webgpu';

const device = await createWebGpuDevice();
const x = new NumericAxis('x', 'bottom');
const y = new NumericAxis('y', 'left');
const chart = new ChartSurface([x], [{ axes: [y] }], new TextEngine(robotoFontData));
chart.addSeries(new LineSeries(source, x, y)); // source: a DataSource with append(x, y)

const target = device.createSurfaceTarget({ kind: 'canvas', canvas }, { width, height }, devicePixelRatio);
chart.render(device, target);
```

A line of a million points draws the extremes of each pixel column, so every peak stays visible; the pyramid behind it
builds in a worker when the data lies in a `SharedArrayBuffer`. Besides `LineSeries` there are `ScatterSeries`,
`AreaSeries`, `StackedAreaSeries`, `BandSeries` and `BarSeries`. The complete example is in `examples/basic`.

The same chart in the words of the .NET version:

```ts
const { surface } = new ChartBuilder()
  .title('Sensors')
  .xAxis((a) => a.title('Time'))
  .yAxis((a) => a.autoRange())
  .addLine(source, (l) => l.stroke(rgba(240, 130, 90)).thickness(2))
  .build(engine);
```

Axes are numeric, logarithmic, categories or time in any time zone, with daylight saving and labels in English or
German. The public API of every package is listed in `docs/api`.

## Web component

![Two charts as web components, a line chart in the dark theme and stacked bars in the light theme](docs/images/web-component.png)

`<tachyon-chart>` works in every web application, with any framework or none. It follows its size and the pixel ratio
of the screen, takes zoom, pan, crosshair and keys, follows light and dark of the system, and frees its GPU resources
when it leaves the page:

```html
<tachyon-chart id="chart" style="height: 400px"></tachyon-chart>
<script type="module">
  import { ChartBuilder, DataSource } from '@tachyon-charts/core';
  import { defineTachyonChart } from '@tachyon-charts/element';

  defineTachyonChart();
  const data = new DataSource();
  data.append([0, 1, 2, 3], [1, 3, 2, 4]);
  document.querySelector('#chart').chart = new ChartBuilder().xAxis().yAxis((a) => a.autoRange()).addLine(data);
</script>
```

Attributes: `theme` (`auto`, a built-in name such as `light` or `neon`, or `none`) and `interactive="false"`. Events:
`tachyon-ready`, `tachyon-tooltip` with the point under the pointer, `tachyon-error`. Examples: `examples/web-component`
(a Vite application) and `examples/no-bundler` (an import map, no build step).

Charts draw in a render worker: the element hands its canvas to the worker as `OffscreenCanvas`, and the WebGPU
device there uploads the data, encodes and presents the frames, while the page keeps the chart, its layout and the
input. Where a browser cannot hand a canvas to a worker, charts draw on the main thread; both look the same to the
pixel. `TachyonChartElement.renderInWorker = false` before the first chart chooses the main thread, and
`chart.renderThread` tells where a chart draws. Without the element, `createWebGpuWorkerDevice()` of
`@tachyon-charts/render-webgpu` gives the same device to a chart of your own.

## Fallbacks: WebGL 2 and Canvas 2D

Charts run everywhere. The element takes the first renderer that works: WebGPU, then WebGL 2, then Canvas 2D. A
renderer must draw a first frame, and a GPU renderer must take textures of 4096 pixels. When a device is lost, after
a driver reset for example, every chart of the page lets go of it and starts again with a new one; a renderer that
lost its device twice is left out. `TachyonChartElement.renderer` chooses before the first chart: `auto`, `webgpu`,
`webgl2` or `canvas2d`; `chart.renderer` and `chart.rendererName` tell which one draws. The showroom draws with a
fallback on `index.html?renderer=webgl2` or `?renderer=canvas2d`.

### WebGL 2

![The showroom drawn with WebGL 2 in the render worker](docs/images/webgl2-fallback.png)

The same commands and shaders derived line by line from the WGSL shaders. Every scene of the image tests matches the
.NET reference with WebGL 2 within the tolerance of WebGPU, most of them to the pixel. All charts of a page share one
WebGL context, its buffers and the glyph atlas; a frame for a chart goes to its canvas as an image bitmap, without a
copy, in the render worker or on the main thread. Without the element, `createWebGl2Device()` and
`createWebGl2WorkerDevice()` of `@tachyon-charts/render-webgl` give a device of your own.

### Canvas 2D

![The showroom drawn with Canvas 2D in the render worker](docs/images/canvas2d-fallback.png)

The last fallback, as the Skia backend of the .NET version: buffers and textures in the memory of the CPU, lines as
strokes with round caps and joins, markers as shapes, and on the CPU what the shaders do: distance field text,
rasters through their colormap, triangles with a color per corner and, from 200 000 on, markers written straight into
pixels (a million in about 135 ms). It draws on a canvas of the CPU, where the browser rasterizes with Skia too, so
the scenes match the images of the Skia backend of the .NET version, most of them to the pixel. It draws in the render
worker as well, which keeps the work off the page. `createCanvas2dDevice()` and `createCanvas2dWorkerDevice()` of
`@tachyon-charts/render-canvas` give a device of your own.

## Performance

Measured with WebGPU in Edge on a laptop GPU, 1920 × 1080, charts drawing in the render worker:

| Scenario | Target | Measured |
|---|---|---|
| Line, 10 million points, zoom and pan | ≥ 60 FPS | 60 FPS |
| Scatter, 10 million points, a color per point | ≥ 60 FPS | 60 FPS |
| Streaming, 10 series × 100 000 points per second | ≥ 60 FPS, no frame > 33 ms | 60 FPS, longest frame 18 ms |
| 50 charts on a page, all streaming | ≥ 45 FPS each | 53 FPS each |
| An idle chart | no frames, < 1 % CPU | no frames, 0.13 % CPU |
| JavaScript of core, the renderers and element, fallbacks and export loaded when needed | < 250 KB compressed | 126 KB gzip in all |
| First frame after loading the page | < 300 ms | 292 ms |

With WebGL 2 on the same machine, against the targets of the fallback:

| Scenario | Target | Measured |
|---|---|---|
| Line, 10 million points, zoom and pan | ≥ 30 FPS | 60 FPS |
| Line, a billion values from a column file | first frame < 0.5 s, ≥ 30 FPS | 308 ms, 60 FPS |
| Scatter, 10 million points, a color per point | ≥ 20 FPS | 52 FPS |
| Streaming, 10 series × 100 000 points per second | ≥ 30 FPS | 60 FPS |
| 50 charts on a page, all streaming | ≥ 20 FPS each | 54 FPS each |
| An idle chart | no frames, < 1 % CPU | no frames, 0.12 % CPU |

None of these scenarios has a main-thread task of 50 ms or more. `pnpm bench` measures them again, with WebGPU and
with WebGL 2.

## Many charts

![A grid of charts in the showroom, each streaming its own signal](docs/images/many-charts.png)

All charts of a page share one GPU device, one text engine and one animation frame loop. Each frame, every chart that
changed draws, and in the render worker all their frames go as one message. Charts scrolled out of view pause and draw
what they missed when they return. 50 charts on 1920 × 1080, each streaming 100 000 points per second into a ring of
100 000 points, draw at 60 FPS each. Rings keep the newest points in one piece and summarize their metadata in blocks,
so a frame reads them without a copy.

## Data from workers

![A noisy signal of millions of points that a worker streams into the chart through shared memory](docs/images/data-from-a-worker.png)

A worker can write straight into a chart. On cross-origin isolated pages (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`) a `DataSource` keeps its values in shared memory: the worker writes them
in place and publishes count and metadata with `Atomics`, and a data worker of the page builds the pyramid for
resampling, so the main thread does neither. Elsewhere the worker sends blocks of transferred buffers. Both ways look
the same to the worker:

```ts
// Main thread
const data = new DataSource();
chart.chart = new ChartBuilder().xAxis((a) => a.autoRange()).yAxis((a) => a.autoRange()).addLine(data);
linkDataSource(data, worker, { capacity: 4_000_000 }); // 'shared' or 'transferred'

// Worker
const writer = await acceptDataLink(self);
writer.append(xs, ys);
```

20 million points from a worker through shared memory keep the main thread busy for about 150 ms in all, against about
450 ms when the same points are appended on the main thread. The showroom streams four million points on the page
"Data from a worker".

## Statistics

![Three samples as box plots with outliers and as violins](docs/images/box-and-violin.png)

Histograms, box plots and violins as in the .NET version. `computeHistogram` bins values with the rules of NumPy
(a fixed count or width, Sturges, Freedman-Diaconis), and `BarSeries.fromHistogram` draws the bins. `BoxPlotSeries`
shows quartiles, whiskers within 1.5 interquartile ranges and the outliers; `ViolinSeries` the mirrored density of
each sample, a kernel density estimate with the bandwidth of Scott, with a line at the median. Samples stand at the
places of a category axis.

```ts
import { BarSeries, BoxPlotSeries, computeHistogram, ViolinSeries } from '@tachyon-charts/core';

builder.addSeries((x, y) => BarSeries.fromHistogram(computeHistogram(values, 'freedmanDiaconis'), x, y));
builder.addSeries((x, y) => new BoxPlotSeries([first, second, third], x, y));
builder.addSeries((x, y) => new ViolinSeries([first, second, third], x, y));
```

## Polar and radar charts

![A radar chart of two products over six qualities](docs/images/radar.png)

`PolarSeries` draws points by angle and radius, 0 degrees up and clockwise, as an area, a line, markers or all of
them; `PolarSeries.radar` makes a closed polygon with one corner per category. `createPolarChart` sets up hidden axes
for the angle and the radius and a `PolarGridOverlay` of rings and spokes; `RadialZoomModifier` zooms the radius
around the middle.

```ts
import { createPolarChart, DoubleRange, PolarSeries } from '@tachyon-charts/core';

const { chart, angle, radial } = createPolarChart(textEngine, new DoubleRange(0, 100), ['Speed', 'Price', 'Quality']);
chart.addSeries(PolarSeries.radar([80, 60, 90], angle, radial));
```

## Smith charts

![A series circuit of 20 ohms swept from capacitive to inductive on a Smith chart, one point marked](docs/images/smith.png)

`SmithSeries` draws impedances, given as resistance and reactance in ohms, at their reflection coefficient relative to
a reference impedance (50 ohms by default). `createSmithChart` sets up hidden axes and a `SmithGridOverlay` of the
circles of constant resistance and the arcs of constant reactance, normalized or in ohms (`showsOhms`).
`SmithMarkerOverlay` marks one point with its impedance, reflection coefficient and standing wave ratio;
`SmithMarkerModifier` moves it to the point next to the pointer while the button is held. With `ChartBuilder`, add the
modifier with `addModifier`.

```ts
import { createSmithChart, SmithMarkerOverlay, SmithSeries } from '@tachyon-charts/core';

const { chart, x, y } = createSmithChart(textEngine);
const series = new SmithSeries(resistance, reactance, x, y);
chart.addSeries(series);
chart.addOverlay(new SmithMarkerOverlay(series, 0));
```

## Ternary charts and parallel coordinates

![2000 rows of six measures on parallel axes](docs/images/parallel-coordinates.png)

`TernarySeries` places points of three parts, A at the top, B bottom left and C bottom right; the parts need not add
up to 1. `TernaryGridOverlay` draws the triangle with lines every 20 % and the names of the corners.
`ParallelCoordinatesSeries` draws one line per row across one vertical axis per measure, translucent so that the
density shows; `ParallelAxesOverlay` names the axes with their ranges, and `ParallelAxesModifier` moves an axis
dragged at its name, keeps only the rows of a range dragged along an axis and shows all rows again on a double click.

```ts
import { ParallelAxesModifier, ParallelAxesOverlay, ParallelCoordinatesSeries } from '@tachyon-charts/core';

builder
  .xAxis((a) => a.numeric('x').range(0, 1).hidden())
  .yAxis((a) => a.numeric('y').range(0, 1).hidden())
  .addSeries((x, y) => new ParallelCoordinatesSeries(columns, x, y))
  .addOverlay((chart) => new ParallelAxesOverlay(chart.series[0] as ParallelCoordinatesSeries, names))
  .addModifier(() => new ParallelAxesModifier());
```

## Rasters and colormaps

![A field of 400 x 300 cells with two peaks and a valley in the colormap Inferno](docs/images/raster.png)

`RasterSeries` draws a grid of float values in a colormap: Viridis, Inferno, Magma, Plasma, Turbo and Grayscale, the
same tables as the .NET version. NaN cells stay transparent. The value range is set by the chart, on a linear or a
logarithmic scale; zoomed out, cells are averaged, zoomed in, each cell is a sharp square.

```ts
import { Colormap, DoubleRange, RasterSeries } from '@tachyon-charts/core';

builder.addSeries((x, y) => {
  const series = new RasterSeries(x, y);
  series.colormap = Colormap.builtIn('Inferno');
  series.valueRange = new DoubleRange(-0.5, 1);
  series.setValues(values, 400, 300, { left: -5, right: 5, bottom: -3.75, top: 3.75 });
  return series;
});
```

### Heatmaps and color axes

![A heatmap of 4096 × 4096 cells with a gap, colored by Inferno, with the color bar of its axis](docs/images/heatmap.png)

`HeatmapSeries` shows a grid of values (`HeatmapData`) in the colors of a `ColorAxis`: a color bar beside the plot
with the ticks of the values, which follows the data, can be logarithmic, and has colors for missing values and values
outside its range. Cells have equal steps or edges of their own. With equal cells on linear axes the GPU picks the cells
from one texture of all values, so that zooming and panning upload nothing; other grids and logarithmic axes are
sampled per pixel. Zooming the plot leaves the color axis alone; the wheel over the color bar changes its range.

```ts
import { ColorAxis, HeatmapData, HeatmapSeries } from '@tachyon-charts/core';

const data = new HeatmapData(4096, 4096);
data.setValues(values);
builder
  .yAxis((a) => a.numeric('y'))
  .yAxis((a) => a.color('Inferno', 'values'))
  .addSeries((x, y, axis) => new HeatmapSeries(data, x, y, axis('values') as ColorAxis));
```

### Spectrograms

![A spectrogram of a sweeping tone with an overtone and pauses, in the colormap Plasma](docs/images/spectrogram.png)

`SpectrogramSeries` draws a waterfall of rows (`SpectrogramData`, a ring that keeps the newest rows): frequencies along
X, time along Y, the newest row at 0. A new row reaches the GPU as one row of a ring texture, and the shader turns the
ring, so nothing else moves in memory; a pixel over several cells shows their maximum, so that narrow lines stay
visible. 4096 × 4096 cells with a new row every frame draw at 60 FPS while zooming, with WebGPU and with WebGL 2.

```ts
import { ColorAxis, SpectrogramData, SpectrogramSeries } from '@tachyon-charts/core';

const data = new SpectrogramData(4096, 4096);
builder
  .yAxis((a) => a.numeric('y').range(-4096, 0))
  .yAxis((a) => a.color('Plasma', 'values'))
  .addSeries((x, y, axis) => new SpectrogramSeries(data, x, y, axis('values') as ColorAxis));
data.appendRow(spectrum);
```

### Contours

![Height lines over filled bands with their values along the lines](docs/images/contour.png)

`ContourSeries` draws the isolines of a grid (`HeatmapData`, the samples in the middle of the cells), found with
marching squares as in the .NET version, optionally over filled bands in the colors of its color axis. With
`showsLabels` the lines carry their values: along the line, upright, on a plate that hides the line beneath, at most
one per level and tile of the screen and never on top of each other; zooming and panning move them along.

```ts
import { ColorAxis, ContourSeries } from '@tachyon-charts/core';

builder
  .yAxis((a) => a.color('Viridis', 'values'))
  .addSeries((x, y, axis) =>
    Object.assign(new ContourSeries(data, x, y, axis('values') as ColorAxis), { isFilled: true, showsLabels: true }),
  );
```

## Column files

`@tachyon-charts/large-data` reads and writes column files (TCOL), the format of the .NET version for data larger than
memory: both versions read each other's files, and write the same bytes. A file opens from a `File` dropped onto the
page, from the origin private file system (synchronous access in a worker), or from a server with HTTP range requests;
only the pieces read travel.

```ts
import { ColumnFile, ColumnFileWriter, httpSource, MemorySink } from '@tachyon-charts/large-data';

const file = await ColumnFile.open(await httpSource('/data/signal.tcol'));
const values = await file.read(0, 1_000_000, 4096); // column 0, from row 1 000 000, up to 4 096 values

const writer = new ColumnFileWriter(new MemorySink(), { type: 'float32', columns: 2, xStep: 0.001 });
await writer.append(rows); // x0, y0, x1, y1, …
await writer.close();
```

### A line from a file larger than memory

![A line of 250 million values from a file in the browser, with five single spikes clearly visible](docs/images/line-from-a-large-file.png)

`LargeColumn` opens a column in a worker and builds its pyramid of extremes there, in pieces spread over the whole
file, so the first picture comes at once and refines while the rest is read. `ColumnLineSeries` draws it: from the
pyramid while a pixel column holds many values (a single spike is never lost), exactly from the file when zoomed in,
and from the values themselves at the end, reading ahead to both sides. The finished pyramid is kept in the origin
private file system, so the file opens at once the next time.

```ts
import { ColumnLineSeries, LargeColumn } from '@tachyon-charts/large-data';

const column = await LargeColumn.open({ opfs: 'recordings/run.tcol' }); // or { file } or { url }
chart.chart = new ChartBuilder()
  .xAxis((a) => a.autoRange())
  .yAxis((a) => a.autoRange())
  .addSeries((x, y) => new ColumnLineSeries(column, x, y));
```

A billion float32 values (4 GB) from the origin private file system: first picture after 0.44–0.49 s, the pyramid
complete after 5.5–6.4 s, zoom and pan at 60 FPS, the spike among them kept. The showroom writes a test file of 1 GB
on the page "Line from a large file".

### Digital channels

![Sixteen digital channels of a billion points each, one of them from a bit file, as levels, edges and bursts](docs/images/digital-channels.png)

`DigitalSeries` draws a digital signal as levels and edges, low and high at two values of the Y axis, so that many
channels stand one above the other. Each pixel column asks only for its level and whether it changes, so no edge is
lost, however many points a view holds; narrow views draw every change. Signals come as `DigitalTransitions` (the
places where the level changes), `PackedBits` in memory, or `BitColumn` from a bit column of a column file, whose
index of changes a worker builds while the chart already draws. `BitFileWriter` writes such files, the same bytes as
the .NET version.

```ts
import { DigitalSeries, DigitalTransitions } from '@tachyon-charts/core';
import { BitColumn } from '@tachyon-charts/large-data';

const clock = new DigitalTransitions(0, 1e-9);
clock.append(true, 500); // levels as they come, in runs
const file = await BitColumn.open({ opfs: 'capture/channel0.tcol' });
builder.addSeries((x, y) => Object.assign(new DigitalSeries(file, x, y), { low: 1, high: 1.7 }));
```

### Scatter density from files

![Twenty million points in clusters and a ring as a density in the colormap Inferno](docs/images/scatter-density-from-a-file.png)

`PointTiles` sorts the points of two columns of a column file once into tiles (TPTS, the format of the .NET version,
the same bytes): 1024 × 1024 tiles over the extent, the points of each tile in a random order, and a grid of
4096 × 4096 counts. A worker builds them in bands of tiles that fit in memory, so any number of points works, and
keeps them in the origin private file system. `PointDensitySeries` counts the view per pixel in that worker: a wide
view from the grid, each cell shared out by area, a narrow one from the points of the visible tiles, at most four
million of them, a fair share of each dense tile weighed for the rest. The counts are drawn as a raster on a
logarithmic colormap; zoomed in, single points show. The showroom writes 20 million points on the page
"Scatter density from a file"; their tiles take about 5 s.

```ts
import { Colormap } from '@tachyon-charts/core';
import { PointDensitySeries, PointTiles } from '@tachyon-charts/large-data';

const tiles = await PointTiles.open({ opfs: 'data/points.tcol' }, { xColumn: 0, yColumn: 1 });
builder.addSeries((x, y) => Object.assign(new PointDensitySeries(tiles, x, y), { colormap: Colormap.builtIn('Inferno') }));
```

### Rasters larger than memory

![A terrain of 50 million cells with a lake in the colormap Turbo](docs/images/raster-from-a-large-file.png)

`RasterFileWriter` writes a raster file (TRAS, the format of the .NET version) row batch by row batch, and
`LargeRaster` opens one from the origin private file system, a File or a server with range requests. A worker builds
its stages once, each half the size of the one below, by mean, maximum or nearest cell, the same bytes as the .NET
version, and keeps them in the origin private file system. `FileRasterSeries` reads only the visible part of the
stage that fits the zoom. The showroom writes 50 million cells (200 MB) on the page "Raster from a large file"; their
stages take about 2 s.

```ts
import { Colormap } from '@tachyon-charts/core';
import { FileRasterSeries, LargeRaster } from '@tachyon-charts/large-data';

const raster = await LargeRaster.open({ opfs: 'data/terrain.tras' });
builder.addSeries((x, y) => Object.assign(new FileRasterSeries(raster, x, y), { colormap: Colormap.builtIn('Turbo') }));
```

### Recording for hours

![A live recording of a million values per second into a ring of files, drawn while it grows](docs/images/recording.png)

`ColumnRecorder` writes values into column files of fixed size in the origin private file system, one after the
other, as a ring that lets the oldest file go or on and on. It is at once the source and the pyramid of a line over
the recording: memory holds only the extremes of the blocks of the files kept, about 1 % of the values, and the
values come back from the files when a chart zooms in. Each file is a complete column file once full.

```ts
import { ColumnLineSeries, ColumnRecorder } from '@tachyon-charts/large-data';

const recorder = await ColumnRecorder.start({ folder: 'recordings', name: 'run', maxFiles: 8, xStep: 1e-6 });
chart.chart = new ChartBuilder()
  .xAxis((a) => a.autoRange())
  .yAxis((a) => a.autoRange())
  .addSeries((x, y) => new ColumnLineSeries(recorder, x, y));
recorder.append(values); // from the device, as they come
```

A million values per second into a ring of 8 files keeps the memory of the page at 58 MB once the ring is full.

### CSV into column files

![A line from a CSV file of 200 MB, converted in under a second, with the button to choose a file of one's own](docs/images/line-from-a-csv-file.png)

`csvToColumnFile` converts a CSV file of numbers into a column file once, as the .NET version does and to the same
values: the file streams in (a `File`, a `Blob` or the body of a fetch), is cut into pieces at line ends and parsed
in parse workers on all cores, and the rows are written in order. The header names the columns; X comes from a column
when it steps evenly, else the rows are numbered. Delimiters, a decimal comma, thousands separators, quotes and
values that are no numbers (they become gaps) are handled.

```ts
import { csvToColumnFile, opfsFile, writableSink } from '@tachyon-charts/large-data';

const target = await opfsFile('data/run.tcol', true);
const summary = await csvToColumnFile(file, writableSink(await target.createWritable()), {
  xColumn: 0,
  onProgress: (share) => (bar.value = share),
});
```

A CSV file of 1 GB converts into the origin private file system in 4.6–4.9 s (about 210 MB/s with 8 workers).

## Export

![An area chart exported as PNG at 192 dpi](docs/images/export.png)

A chart becomes a file as in the .NET version, and the display stays as it is:

- **PNG** with the renderer of the chart, at any size and resolution, with the resolution in the file, so that a
  picture of 300 dpi prints at its size.
- **SVG** with lines, shapes and markers as vectors and text and rasters as pictures of at least 288 dpi.
- **CSV** of the points in the visible ranges: series, X and Y; times as the cursor shows them.
- **Video** as WebM: each frame belongs to a fixed time, frame number by frame rate, and `step` moves a range or
  appends data before it.

```ts
const png = await chart.exportPng({ width: 1200, height: 800, dpi: 300 });
const svg = await chart.exportSvg({ width: 1200, height: 800 });
const csv = await chart.exportCsv();
const video = await chart.recordVideo({ duration: 5, step: (frame, seconds) => moveTo(seconds) });
```

`chartToPng`, `chartToSvg`, `chartToCsv` and `recordChartVideo` of `@tachyon-charts/render-canvas` do the same for a
chart of your own. The showroom exports the page shown with the buttons in its header.

## Interaction

![A crosshair with the values of two lines beside it and the values of both axes at its lines](docs/images/crosshair-values.png)

The wheel zooms around the pointer, dragging pans, Ctrl and drag zooms into a rectangle, dragging an axis moves it and
Shift scales it, arrows and + and − move and zoom, Home or a double click shows all data again, Ctrl+Z and Ctrl+Y undo
and redo, and two fingers pan and pinch. A crosshair shows the values of the axes and of all series, a tooltip reports
the nearest point. The interactions are modifiers in a pipeline, the same as in the .NET version, and
`bindChartInput` from `@tachyon-charts/element` feeds them the pointer, wheel and key events of a canvas:

```ts
const pipeline = new ModifierPipeline();
pipeline.interaction = new ChartInteraction(chart);
pipeline.add(new ZoomPanModifier());
pipeline.add(new RubberBandZoomModifier());
pipeline.add(new CrosshairModifier());
bindChartInput(canvas, pipeline);
```

## Themes

![The theme preview in the light theme: a line and markers with titled axes](docs/images/theme-light.png)

Charts take the themes of the .NET version, from the same JSON files: Tachyon Dark and Light, High Contrast, Neon,
Paper, Instrument and Signal, or a theme of your own that changes some values of one of them. `@tachyon-charts/element`
adds light or dark after the preference of the system and themes from CSS custom properties:

```ts
chart.theme = findBuiltInTheme('light');
chart.theme = resolveTheme({ name: 'Mine', base: 'dark', grid: { major: '#FF000080' } });
watchPreferredTheme((theme) => (chart.theme = theme));
chart.theme = themeFromCss(container); // --tachyon-background, --tachyon-grid-major, --tachyon-palette …
```

A chart described with the fluent API brings its own theme with `.theme(findBuiltInTheme('instrument'))`;
`<tachyon-chart>` uses it unless its `theme` attribute names another one.

## Showroom

![The showroom: a navigation of all chart types at the left, a sine line in the theme Instrument at the right](docs/images/showroom.png)

`examples/showroom` shows every finished feature on a page of its own: lines, splines, step lines, a million points,
scatter, areas, bands, bars, logarithmic, category and time axes, axes in the origin, the themes, data from workers,
many charts, files larger than memory, CSV, recording, digital channels, rasters and scatter density. A theme and the
language of the axes can be chosen at the top for all pages. Every new feature brings its page.

## Packages

| Package | Content |
|---|---|
| `@tachyon-charts/core` | Charts, axes, data, interaction, layout and themes |
| `@tachyon-charts/render-webgpu` | WebGPU backend |
| `@tachyon-charts/render-webgl` | WebGL 2 fallback, the same images as WebGPU |
| `@tachyon-charts/render-canvas` | Canvas 2D fallback, the images of the Skia backend; export as PNG, SVG, CSV and video |
| `@tachyon-charts/element` | The web component `<tachyon-chart>` |
| `@tachyon-charts/large-data` | Column files, pyramids, OPFS, HTTP range requests, workers |
| `@tachyon-charts/3d` | 3D charts |
| `@tachyon-charts/geo` | Maps |
| `@tachyon-charts/medical` | DICOM and NIfTI images |
| `@tachyon-charts/configurator` | The configurator as a web app |

## Documentation

- [File formats](docs/guide/file-formats.md): column files, pyramids, point tiles, rasters and maps

## Build from source

Requires Node.js 22.12 or later. pnpm comes with Node.js through Corepack.

```bash
corepack pnpm install
corepack pnpm build
```

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
