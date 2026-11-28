// The pages with files larger than memory, loaded when one of them is first shown.
import {
  Colormap,
  DigitalSeries,
  DigitalTransitions,
  ChartBuilder,
  rgba,
  type DigitalSource,
  LoadingOverlay,
} from '@tachyon-charts/core';
import {
  BitColumn,
  BitFileWriter,
  ColumnFile,
  ColumnFileWriter,
  ColumnLineSeries,
  ColumnRecorder,
  FileRasterSeries,
  LargeRaster,
  PointDensitySeries,
  PointTiles,
  RasterFileWriter,
  csvToColumnFile,
  LargeColumn,
  opfsFile,
  opfsSource,
  writableSink,
} from '@tachyon-charts/large-data';

import { t } from './texts';
import { refining, sayer, took, type Page, instrument } from './page-kit';

const largeFile = { path: 'showroom/line-250m.tcol', count: 250_000_000 };

async function hasLargeFile(): Promise<boolean> {
  try {
    const file = await ColumnFile.open(await opfsSource(largeFile.path));
    return file.rows === largeFile.count;
  } catch {
    return false;
  }
}

// A CSV file converted into a column file in parse workers, then drawn through its pyramid: a sample of 200 MB the
// first visit writes, or a file of one's own.
const sampleCsv = { path: 'showroom/sample.csv', size: 200_000_000 };

async function writeSampleCsv(progress: (share: number) => void): Promise<void> {
  const handle = await opfsFile(sampleCsv.path, true);
  if ((await handle.getFile()).size >= sampleCsv.size) {
    return;
  }
  const stream = await handle.createWritable();
  await stream.write('time,value\n');
  let level = 0;
  for (let size = 0, row = 0; size < sampleCsv.size;) {
    let part = '';
    for (let i = 0; i < 100_000; i++, row++) {
      level += (Math.random() - 0.5) * 0.01;
      const value = Math.sin(row / 400_000) + 0.2 * Math.sin(row / 977) + level;
      part += `${(row / 1000).toFixed(3)},${value.toFixed(5)}\n`;
    }
    size += part.length;
    await stream.write(part);
    progress(size / sampleCsv.size);
  }
  await stream.close();
}

function recording(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Double click: all, rolling';
  return {
    id: 'recording',
    name: 'Recording',
    group: 'Lines',
    hint,
    configure: (c) => {
      c.theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      const run = { stopped: false, frame: 0 };
      const stopped = (): boolean => run.stopped;
      let recorder: ColumnRecorder | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(hint);
      void (async () => {
        const started = await ColumnRecorder.start({
          folder: 'showroom',
          name: 'recording',
          fileValues: 1 << 24,
          maxFiles: 8,
          xStep: 1e-6,
        });
        if (stopped()) {
          started.dispose();
          return;
        }
        recorder = started;
        if (chart) {
          chart.chart = new ChartBuilder()
            .theme(instrument)
            .xAxis((a) => a.numeric('x').title(t('Time in s')).autoRange())
            .yAxis((a) => a.numeric('y').autoRange())
            .addSeries((x, y) => new ColumnLineSeries(started, x, y));
        }
        // A million values per second, appended each frame: a slow wave, a fast one and noise.
        let last = performance.now();
        let level = 0;
        const chunk = new Float32Array(100_000);
        const feed = (now: number): void => {
          if (stopped()) {
            return;
          }
          const count = Math.min(chunk.length, Math.round(now - last) * 1000);
          last = now;
          const first = started.recorded;
          for (let i = 0; i < count; i++) {
            const row = first + i;
            level += (Math.random() - 0.5) * 0.002;
            chunk[i] = Math.sin(row / 3e6) + 0.3 * Math.sin(row / 997) + level + (Math.random() - 0.5) * 0.1;
          }
          started.append(chunk.subarray(0, count));
          const files = started.fileCount;
          say(
            `${(started.recorded / 1e6).toFixed(1)} M ${t('values recorded')} | ${String(files)} ${t('files')}, ` +
              `${String(Math.round((started.rows * 4) / 1e6))} MB ${t('on the disk')}`,
          );
          run.frame = requestAnimationFrame(feed);
        };
        run.frame = requestAnimationFrame(feed);
      })();
      return {
        dispose: () => {
          run.stopped = true;
          cancelAnimationFrame(run.frame);
          recorder?.dispose();
        },
      };
    },
  };
}

