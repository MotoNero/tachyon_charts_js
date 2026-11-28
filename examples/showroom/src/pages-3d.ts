// The pages of 3D, maps and medical images, loaded when one of them is first shown.
import {
  FrequencyMask,
  CrosshairModifier,
  spectrum,
  SeededRandom,
  SpectrumDisplay,
  ZoomPanModifier,
  HeatmapData,
  SpectrogramData,
  Colormap,
  DoubleRange,
  DataSource,
  TooltipModifier,
  ChartBuilder,
  PolygonRing,
  Polygon,
  type Rgba8,
  RubberBandZoomModifier,
  NumericAxis,
} from '@tachyon-charts/core';
import {
  Bars3D,
  Bubbles3D,
  Line3D,
  Chart3DBuilder,
  ClipPlane3D,
  CloudPages,
  CutCurveFeed,
  Mesh3D,
  Pie3D,
  PointCloud3D,
  Point3D,
  Points3D,
  Scatter3D,
  Shapes3D,
  scene3D,
  Surface3D,
  type Vertex3D,
  Waterfall3D,
  VolumeData,
  evenContours,
} from '@tachyon-charts/3d';
import {
  ColumnFileWriter,
  opfsFile,
  writableSink,
  buildCloudPagesInWorker,
  type CloudPagesBuild,
} from '@tachyon-charts/large-data';
import {
  cloudFromLas,
  createAntenna,
  createKnot,
  landscape,
  landscapeLas,
  measuredMap,
  pipeModel,
  volumeMaximum,
  volumeSlices,
  volumeSurface,
  volumeThrough,
  bodyNifti,
  volumeFromNifti,
} from './models3d';
import { GeoProjection, TileSource, WorldMap, map, tiles } from '@tachyon-charts/geo';
import {
  CtWindowPresets,
  DicomReader,
  DicomSeriesReader,
  MedicalCurvedSlice,
  MedicalHistogram,
  MedicalImageDisplay,
  MedicalMprDisplay,
  MedicalObliqueSlice,
  MedicalPhantoms,
  MedicalProfile,
  MedicalSegment,
  MedicalSegmentation,
  MedicalSlices,
  NiftiImageReader,
  type MedicalVolume,
} from '@tachyon-charts/medical';
import { t } from './texts';
import { sayer, type PageRun, type Page, instrument, pieValues, pieNames } from './page-kit';

const hint3D =
  'Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start | Pointer: values | Click: marker, Delete removes it';
const hintVolume =
  'Drag the orange outline: move the slice | Drag a point or the slider at the top right: change the look | Drag: turn | Wheel: zoom';
const hintPlanes =
  'Drag the orange outline: move the plane | Drag: turn | Shift+drag: move | Wheel: zoom | Arrow keys: turn | Double click, Home: start';

// A wave and a hill over 6 × 6, as ContourData.CreateField of the .NET version.
function field3D(side: number): HeatmapData {
  const values = new Float32Array(side * side);
  for (let row = 0; row < side; row++) {
    const y = (row * 6) / side;
    for (let column = 0; column < side; column++) {
      const x = (column * 6) / side;
      values[row * side + column] =
        Math.sin(x) * Math.cos(y * 1.3) + 0.6 * Math.exp(-((x - 2) * (x - 2) + (y - 4) * (y - 4)));
    }
  }
  const data = new HeatmapData(side, side);
  data.setValues(values);
  return data;
}

// A spectrum of 512 frequencies arriving 20 times a second, its rows one behind the other: a peak wanders across.
function waterfallPage(): Page {
  const columns = 512;
  const rows = 200;
  const data = new SpectrogramData(columns, rows);
  const row = new Float32Array(columns);
  let time = 0;
  const append = (): void => {
    const center = 0.5 + 0.3 * Math.sin(time * 0.02);
    for (let column = 0; column < columns; column++) {
      const place = column / (columns - 1);
      const peak = Math.exp(-Math.pow((place - center) / 0.03, 2));
      const second = 0.6 * Math.exp(-Math.pow((place - 0.8) / 0.02, 2));
      row[column] =
        -80 + 70 * Math.max(peak, second) + 0.5 * Math.sin(column * 0.13 + time * 0.21) + (Math.random() - 0.5) * 2;
    }
    data.appendRow(row);
    time++;
  };
  for (let i = 0; i < rows; i++) {
    append();
  }
  return {
    id: 'waterfall-3d',
    name: 'Waterfall, live',
    group: '3D',
    hint: hint3D,
    configure: (c) => {
      scene3D(c, (s) =>
        s
          .title(t('Waterfall'))
          .xAxis(0, 10, t('Frequency in MHz'))
          .yAxis(0, 20, t('Age in s'))
          .zAxis(-90, 0, t('Level in dBm'))
          .addWaterfall(new Waterfall3D(data, new DoubleRange(0, 10), new DoubleRange(0, 20))),
      );
    },
    start: () => {
      const timer = setInterval(append, 50);
      return {
        dispose: () => {
          clearInterval(timer);
        },
      };
    },
  };
}

// A ring around the z axis from triangles, colored along the ring from blue over green to orange.
function torusMesh(): Mesh3D {
  const around = 96;
  const across = 48;
  const vertices: Vertex3D[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= around; i++) {
    const u = (i / around) * 2 * Math.PI;
    const share = 0.5 + 0.5 * Math.cos(u);
    for (let j = 0; j <= across; j++) {
      const v = (j / across) * 2 * Math.PI;
      const radius = 3 + 1.2 * Math.cos(v);
      vertices.push({
        position: new Point3D(5 + radius * Math.cos(u), 5 + radius * Math.sin(u), 1.2 * Math.sin(v)),
        color: {
          r: Math.round(40 + 215 * share),
          g: Math.round(120 + 60 * Math.sin(u)),
          b: Math.round(230 - 190 * share),
          a: 255,
        },
      });
    }
  }
  for (let i = 0; i < around; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * (across + 1) + j;
      const b = a + across + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return new Mesh3D(vertices, indices, { material: { gloss: 0.6, sharpness: 48 } });
}

// A spectrum of three carriers, 30 traces a second, in a 2D chart below and as a waterfall in 3D above: mask and
// markers of the spectrum show in both.
function spectrumWaterfallPage(): Page {
  const display = new SpectrumDisplay();
  display.mask = new FrequencyMask([0, 3e6, 3.2e6, 1e7], [-5, -5, -9, -9]);
  display.setView(0, 1e7, 0);
  display.markerFrequency = 7e6;
  const frequencies = Float64Array.from({ length: 1024 }, (_, i) => (i * 1e7) / 1023);
  const levels = new Float32Array(frequencies.length);
  let time = 0;
  const deliver = (): void => {
    const center = 2e6 + 1.5e6 * Math.sin(time * 0.02);
    for (let i = 0; i < levels.length; i++) {
      const f = frequencies[i] as number;
      const peak = Math.exp(-Math.pow((f - center) / 2e5, 2));
      const second = 0.6 * Math.exp(-Math.pow((f - 7e6) / 1.5e5, 2));
      levels[i] = -75 + 62 * Math.max(peak, second) + 2 * Math.random();
    }
    display.setTrace(frequencies, levels);
    time++;
  };
  for (let i = 0; i < 200; i++) {
    deliver();
  }
  return {
    id: 'spectrum-waterfall-3d',
    name: 'Spectrum waterfall',
    group: '3D',
    hint: 'Above: drag to turn | Below: wheel: frequency, Ctrl+click: add or remove a marker',
    configure: (c) => {
      const frequency = new NumericAxis('x3d', 'bottom');
      frequency.visibleRange = new DoubleRange(0, 1e7);
      frequency.title = t('Frequency');
      frequency.labelFormat = { useSiPrefixes: true, unit: 'Hz' };
      scene3D(c, (s) =>
        s
          .title(t('Waterfall with mask and markers'))
          .xAxis(frequency)
          .yAxis(0, 400, t('Traces ago'))
          .zAxis(-80, 0, t('Level in dBm'))
          .addWaterfall(Waterfall3D.from(display, new DoubleRange(0, 400))),
      );
    },
    start: () => {
      const main = document.querySelector<HTMLElement>('#chart');
      const below = document.createElement('tachyon-chart');
      const theme = main?.getAttribute('theme');
      if (theme) {
        below.setAttribute('theme', theme);
      }
      below.chart = spectrum(new ChartBuilder(), display).theme(instrument);
      main?.after(below);
      main?.parentElement?.classList.add('with-pair');
      const timer = setInterval(deliver, 1000 / 30);
      return {
        dispose: () => {
          clearInterval(timer);
          below.remove();
          main?.parentElement?.classList.remove('with-pair');
        },
      };
    },
  };
}

// A surface in 3D and its profile in a 2D chart of the same group: zooming the 2D chart narrows the first axis of the
// box, and its crosshair shows as a frame across the box.
function coupled3DPage(): Page {
  const side = 256;
  const values = new Float32Array(side * side);
  for (let i = 0; i < values.length; i++) {
    const px = (2 * (i % side)) / (side - 1) - 1;
    const py = (2 * Math.trunc(i / side)) / (side - 1) - 1;
    values[i] = 0.7 * Math.sin(px * 3) * Math.cos(py * 2.5);
  }
  const data = new HeatmapData(side, side);
  data.setValues(values);
  return {
    id: 'coupled-3d',
    name: 'Coupled with 2D',
    group: '3D',
    hint: 'Below: wheel and drag zoom the box above, the crosshair shows in it | Above: drag to turn',
    configure: (c) => {
      scene3D(c, (s) =>
        s
          .title(t('Narrowed by a 2D chart'))
          .xAxis(-1, 1, 'x')
          .yAxis(-1, 1, 'y')
          .zAxis(-1, 1, 'z')
          .addSurface(new Surface3D(data, new DoubleRange(-1, 1), new DoubleRange(-1, 1)))
          .group('coupled-3d'),
      );
    },
    start: () => {
      const main = document.querySelector<HTMLElement>('#chart');
      const below = document.createElement('tachyon-chart');
      const theme = main?.getAttribute('theme');
      if (theme) {
        below.setAttribute('theme', theme);
      }
      const profile = new DataSource(side);
      for (let i = 0; i < side; i++) {
        const px = (2 * i) / (side - 1) - 1;
        profile.append(px, 0.7 * Math.sin(px * 3));
      }
      below.chart = new ChartBuilder()
        .title(t('Profile at y = 0'))
        .xAxis((a) => a.numeric('x').range(-1, 1))
        .yAxis((a) => a.numeric('z').range(-1, 1))
        .addLine(profile, (line) => line.thickness(1.5))
        .group('coupled-3d')
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new CrosshairModifier());
      main?.after(below);
      main?.parentElement?.classList.add('with-pair');
      return {
        dispose: () => {
          below.remove();
          main?.parentElement?.classList.remove('with-pair');
        },
      };
    },
  };
}