// 16 digital channels of a billion points each, one point a nanosecond: 15 kept as their changes in memory, the
// first read from a bit file of 125 MB in OPFS with one pulse of a single nanosecond. Every edge shows, however far out.
const bitFile = { path: 'showroom/channel.tcol', count: 1_000_000_000, pulse: 612_345_678 };

async function writeBitFile(progress: (share: number) => void): Promise<void> {
  const handle = await opfsFile(bitFile.path, true);
  if ((await handle.getFile()).size >= 64 + bitFile.count / 8) {
    return;
  }
  const writer = new BitFileWriter(writableSink(await handle.createWritable()), 0, 1e-9);
  // A clock that slows down, and the pulse.
  let level = false;
  for (let at = 0, period = 2048; at < bitFile.count;) {
    const run = Math.min(period, bitFile.count - at);
    if (at <= bitFile.pulse && bitFile.pulse < at + run && !level) {
      await writer.append(false, bitFile.pulse - at);
      await writer.append(true, 1);
      await writer.append(false, at + run - bitFile.pulse - 1);
    } else {
      await writer.append(level, run);
    }
    at += run;
    level = !level;
    period = at < bitFile.count / 2 ? 2048 : 4_000_000;
    if (at % (1 << 26) < run) {
      progress(at / bitFile.count);
    }
  }
  await writer.close();
}

function digitalChannels(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Double click: all';
  const loading = new LoadingOverlay();
  const colors = [rgba(110, 210, 130), rgba(80, 170, 240), rgba(240, 130, 90), rgba(230, 200, 80)];
  return {
    id: 'digital-channels',
    name: 'Digital channels',
    group: 'Lines',
    hint,
    configure: (c) => {
      loading.show(t('Loading data'));
      c.addOverlay(() => loading)
        .theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      const run = { stopped: false };
      const stopped = (): boolean => run.stopped;
      let file: BitColumn | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(hint, loading);
      void (async () => {
        await writeBitFile((share) => {
          say(t('The first visit writes a bit file of 125 MB'), share);
        });
        if (stopped()) {
          return;
        }
        const opened = await BitColumn.open({ opfs: bitFile.path });
        if (stopped()) {
          opened.dispose();
          return;
        }
        file = opened;
        const status = (): void => {
          say(
            opened.isComplete
              ? t('16 channels of a billion points; channel 1 from a file, with one pulse of a nanosecond')
              : `${t('Refining')} ${String(Math.floor(opened.progress * 100))} %`,
          );
        };
        opened.onChange(status);
        status();
        // 15 channels in memory as a bus would carry them: quiet stretches of 20 to 120 ms, then bursts of 5 to 30 ms
        // whose clock differs from channel to channel.
        const sources: DigitalSource[] = [opened];
        for (let channel = 1; channel < 16; channel++) {
          const transitions = new DigitalTransitions(0, 1e-9);
          let seed = channel * 7919;
          const random = (range: number): number => {
            seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
            return seed % range;
          };
          const half = 500 * channel;
          for (let at = 0; at < 1_000_000_000;) {
            const quiet = Math.min(20_000_000 + random(100_000_000), 1_000_000_000 - at);
            transitions.append(false, quiet);
            at += quiet;
            const end = Math.min(at + 5_000_000 + random(25_000_000), 1_000_000_000);
            let level = true;
            while (at < end) {
              const length = Math.min(half + random(half), end - at);
              transitions.append(level, length);
              at += length;
              level = !level;
            }
          }
          sources.push(transitions);
        }
        if (chart) {
          let builder = new ChartBuilder()
            .theme(instrument)
            .xAxis((a) => a.numeric('x').title(t('Time in s')).autoRange())
            .yAxis((a) => a.numeric('y').range(-0.5, 16));
          sources.forEach((source, channel) => {
            builder = builder.addSeries((x, y) => {
              const series = new DigitalSeries(source, x, y);
              series.low = 15 - channel;
              series.high = 15 - channel + 0.7;
              series.color = colors[channel % colors.length] ?? series.color;
              return series;
            });
          });
          chart.chart = builder;
        }
      })();
      return {
        dispose: () => {
          run.stopped = true;
          file?.dispose();
        },
      };
    },
  };
}