// A surface with an upright plane through it in 3D, and the cut along the plane as a line in a 2D chart below: dragging
// the orange outline moves the plane, and the line follows.
function cut3DPage(): Page {
  const side = 256;
  const values = new Float32Array(side * side);
  for (let i = 0; i < values.length; i++) {
    const px = (2 * (i % side)) / (side - 1) - 1;
    const py = (2 * Math.trunc(i / side)) / (side - 1) - 1;
    values[i] = 0.7 * Math.sin(px * 3) * Math.cos(py * 2.5);
  }
  const data = new HeatmapData(side, side);
  data.setValues(values);
  const surface = new Surface3D(data, new DoubleRange(-1, 1), new DoubleRange(-1, 1));
  const plane = new ClipPlane3D(new Point3D(0, 1, 0), 0.25, { hides: false });
  const feed = new CutCurveFeed(plane, surface);
  return {
    id: 'cut-3d',
    name: 'Cut as a 2D chart',
    group: '3D',
    hint: 'Above: drag the orange outline to move the cut | Below: the cut as a line, wheel and drag zoom both',
    configure: (c) => {
      scene3D(c, (s) =>
        s
          .title(t('Cut through a surface'))
          .xAxis(-1, 1, 'x')
          .yAxis(-1, 1, 'y')
          .zAxis(-1, 1, 'z')
          .addSurface(surface)
          .addPlane(plane)
          .addCut(feed)
          .group('cut-3d'),
      );
    },
    start: () => {
      const main = document.querySelector<HTMLElement>('#chart');
      const below = document.createElement('tachyon-chart');
      const theme = main?.getAttribute('theme');
      if (theme) {
        below.setAttribute('theme', theme);
      }
      below.chart = new ChartBuilder()
        .title(t('The cut along the plane'))
        .xAxis((a) => a.numeric('x').range(-1, 1))
        .yAxis((a) => a.numeric('z').range(-1, 1))
        .addLine(feed.data, (line) => line.thickness(1.5))
        .group('cut-3d')
        .addModifier(() => new ZoomPanModifier())
        .addModifier(() => new CrosshairModifier());
      main?.after(below);
      main?.parentElement?.classList.add('with-pair');
      return {
        dispose: () => {
          below.remove();
          main?.parentElement?.classList.remove('with-pair');
        },
      };
    },
  };
}

// 50 million points of a scanned landscape (600 MB as three float32 columns in OPFS), sorted into pages beside the file
// on the first visit and taken again later: a sample of every page shows the whole at once, the pages a view needs
// finer come in as it moves.
// A smaller cloud for a quick look or a test: ?points=2000000 before the #.
const cloudPoints = Number(new URLSearchParams(location.search).get('points') ?? '') || 50_000_000;
const cloudFile = { path: `showroom/cloud-${String(cloudPoints)}.tcol`, count: cloudPoints };

async function writeCloudFile(progress: (share: number) => void): Promise<void> {
  const handle = await opfsFile(cloudFile.path, true);
  if ((await handle.getFile()).size >= 64 + cloudFile.count * 12) {
    return;
  }
  const writer = new ColumnFileWriter(writableSink(await handle.createWritable()), { type: 'float32', columns: 3 });
  const chunk = new Float32Array(3 * (1 << 20));
  const part = 1 << 20;
  for (let first = 0; first < cloudFile.count; first += part) {
    const size = Math.min(part, cloudFile.count - first);
    // Hills and ripples over -10 to 10, each part with a random generator of its own.
    const random = new SeededRandom(first / part);
    for (let i = 0; i < size; i++) {
      const a = random.nextDouble() * 2 - 1;
      const b = random.nextDouble() * 2 - 1;
      chunk[i * 3] = a * 10;
      chunk[i * 3 + 1] = b * 10;
      chunk[i * 3 + 2] =
        0.45 * Math.sin(a * 12) * Math.cos(b * 9) + 0.15 * Math.sin((a + b) * 33) + 0.02 * random.nextDouble();
    }
    await writer.append(size * 3 === chunk.length ? chunk : chunk.subarray(0, size * 3));
    progress((first + size) / cloudFile.count);
  }
  await writer.close();
}

function cloudPagesPage(): Page {
  return {
    id: 'cloud-pages-3d',
    name: 'Cloud from pages, 50 million',
    group: '3D',
    hint: hint3D + ' | The first visit writes a test file of 600 MB',
    configure: (c) => {
      let written = 0;
      let build: CloudPagesBuild | undefined;
      const file = writeCloudFile((share) => {
        written = share;
      }).then(() => {
        build = buildCloudPagesInWorker({ opfs: cloudFile.path }, [0, 1, 2]);
        return build.file;
      });
      const pages = new CloudPages(file, () => 0.5 * written + 0.5 * (build?.share() ?? 0));
      scene3D(c, (s) =>
        s
          .title(t('Scanned landscape'))
          .xAxis(-10, 10, 'x')
          .yAxis(-10, 10, 'y')
          .zAxis(-1, 1, 'z')
          .addCloud(new PointCloud3D(pages, { heightColors: Colormap.builtIn('viridis'), pointSize: 2 })),
      );
    },
  };
}

const mapHint = 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all';