function lineFromACsvFile(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all';
  const loading = new LoadingOverlay();
  return {
    id: 'line-from-a-csv-file',
    name: 'Line from a CSV file',
    group: 'Lines',
    hint,
    configure: (c) => {
      loading.show(t('Loading data'));
      c.addOverlay(() => loading)
        .theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      const run = { stopped: false, conversion: 0 };
      const stopped = (): boolean => run.stopped;
      let column: LargeColumn | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(hint, loading);
      // A file of one's own: the first column is X, the second the line.
      const picker = document.createElement('label');
      picker.className = 'picker';
      picker.textContent = `${t('CSV file of your own')} `;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      picker.append(input);
      chart?.after(picker);

      const show = async (csv: Blob, conversion: number): Promise<void> => {
        column?.dispose();
        column = undefined;
        const handle = await opfsFile('showroom/converted.tcol', true);
        const started = performance.now();
        const summary = await csvToColumnFile(csv, writableSink(await handle.createWritable()), {
          xColumn: 0,
          columns: [1],
          onProgress: (share) => {
            say(t('Converting'), share);
          },
        });
        if (stopped() || conversion !== run.conversion) {
          return;
        }
        const seconds = (performance.now() - started) / 1000;
        const converted = `${summary.rows.toLocaleString()} ${t('rows converted in')} ${seconds.toFixed(1)} s (${(csv.size / 1e6 / seconds).toFixed(0)} MB/s)`;
        const opened = await LargeColumn.open({ opfs: 'showroom/converted.tcol' }, { cache: false });
        if (stopped() || conversion !== run.conversion) {
          opened.dispose();
          return;
        }
        column = opened;
        say(converted);
        if (chart) {
          chart.chart = new ChartBuilder()
            .addOverlay((built) => refining(built))
            .theme(instrument)
            .xAxis((a) => a.numeric('x').title(t('Time in s')).autoRange())
            .yAxis((a) =>
              a
                .numeric('y')
                .title(summary.names[0] ?? '')
                .autoRange(),
            )
            .addSeries((x, y) => new ColumnLineSeries(opened, x, y));
        }
      };
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) {
          run.conversion++;
          void show(file, run.conversion).catch((error: unknown) => {
            say(error instanceof Error ? error.message : String(error));
          });
        }
      });
      void (async () => {
        await writeSampleCsv((share) => {
          say(t('The first visit writes a sample CSV of 200 MB'), share);
        });
        if (!stopped() && run.conversion === 0) {
          await show(await (await opfsFile(sampleCsv.path)).getFile(), 0);
        }
      })();
      return {
        dispose: () => {
          run.stopped = true;
          picker.remove();
          column?.dispose();
        },
      };
    },
  };
}

function lineFromALargeFile(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all';
  const loading = new LoadingOverlay();
  return {
    id: 'line-from-a-large-file',
    name: 'Line from a large file',
    group: 'Lines',
    hint,
    configure: (c) => {
      loading.show(t('Loading data'));
      c.addOverlay(() => loading)
        .theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      // Asked through a function, so that the checks after each await see a stop that came meanwhile.
      const run = { stopped: false };
      const stopped = (): boolean => run.stopped;
      let column: LargeColumn | undefined;
      let worker: Worker | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(hint, loading);
      const percent = (share: number): string => `${String(Math.floor(share * 100))} %`;
      void (async () => {
        if (!(await hasLargeFile())) {
          worker = new Worker(new URL('./large-file-worker.ts', import.meta.url), { type: 'module' });
          const writing = worker;
          await new Promise<void>((resolve) => {
            writing.addEventListener('message', (event: MessageEvent<{ progress?: number; done?: boolean }>) => {
              if (event.data.done) {
                resolve();
              } else {
                say(t('The first visit writes a test file of 1 GB'), event.data.progress ?? 0);
              }
            });
            writing.postMessage(largeFile);
          });
          writing.terminate();
        }
        if (stopped()) {
          return;
        }
        const opened = await LargeColumn.open({ opfs: largeFile.path });
        if (stopped()) {
          opened.dispose();
          return;
        }
        column = opened;
        const status = (): void => {
          say(
            opened.isComplete
              ? `${t('250 million values, five spikes among them')} | ${t('Pyramid')} ${took(opened)}`
              : `${t('Refining')} ${percent(opened.progress)}`,
          );
        };
        opened.onChange(status);
        status();
        if (chart) {
          chart.chart = new ChartBuilder()
            .addOverlay((built) => refining(built))
            .theme(instrument)
            .xAxis((a) => a.numeric('x').title(t('Time in s')).autoRange())
            .yAxis((a) => a.numeric('y').autoRange())
            .addSeries((x, y) => {
              const series = new ColumnLineSeries(opened, x, y);
              series.name = t('Signal');
              return series;
            });
        }
      })();
      return {
        dispose: () => {
          run.stopped = true;
          worker?.terminate();
          column?.dispose();
        },
      };
    },
  };
}