const capitals: readonly [string, number, number][] = [
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

// Each country by the distance of its middle from the equator, as the .NET version colors them.
async function colorsByLatitude(): Promise<Map<string, Rgba8>> {
  const countries = await WorldMap.countries('coarse');
  const viridis = Colormap.builtIn('viridis');
  const colors = new Map<string, Rgba8>();
  for (const region of countries.regions) {
    if (region.code.length > 0 && !colors.has(region.code)) {
      colors.set(region.code, viridis.sample(Math.abs((region.bounds.north + region.bounds.south) / 2) / 70));
    }
  }
  return colors;
}

function mapPages(): Page[] {
  return [
    {
      id: 'world-map',
      name: 'World map',
      group: 'Maps',
      hint: mapHint,
      configure: (c) => {
        const projection = GeoProjection.equalEarth;
        const places = projection.projectAll(
          capitals.map((capital) => capital[1]),
          capitals.map((capital) => capital[2]),
        );
        const points = new DataSource();
        points.append(places.x, places.y);
        map(c.title(t('Countries by distance from the equator')), projection, (series) => {
          colorsByLatitude().then(
            (colors) => {
              series.setColors(colors);
            },
            () => undefined,
          );
        })
          .addScatter(points, (s) => s.name(t('Capitals')).fill({ r: 230, g: 60, b: 60, a: 255 }).size(7))
          .addModifier(() => new ZoomPanModifier())
          .addModifier(() => new RubberBandZoomModifier())
          .addModifier(() => new TooltipModifier());
      },
    },
    {
      id: 'tile-map',
      name: 'Tile map',
      group: 'Maps',
      hint: mapHint + ' | Server: ?tiles=<address with {z}, {x}, {y}>&attribution=<notice>',
      configure: (c) => {
        // The library names no server: the address and its notice come from the page address, else a local grid.
        const query = new URLSearchParams(location.search);
        const address = query.get('tiles');
        const notice = query.get('attribution');
        const source =
          address && notice ? new TileSource(address, notice, { cacheName: 'tachyon-tiles' }) : TileSource.grid();
        tiles(map(c.title(t('Tiles from a server of your choice')), GeoProjection.webMercator), source)
          .addModifier(() => new ZoomPanModifier())
          .addModifier(() => new RubberBandZoomModifier());
      },
    },
  ];
}

const medicalHint =
  'Left drag: window and level | Keys 1, 2, 3: brain, bone, lung | Middle drag: pan | Wheel: zoom | Pointer: value and position';

// The middle axial slice of a volume of one's own.
function middleSlice(volume: MedicalVolume): MedicalImageDisplay {
  const middle = ((volume.data.depth - 1) * volume.voxelSpacing.z) / 2;
  return MedicalSlices.display(volume, 'axial', new Point3D(0, 0, middle));
}

// An image of DICOM or NIfTI files of one's own: one DICOM file, the files of a series, or one NIfTI volume.
async function openMedicalFiles(files: readonly File[]): Promise<MedicalImageDisplay> {
  const first = files[0];
  if (!first) {
    throw new Error('No file chosen.');
  }
  if (/\.nii(\.gz)?$/iu.test(first.name)) {
    return middleSlice(await NiftiImageReader.readFile(first));
  }
  if (files.length === 1) {
    return MedicalImageDisplay.fromImage(await DicomReader.readFile(first));
  }
  return middleSlice(await DicomSeriesReader.readFiles(files));
}

function medicalFilesPage(): Page {
  return {
    id: 'medical-files',
    name: 'Medical files',
    group: 'Medical',
    hint: medicalHint,
    configure: (c) => {
      // Until a file is chosen, a slice of the synthetic head.
      const slice = MedicalSlices.display(MedicalPhantoms.head(), 'axial', new Point3D(0, 0, 97));
      slice.configure(c);
    },
    start: () => {
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(medicalHint);
      // Files of one's own stay in the browser: they are read here and sent nowhere.
      const picker = document.createElement('label');
      picker.className = 'picker';
      picker.textContent = `${t('DICOM or NIfTI files of your own')} `;
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.dcm,.nii,.gz,application/dicom';
      picker.append(input);
      chart?.after(picker);
      let opening = 0;
      input.addEventListener('change', () => {
        const files = [...(input.files ?? [])];
        const run = ++opening;
        openMedicalFiles(files).then(
          (display) => {
            if (run !== opening || !chart) {
              return;
            }
            chart.chart = display.configure(new ChartBuilder());
            say(`${String(display.width)} × ${String(display.height)}, ${display.unit}`);
          },
          (error: unknown) => {
            say(error instanceof Error ? error.message : String(error));
          },
        );
      });
      return {
        dispose: () => {
          opening++;
          picker.remove();
        },
      };
    },
  };
}

// Charts that belong to the chart of the page, in a row below it, in its theme.
function chartRow(builders: readonly ChartBuilder[]): PageRun {
  const main = document.querySelector<HTMLElement>('#chart');
  const row = document.createElement('div');
  row.className = 'chart-row';
  const theme = main?.getAttribute('theme');
  for (const builder of builders) {
    const element = document.createElement('tachyon-chart') as HTMLElement & { chart: unknown };
    if (theme) {
      element.setAttribute('theme', theme);
    }
    element.chart = builder;
    row.append(element);
  }
  main?.after(row);
  main?.parentElement?.classList.add('with-row');
  return {
    dispose: () => {
      row.remove();
      main?.parentElement?.classList.remove('with-row');
    },
  };
}

const mprHint =
  'Wheel or arrows: slices | Space: play, + and -: speed | Click: place | Drag: window and level | Keys 1, 2, 3: brain, bone, lung | Keys D, A, C, R, F: measure | Del: delete | Ctrl+Z: undo';

function medicalMprPage(): Page {
  let display: MedicalMprDisplay | undefined;
  return {
    id: 'medical-mpr',
    name: 'Medical MPR',
    group: 'Medical',
    hint: mprHint,
    configure: (c) => {
      // The synthetic chest in the lung window: the volume with its planes, the three slices below.
      display = new MedicalMprDisplay(MedicalPhantoms.thorax());
      display.applyPreset(CtWindowPresets.lung);
      const shown = display;
      scene3D(c, (s) => shown.configure3D(s));
    },
    start: () =>
      chartRow(
        display
          ? [display.axial, display.coronal, display.sagittal].map((slice) => slice.configure(new ChartBuilder()))
          : [],
      ),
  };
}

function medicalAnalysisPage(): Page {
  let charts: ChartBuilder[] = [];
  return {
    id: 'medical-analysis',
    name: 'Medical analysis',
    group: 'Medical',
    hint: 'Drag a point of the line or the circle: profile and histogram follow | Drag elsewhere: window, the band in the histogram follows | Wheel: slices',
    configure: (c) => {
      const display = new MedicalMprDisplay(MedicalPhantoms.head());
      display.applyPreset(CtWindowPresets.brain);
      const axial = display.axial;
      const width = axial.width * axial.spacing.column;
      const height = axial.height * axial.spacing.row;
      // A line across the middle of the axial slice and a circle on the focus of the phantom.
      const layer = axial.measurements;
      layer.add(
        'distance',
        [
          { x: width * 0.12, y: height * 0.5 },
          { x: width * 0.88, y: height * 0.5 },
        ],
        undefined,
        t('Profile line'),
      );
      const focus = layer.add(
        'circle',
        [
          { x: width * 0.323, y: height * 0.43 },
          { x: width * 0.358, y: height * 0.43 },
        ],
        undefined,
        t('Focus'),
      );
      const profile = new MedicalProfile(axial);
      const histogram = new MedicalHistogram(axial);
      histogram.region = focus;
      axial.configure(c);
      charts = [profile.configure(new ChartBuilder()), histogram.configure(new ChartBuilder())];
    },
    start: () => chartRow(charts),
  };
}

function medicalReformatPage(): Page {
  let charts: ChartBuilder[] = [];
  return {
    id: 'medical-reformat',
    name: 'Medical oblique and curved',
    group: 'Medical',
    hint: 'Drag an end of the line: the oblique plane follows | Drag a point of the arc: the curved section follows | Wheel on the oblique plane: move it | Key V on the oblique plane: it faces the 3D view | Drag elsewhere: window',
    configure: (c) => {
      // The synthetic chest: a line across the axial slice for the oblique plane, an arc along the front of the body.
      const display = new MedicalMprDisplay(MedicalPhantoms.thorax());
      const axial = display.axial;
      const width = axial.width * axial.spacing.column;
      const height = axial.height * axial.spacing.row;
      const oblique = new MedicalObliqueSlice(display);
      oblique.followLine(axial);
      const curved = new MedicalCurvedSlice(axial);
      const layer = axial.measurements;
      layer.add(
        'distance',
        [
          { x: width * 0.156, y: height * 0.73 },
          { x: width * 0.86, y: height * 0.35 },
        ],
        undefined,
        t('Oblique plane'),
      );
      const arc = Array.from({ length: 13 }, (_, i) => {
        const angle = Math.PI + 0.45 + ((Math.PI - 0.9) * i) / 12;
        return { x: width * (0.5 + 0.396 * Math.cos(angle)), y: height * (0.5 + 0.285 * Math.sin(angle)) };
      });
      curved.path = layer.add('freehand', arc, undefined, t('Arc'));
      scene3D(c, (s) => {
        display.configure3D(s);
        oblique.configure3D(s);
        oblique.viewCamera = s.scene.camera;
        return s;
      });
      charts = [
        axial.configure(new ChartBuilder()),
        oblique.configure(new ChartBuilder()),
        curved.configure(new ChartBuilder()),
      ];
    },
    start: () => chartRow(charts),
  };
}

// The labels of the synthetic head: a focus and a cavity, each an ellipsoid in shares of the volume.
function headLabels(): MedicalSegmentation {
  const head = MedicalPhantoms.head();
  const data = head.data;
  const labels = new Uint16Array(data.width * data.height * data.depth);
  for (let z = 0; z < data.depth; z++) {
    const nz = z / (data.depth - 1);
    for (let y = 0; y < data.height; y++) {
      const ny = y / (data.height - 1);
      for (let x = 0; x < data.width; x++) {
        const nx = x / (data.width - 1);
        const focus = ((nx - 0.32) / 0.11) ** 2 + ((ny - 0.46) / 0.14) ** 2 + ((nz - 0.52) / 0.16) ** 2 < 1;
        const cavity = ((nx - 0.56) / 0.12) ** 2 + ((ny - 0.5) / 0.19) ** 2 + ((nz - 0.5) / 0.28) ** 2 < 1;
        labels[(z * data.height + y) * data.width + x] = focus ? 1 : cavity ? 2 : 0;
      }
    }
  }
  const focus = new MedicalSegment(1, t('Focus'), { r: 245, g: 70, b: 80, a: 255 });
  focus.opacity = 0.62;
  const cavity = new MedicalSegment(2, t('Cavity'), { r: 45, g: 205, b: 235, a: 255 });
  cavity.opacity = 0.48;
  return new MedicalSegmentation(
    new VolumeData(labels, data.width, data.height, data.depth),
    { row: head.voxelSpacing.y, column: head.voxelSpacing.x },
    head.voxelSpacing.z,
    head.origin,
    head.orientation,
    [focus, cavity],
    'surface',
  );
}

function medicalSegmentationPage(): Page {
  let display: MedicalMprDisplay | undefined;
  return {
    id: 'medical-segmentation',
    name: 'Medical segmentation',
    group: 'Medical',
    hint: mprHint,
    configure: (c) => {
      display = new MedicalMprDisplay(MedicalPhantoms.head());
      display.addSegmentation(headLabels());
      const shown = display;
      scene3D(c, (s) => shown.configure3D(s));
    },
    start: () =>
      chartRow(
        display
          ? [display.axial, display.coronal, display.sagittal].map((slice) => slice.configure(new ChartBuilder()))
          : [],
      ),
  };
}

function medicalPages(): Page[] {
  return [
    medicalFilesPage(),
    medicalMprPage(),
    medicalAnalysisPage(),
    medicalReformatPage(),
    medicalSegmentationPage(),
    {
      id: 'medical-measurements',
      name: 'Medical measurements',
      group: 'Medical',
      hint: 'Keys D, A, C, R, F or the bar: distance, angle, circle, rectangle, freehand, then drag | Drag a point: change | Delete: remove | Ctrl+Z: undo | Left drag elsewhere: window',
      configure: (c) => {
        const slice = MedicalSlices.cut(MedicalPhantoms.head(), 'axial', new Point3D(0, 0, 97));
        const image = new MedicalImageDisplay(
          slice.values,
          slice.width,
          slice.height,
          slice.spacing,
          slice.orientation,
          'HU',
        );
        image.applyPreset(CtWindowPresets.brain);
        // Across the skull low down, the angle of two ventricle tips, the round region on the left and the right ventricle.
        const layer = image.measurements;
        layer.add(
          'distance',
          [
            { x: 33, y: 140 },
            { x: 159, y: 140 },
          ],
          undefined,
          t('Width'),
        );
        layer.add('angle', [
          { x: 87, y: 72 },
          { x: 96, y: 122 },
          { x: 105, y: 72 },
        ]);
        layer.add(
          'circle',
          [
            { x: 62.5, y: 82 },
            { x: 68.5, y: 82 },
          ],
          undefined,
          t('Focus'),
        );
        layer.add(
          'freehand',
          [
            { x: 100, y: 70 },
            { x: 110, y: 72 },
            { x: 112, y: 95 },
            { x: 110, y: 120 },
            { x: 101, y: 121 },
            { x: 99, y: 95 },
          ],
          undefined,
          t('Ventricle'),
        );
        layer.showsTools = true;
        image.configure(c);
      },
    },
    {
      id: 'medical-image',
      name: 'Medical image',
      group: 'Medical',
      hint: medicalHint,
      configure: (c) => {
        // One axial plane of the synthetic head, without patient data, as a scanner would store it.
        const slice = MedicalSlices.cut(MedicalPhantoms.head(), 'axial', new Point3D(0, 0, 97));
        const image = new MedicalImageDisplay(
          slice.values,
          slice.width,
          slice.height,
          slice.spacing,
          slice.orientation,
          'HU',
        );
        image.applyPreset(CtWindowPresets.brain);
        image.configure(c);
      },
    },
  ];
}

function pages3D(): Page[] {
  return [
    spectrumWaterfallPage(),
    coupled3DPage(),
    cut3DPage(),
    cloudPagesPage(),
    {
      id: 'cut-planes-3d',
      name: 'Cut planes',
      group: '3D',
      hint: hintPlanes,
      configure: (c) => {
        scene3D(c, (s) =>
          s
            .title(t('Surface'))
            .xAxis(0, 6, 'x')
            .yAxis(0, 6, 'y')
            .zAxis(-1.5, 2, 'z')
            .addSurface(new Surface3D(field3D(256), new DoubleRange(0, 6), new DoubleRange(0, 6)))
            .addPlane(new ClipPlane3D(new Point3D(-1, 0, 0), -0.35))
            .addPlane(new ClipPlane3D(new Point3D(-0.5, 1, 0), -0.5)),
        );
      },
    },
    {
      id: 'model-3d',
      name: 'Model with measuring points',
      group: '3D',
      hint: hintPlanes,
      configure: (c) => {
        scene3D(c, pipeModel);
      },
    },
    {
      id: 'planes-and-limits-3d',
      name: 'Planes and limits',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const red: Rgba8 = { r: 255, g: 70, b: 70, a: 255 };
        const range = new DoubleRange(0, 6);
        const area = new Polygon(new PolygonRing([0.5, 3.0, 4.2, 2.6, 0.8], [0.6, 0.4, 2.2, 3.6, 2.8]), [
          new PolygonRing([1.6, 2.6, 2.2], [1.4, 1.5, 2.4]),
        ]);
        scene3D(c, (s) =>
          s
            .title(t('Surface against a limit of 0.9'))
            .xAxis(0, 6, 'x')
            .yAxis(0, 6, 'y')
            .zAxis(-1.5, 2, 'z')
            .addSurface(
              new Surface3D(field3D(128), range, range, {
                contours: { levels: [0.9], color: red, width: 2.5, onFloor: false },
              }),
            )
            .addMesh(Shapes3D.limit(range, range, 0.9, red))
            .addMesh(
              Shapes3D.rectangle(
                new Point3D(4.5, 0, -1.5),
                new Point3D(0, 6, 0),
                new Point3D(0, 0, 3.5),
                { r: 58, g: 134, b: 255, a: 255 },
                { opacity: 0.25, gloss: 0 },
              ),
            )
            .addMesh(
              Shapes3D.polygon(
                area,
                new Point3D(0, 0, 1.45),
                new Point3D(1, 0, 0),
                new Point3D(0, 1, 0.12),
                { r: 6, g: 214, b: 160, a: 255 },
                { opacity: 0.6, gloss: 0.2 },
              ),
            ),
        );
      },
    },
    {
      id: 'cloud-3d',
      name: 'Point cloud',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) => landscape(s, 500_000).title(t('Scanned landscape')));
      },
    },
    {
      id: 'cloud-10m-3d',
      name: 'Point cloud, 10 million',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) => landscape(s, 10_000_000).title(t('Scanned landscape')));
      },
    },
    {
      id: 'cloud-from-las-3d',
      name: 'Cloud from a LAS file',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) => cloudFromLas(s, landscapeLas(2_000_000)).title(t('Scanned landscape')));
      },
    },
    {
      id: 'volume-slices-3d',
      name: 'Volume slices',
      group: '3D',
      hint: hintPlanes,
      configure: (c) => {
        scene3D(c, (s) => volumeSlices(s, 256).title(t('Slices through a body')));
      },
    },
    {
      id: 'volume-maximum-3d',
      name: 'Maximum projection',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) => volumeMaximum(s, 256).title(t('Highest value along each ray')));
      },
    },
    {
      id: 'volume-surface-3d',
      name: 'Surface of equal value',
      group: '3D',
      hint: hintVolume,
      configure: (c) => {
        scene3D(c, (s) => volumeSurface(s, 256).title(t('Surface of equal value')));
      },
    },
    {
      id: 'volume-through-3d',
      name: 'Through a volume',
      group: '3D',
      hint: hintVolume,
      configure: (c) => {
        scene3D(c, (s) => volumeThrough(s, 192).title(t('Through a body')));
      },
    },
    {
      id: 'volume-nifti-3d',
      name: 'Volume from a NIfTI file',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) => s.title(t('Reading the NIfTI file')));
      },
      start: () => {
        const main = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
        let stopped = false;
        void bodyNifti(192).then(async (file) => {
          const chart = await volumeFromNifti(new Chart3DBuilder(), file);
          if (!stopped && main) {
            main.chart = chart.apply(new ChartBuilder());
          }
        });
        return {
          dispose: () => {
            stopped = true;
          },
        };
      },
    },
    {
      id: 'map-3d',
      name: 'Map from measurements',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, measuredMap);
      },
    },
    {
      id: 'antenna-3d',
      name: 'Antenna pattern',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) => s.title(t('Antenna gain')).addAntenna(createAntenna()));
      },
    },
    {
      id: 'pie-3d',
      name: 'Pie 3D',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) => s.title(t('Power mix')).addPie(new Pie3D(pieValues, { names: pieNames, explodedIndex: 1 })));
      },
    },
    {
      id: 'donut-3d',
      name: 'Donut 3D',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) =>
          s.title(t('Power mix')).addPie(new Pie3D(pieValues, { names: pieNames, innerRadius: 0.55, height: 0.25 })),
        );
      },
    },
    {
      id: 'model-1m-triangles',
      name: 'Model of 1 million triangles',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const model = createKnot();
        const mesh = model.toValueMesh(
          model.positions.map((point) => point.z),
          Colormap.builtIn('viridis'),
          new DoubleRange(-1.4, 1.4),
          { gloss: 0.4, sharpness: 48 },
          t('Height in m'),
        );
        scene3D(c, (s) => model.addToScale(s.title(t('Knot of tube, colored by height')), mesh, 'm'));
      },
    },
    {
      id: 'mesh-3d',
      name: 'Lit mesh',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) =>
          s
            .title(t('A ring from triangles in the light'))
            .xAxis(0, 10, 'x')
            .yAxis(0, 10, 'y')
            .zAxis(-3, 3, 'z')
            .addMesh(torusMesh()),
        );
      },
    },
    {
      id: 'see-through-3d',
      name: 'See-through',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const side = 12;
        const values = new Float32Array(side * side);
        for (let row = 0; row < side; row++) {
          for (let column = 0; column < side; column++) {
            const x = (column + 0.5) / side;
            const y = (row + 0.5) / side;
            values[row * side + column] = 0.2 + 0.6 * Math.exp(-8 * ((x - 0.5) * (x - 0.5) + (y - 0.5) * (y - 0.5)));
          }
        }
        const data = new HeatmapData(side, side);
        data.setValues(values);
        scene3D(c, (s) =>
          s
            .title(t('A see-through surface over see-through columns'))
            .xAxis(0, 6, 'x')
            .yAxis(0, 6, 'y')
            .zAxis(-1.5, 2, 'z')
            .addBars(new Bars3D(data, new DoubleRange(0, 6), new DoubleRange(0, 6), { material: { opacity: 0.6 } }))
            .addSurface(
              new Surface3D(field3D(256), new DoubleRange(0, 6), new DoubleRange(0, 6), {
                material: { opacity: 0.5, gloss: 0.5 },
              }),
            ),
        );
      },
    },
    waterfallPage(),
    {
      id: 'axis-box',
      name: 'Axis box',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) =>
          s
            .title(t('Axis box'))
            .xAxis(0, 10, t('Time in s'))
            .yAxis(-5, 5, t('Offset in mm'))
            .zAxis(0, 100, t('Level in dB')),
        );
      },
    },
    {
      id: 'path-200000',
      name: 'Path of 200,000 points',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const count = 200_000;
        const viridis = Colormap.builtIn('viridis');
        const points = new Points3D(count);
        let [x, y, z] = [1, 1, 20];
        for (let i = 0; i < count; i++) {
          [x, y, z] = [x + 0.02 * (y - x), y + 0.002 * (x * (28 - z) - y), z + 0.002 * (x * y - (8 / 3) * z)];
          points.append(x, y, z, viridis.sample(i / count));
        }
        scene3D(c, (s) =>
          s
            .title(t('Path of a particle'))
            .xAxis(-25, 25, 'x')
            .yAxis(-30, 30, 'y')
            .zAxis(0, 55, 'z')
            .addLine(new Line3D(points)),
        );
      },
    },
    {
      id: 'scatter-3000',
      name: 'Scatter of 3,000 points',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const points = new Points3D(3000);
        const centers = [
          [-0.45, -0.3, -0.3],
          [0.4, 0.35, 0.1],
          [-0.1, 0.45, 0.5],
        ];
        const spread = (): number => 0.24 * (Math.random() + Math.random() + Math.random() - 1.5);
        const viridis = Colormap.builtIn('viridis');
        for (let i = 0; i < 3000; i++) {
          const center = centers[i % 3] as number[];
          const z = (center[2] as number) + spread();
          points.append(
            (center[0] as number) + spread(),
            (center[1] as number) + spread(),
            z,
            viridis.sample((z + 1) / 2),
            3 + 8 * Math.random(),
          );
        }
        scene3D(c, (s) =>
          s
            .title(t('Three clouds'))
            .xAxis(-1, 1, 'x')
            .yAxis(-1, 1, 'y')
            .zAxis(-1, 1, 'z')
            .addScatter(new Scatter3D(points)),
        );
      },
    },
    {
      id: 'height-lines',
      name: 'Height lines',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) =>
          s
            .title(t('Surface'))
            .xAxis(0, 6, 'x')
            .yAxis(0, 6, 'y')
            .zAxis(-1.5, 2, 'z')
            .addSurface(
              new Surface3D(field3D(512), new DoubleRange(0, 6), new DoubleRange(0, 6), {
                contours: { ...evenContours(new DoubleRange(-1.5, 2), 13), onWalls: true },
              }),
            ),
        );
      },
    },
    {
      id: 'columns-3d',
      name: 'Columns',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const side = 16;
        const values = new Float32Array(side * side);
        for (let row = 0; row < side; row++) {
          for (let column = 0; column < side; column++) {
            const x = (column + 0.5) / side;
            const y = (row + 0.5) / side;
            values[row * side + column] =
              0.15 +
              0.85 * Math.exp(-14 * ((x - 0.35) * (x - 0.35) + (y - 0.6) * (y - 0.6))) +
              0.35 * Math.exp(-30 * ((x - 0.8) * (x - 0.8) + (y - 0.25) * (y - 0.25)));
          }
        }
        const data = new HeatmapData(side, side);
        data.setValues(values);
        scene3D(c, (s) =>
          s
            .title(t('Columns over a raster'))
            .xAxis(0, 16, 'x')
            .yAxis(0, 16, 'y')
            .zAxis(0, 1.2, t('Value'))
            .addBars(new Bars3D(data, new DoubleRange(0, 16), new DoubleRange(0, 16), { material: { gloss: 0.4 } })),
        );
      },
    },
    {
      id: 'bubbles-3d',
      name: 'Bubbles',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        const fields = [
          { r: 255, g: 190, b: 11, a: 255 },
          { r: 58, g: 134, b: 255, a: 255 },
          { r: 6, g: 214, b: 160, a: 255 },
        ];
        const middles = [
          [2.5, 3, 4],
          [7, 6.5, 6],
          [4.5, 7.5, 2.5],
        ];
        const gauss = (): number => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
        const x: number[] = [];
        const y: number[] = [];
        const z: number[] = [];
        const yields: number[] = [];
        const colors: Rgba8[] = [];
        for (let i = 0; i < 180; i++) {
          const field = Math.trunc(i / 60);
          const middle = middles[field] as number[];
          x.push((middle[0] as number) + gauss() * 1.3);
          y.push((middle[1] as number) + gauss() * 1.1);
          z.push((middle[2] as number) + gauss() * 0.9);
          yields.push(20 + 380 * Math.pow(Math.random(), 3));
          colors.push(fields[field] as Rgba8);
        }
        scene3D(c, (s) =>
          s
            .title(t('Wells, volume by yield in m³ per day'))
            .xAxis(0, 10, t('East in km'))
            .yAxis(0, 10, t('North in km'))
            .zAxis(0, 8, t('Depth in 100 m'))
            .addBubbles(new Bubbles3D(x, y, z, Bubbles3D.scaleToVolume(yields, 0.15, 0.9), { colors, values: yields })),
        );
      },
    },
    {
      id: 'surface-4096',
      name: 'Surface 4096 × 4096',
      group: '3D',
      hint: hint3D,
      configure: (c) => {
        scene3D(c, (s) =>
          s
            .title(t('Surface'))
            .xAxis(0, 6, 'x')
            .yAxis(0, 6, 'y')
            .zAxis(-1.5, 2, 'z')
            .addSurface(new Surface3D(field3D(4096), new DoubleRange(0, 6), new DoubleRange(0, 6))),
        );
      },
    },
  ];
}

// A share price of 160 days with drawing tools: keys 1 to 9 choose a tool, as the drawing tools page of the .NET
// showroom; the drawings of the first gallery picture are there from the start.

let loaded: readonly Page[] | undefined;

/** The 3D pages, the maps and the medical pages, made once. */
export function heavyPages(): readonly Page[] {
  loaded ??= [...pages3D(), ...mapPages(), ...medicalPages()];
  return loaded;
}