const rasterFile = { path: 'showroom/terrain.tras', width: 8192, height: 6144 };

async function writeRasterFile(progress: (share: number) => void): Promise<void> {
  const handle = await opfsFile(rasterFile.path, true);
  const { width, height } = rasterFile;
  if ((await handle.getFile()).size >= 64 + width * height * 4) {
    return;
  }
  const writer = new RasterFileWriter(writableSink(await handle.createWritable()), {
    width,
    xStart: 0,
    xStep: 1 / 1024,
    yStart: 0,
    yStep: 1 / 1024,
  });
  const sine = Float32Array.from({ length: 4096 }, (_, i) => Math.sin((i / 4096) * Math.PI * 2));
  const wave = (turns: number): number => sine[Math.floor(turns * 4096) & 4095] as number;
  const rows = 128;
  const batch = new Float32Array(rows * width);
  for (let first = 0; first < height; first += rows) {
    for (let r = 0; r < rows; r++) {
      const y = first + r;
      for (let x = 0; x < width; x++) {
        const lake = (x - 5600) * (x - 5600) + 2 * (y - 2300) * (y - 2300) < 700 * 700;
        batch[r * width + x] = lake
          ? Number.NaN
          : 40 +
            25 * wave(x / 5000) * wave(y / 3700 + 0.25) +
            12 * wave((x + y) / 1900) +
            5 * wave(x / 23) * wave(y / 19);
      }
    }
    await writer.append(batch);
    progress((first + rows) / height);
  }
  await writer.close();
}

function rasterFromALargeFile(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Double click: all';
  const loading = new LoadingOverlay();
  return {
    id: 'raster-from-a-large-file',
    name: 'Raster from a large file',
    group: 'Rasters',
    hint,
    configure: (c) => {
      loading.show(t('Loading data'));
      c.addOverlay(() => loading)
        .theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      const run = { stopped: false };
      const stopped = (): boolean => run.stopped;
      let raster: LargeRaster | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(hint, loading);
      void (async () => {
        await writeRasterFile((share) => {
          say(t('The first visit writes a raster file of 200 MB'), share);
        });
        if (stopped()) {
          return;
        }
        const opened = await LargeRaster.open({ opfs: rasterFile.path });
        if (stopped()) {
          opened.close();
          return;
        }
        raster = opened;
        const status = (): void => {
          say(
            opened.isReady
              ? `${t('50 million cells; zoom in for the ripples')} | ${t('Stages')} ${took(opened)}`
              : `${t('Stages')} ${String(Math.floor(opened.progress * 100))} %`,
          );
        };
        opened.onChange(status);
        status();
        if (chart) {
          chart.chart = new ChartBuilder()
            .addOverlay((built) => refining(built))
            .theme(instrument)
            .xAxis((a) => a.numeric('x').title(t('East in km')).autoRange())
            .yAxis((a) => a.numeric('y').title(t('North in km')).autoRange())
            .addSeries((x, y) => {
              const series = new FileRasterSeries(opened, x, y);
              series.colormap = Colormap.builtIn('Turbo');
              return series;
            });
        }
      })();
      return {
        dispose: () => {
          run.stopped = true;
          raster?.close();
        },
      };
    },
  };
}

// 20 million points in clusters and a ring (160 MB as two float32 columns in OPFS), drawn as a density: the grid of
// the point tiles for the whole of it, the points of the visible tiles when zoomed in.
const pointsFile = { path: 'showroom/points.tcol', count: 20_000_000 };

async function writePointsFile(progress: (share: number) => void): Promise<void> {
  const handle = await opfsFile(pointsFile.path, true);
  if ((await handle.getFile()).size >= 64 + pointsFile.count * 8) {
    return;
  }
  const writer = new ColumnFileWriter(writableSink(await handle.createWritable()), { type: 'float32', columns: 2 });
  const centers = [
    [2, 3, 0.6],
    [6, 7, 1.2],
    [7.5, 2.5, 0.35],
    [4, 5.5, 2.5],
  ] as const;
  let seed = 12_345;
  const uniform = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  // Normal, by Box and Muller.
  const normal = (): number => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
  const chunk = new Float32Array(2 * (1 << 20));
  for (let first = 0; first < pointsFile.count; first += chunk.length / 2) {
    const size = Math.min(chunk.length / 2, pointsFile.count - first);
    for (let i = 0; i < size; i++) {
      const pick = uniform();
      if (pick < 0.15) {
        // A thin ring around the middle.
        const angle = uniform() * Math.PI * 2;
        const radius = 3.6 + normal() * 0.03;
        chunk[i * 2] = 5 + radius * Math.cos(angle);
        chunk[i * 2 + 1] = 5 + radius * Math.sin(angle);
      } else {
        const [x, y, spread] = centers[Math.floor(uniform() * centers.length)] ?? centers[0];
        chunk[i * 2] = x + normal() * spread * 0.5;
        chunk[i * 2 + 1] = y + normal() * spread * 0.5;
      }
    }
    await writer.append(size * 2 === chunk.length ? chunk : chunk.subarray(0, size * 2));
    progress((first + size) / pointsFile.count);
  }
  await writer.close();
}

function scatterDensityFromAFile(): Page {
  const hint = 'Wheel: zoom | Drag: pan | Double click: all';
  const loading = new LoadingOverlay();
  return {
    id: 'scatter-density-from-a-file',
    name: 'Scatter density from a file',
    group: 'Points and areas',
    hint,
    configure: (c) => {
      loading.show(t('Loading data'));
      c.addOverlay(() => loading)
        .theme(instrument)
        .xAxis((a) => a.numeric('x'))
        .yAxis((a) => a.numeric('y'));
    },
    start: () => {
      const run = { stopped: false };
      const stopped = (): boolean => run.stopped;
      let tiles: PointTiles | undefined;
      const chart = document.querySelector<HTMLElement & { chart: unknown }>('#chart');
      const say = sayer(hint, loading);
      void (async () => {
        await writePointsFile((share) => {
          say(t('The first visit writes 20 million points (160 MB)'), share);
        });
        if (stopped()) {
          return;
        }
        const opened = await PointTiles.open({ opfs: pointsFile.path });
        if (stopped()) {
          opened.close();
          return;
        }
        tiles = opened;
        const status = (): void => {
          say(
            opened.isReady
              ? `${t('20 million points as a density; zoom in down to single points')} | ${t('Tiles')} ${took(opened)}`
              : `${t('Tiles')} ${String(Math.floor(opened.progress * 100))} %`,
          );
        };
        opened.onChange(status);
        status();
        if (chart) {
          chart.chart = new ChartBuilder()
            .addOverlay((built) => refining(built))
            .theme(instrument)
            .xAxis((a) => a.numeric('x').autoRange())
            .yAxis((a) => a.numeric('y').autoRange())
            .addSeries((x, y) => {
              const series = new PointDensitySeries(opened, x, y);
              series.colormap = Colormap.builtIn('Inferno');
              return series;
            });
        }
      })();
      return {
        dispose: () => {
          run.stopped = true;
          tiles?.close();
        },
      };
    },
  };
}

let loaded: readonly Page[] | undefined;

/** The pages with files larger than memory, made once. */
export function largePages(): readonly Page[] {
  loaded ??= [
    lineFromALargeFile(),
    lineFromACsvFile(),
    recording(),
    digitalChannels(),
    rasterFromALargeFile(),
    scatterDensityFromAFile(),
  ];
  return loaded;
}
