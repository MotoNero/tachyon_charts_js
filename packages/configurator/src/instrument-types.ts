// The instruments and the digital channels, as InstrumentTypes, InstrumentFeeds and DigitalType of the .NET version.
// Live data come from helper functions of the code; each returns what stops it, and the code collects these in
// `running`.
import type { ChartTypeInfo, ParameterInfo } from './catalog';
import { camel } from './build';
import { num, str, type CodeWriter } from './code';
import { colorCode } from './series-code';
import { flagOf, numberOf, textOf, type SeriesSpec, type SpecValues } from './spec';

const lines = (...items: string[]): string => items.join('\n');
const names = (text: string): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
const numbers = (text: string): number[] =>
  names(text)
    .map(Number)
    .filter((value) => Number.isFinite(value));
const indent = (code: string, by = '  '): string =>
  code
    .split('\n')
    .map((line) => by + line)
    .join('\n');

// The variable of a display made from the data of a series: scopeData gives scopeDisplay.
const displayOf = (data: string): string =>
  /Data(\d*)$/u.test(data) ? data.replace(/Data(\d*)$/u, 'Display$1') : `${data}Display`;

const signals = ['Sine', 'Square', 'Burst', 'Triangle'];

interface ScopeChannelSetting {
  readonly signal: number;
  readonly volts: number;
  readonly position: number;
}

// The channels as the lists give them: missing signals repeat the list, a missing scale takes the last, missing
// positions spread the channels evenly from top to bottom.
function channelsOf(values: SpecValues): ScopeChannelSetting[] {
  const count = Math.min(Math.max(Math.trunc(numberOf(values, 'channels', 2)), 1), 8);
  const chosen = names(textOf(values, 'signals', 'Sine, Square'))
    .map((name) => signals.findIndex((known) => known.toLowerCase() === name.toLowerCase()))
    .filter((index) => index >= 0);
  const volts = numbers(textOf(values, 'volts', '1, 0.5'));
  const positions = numbers(textOf(values, 'positions', '2, -2'));
  return Array.from({ length: count }, (_, c) => {
    const scale = volts.length > 0 ? (volts[Math.min(c, volts.length - 1)] ?? 1) : 1;
    const position = positions[c];
    return {
      signal: chosen.length > 0 ? (chosen[c % chosen.length] ?? 0) : c % signals.length,
      volts: scale > 0 ? scale : 1,
      position:
        position !== undefined ? Math.min(Math.max(position, -4), 4) : count === 1 ? 0 : 3 - (c * 6) / (count - 1),
    };
  });
}

function scopeSignalHelper(writer: CodeWriter): string {
  return writer.helper(
    'scopeSignal',
    lines(
      '// The signals of the sample at a time: sine, square, a decaying burst and a triangle of 1 kHz.',
      `function scopeSignal(${writer.parameter('kind', 'number')}, ${writer.parameter('time', 'number')})${writer.type('number')} {`,
      '  const angle = 2 * Math.PI * 1000 * time;',
      '  switch (kind) {',
      '    case 0:',
      '      return 1.5 * Math.sin(angle);',
      '    case 1:',
      '      return Math.sin(angle) >= 0 ? 1 : -1;',
      '    case 2:',
      '      return 2 * Math.exp(-Math.abs((((time + 0.01) * 1000) % 1) * 6)) * Math.cos(angle * 12);',
      '    default:',
      '      return (2 / Math.PI) * Math.asin(Math.sin(angle));',
      '  }',
      '}',
    ),
  );
}

function acquisitionsHelper(writer: CodeWriter): string {
  scopeSignalHelper(writer);
  const display = writer.useType('ScopeDisplay');
  return writer.helper(
    'startAcquisitions',
    lines(
      '// Acquires 20 000 samples per channel again and again, each time at a random phase as from a free-running signal,',
      '// with noise that also lets the amplitude vary; the trigger holds the picture still. Returns what stops it.',
      `function startAcquisitions(${writer.parameter('display', display)}, ${writer.parameter('signals', 'number[]')}, ${writer.parameter('noise', 'number')}, ${writer.parameter('rate', 'number')})${writer.type('() => void')} {`,
      `  const trigger = new ${writer.use('ScopeTrigger')}(display);`,
      `  const random = new ${writer.use('SeededRandom')}(1);`,
      '  const channels = signals.map(() => new Float32Array(20_000));',
      '  const acquire = () => {',
      '    const shift = random.nextDouble() / 1000;',
      '    const scale = 1 + noise * (random.nextDouble() - 0.5);',
      '    channels.forEach((values, c) => {',
      '      for (let i = 0; i < values.length; i++) {',
      '        values[i] = scopeSignal(signals[c] ?? 0, i * 1e-6 - 0.01 + shift) * scale + noise * (random.nextDouble() - 0.5);',
      '      }',
      '    });',
      '    trigger.process(1e-6, channels);',
      '  };',
      '  acquire();',
      '  const timer = setInterval(acquire, Math.max(1, Math.trunc(1000 / rate)));',
      '  return () => {',
      '    clearInterval(timer);',
      '  };',
      '}',
    ),
  );
}

const oscilloscopeType: ChartTypeInfo = {
  id: 'oscilloscope',
  name: 'Oscilloscope',
  category: 'instrument',
  shape: 'scope',
  defaultSample: 'scope',
  ownsAxes: true,
  parameters: [
    { name: 'channels', label: 'Number of channels', kind: 'integer', default: 2, minimum: 1, maximum: 8 },
    {
      name: 'signals',
      label: 'Signal per channel',
      kind: 'text',
      default: 'Sine, Square',
      description: 'Sine, Square, Burst or Triangle, separated by commas; missing ones repeat the list.',
    },
    {
      name: 'volts',
      label: 'Volts per division per channel',
      kind: 'text',
      default: '1, 0.5',
      description: 'Separated by commas; a missing one takes the last.',
    },
    {
      name: 'positions',
      label: 'Position per channel in divisions',
      kind: 'text',
      default: '2, -2',
      description: 'From -4 to 4, separated by commas; without any the channels spread over the screen.',
    },
    { name: 'timePerDivision', label: 'Time per division in s', kind: 'number', default: 5e-4, minimum: 1e-12 },
    { name: 'timeOffset', label: 'Time offset in s', kind: 'number', default: 0 },
    { name: 'trigger', label: 'Trigger level in V', kind: 'number', default: 0.5 },
    {
      name: 'persistence',
      label: 'Persistence',
      kind: 'choice',
      default: 'Off',
      choices: ['Off', 'Variable', 'Infinite', 'ColorGrade'],
    },
    {
      name: 'live',
      label: 'Live acquisitions',
      kind: 'flag',
      default: false,
      description:
        'New acquisitions keep coming, each at a random phase as from a free-running signal; the trigger holds the picture still.',
    },
    { name: 'rate', label: 'Acquisitions per second', kind: 'number', default: 30, minimum: 1, maximum: 200 },
    {
      name: 'noise',
      label: 'Noise in V',
      kind: 'number',
      default: 0,
      minimum: 0,
      description: 'With live acquisitions: noise on the signals, which also lets their amplitude vary.',
    },
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const display = displayOf(data);
    const channels = channelsOf(values);
    const settings = channels.map(
      (c) => `{ signal: ${String(c.signal)}, volts: ${num(c.volts)}, position: ${num(c.position)} }`,
    );
    const result = [
      `const ${display} = new ${writer.use('ScopeDisplay')}();`,
      `${display}.timePerDivision = ${num(numberOf(values, 'timePerDivision', 5e-4))};`,
      `${display}.timeOffset = ${num(numberOf(values, 'timeOffset', 0))};`,
      `${display}.triggerLevel = ${num(numberOf(values, 'trigger', 0.5))};`,
      `${display}.persistence = ${str(camel(textOf(values, 'persistence', 'Off')))};`,
      `for (const { signal, volts, position } of [${settings.join(', ')}]) {`,
      `  const channel = ${display}.addChannel();`,
      '  channel.voltsPerDivision = volts;',
      '  channel.position = position;',
      `  channel.setWaveform(${data}.time, ${data}.waves[signal] ?? []);`,
      '}',
    ];
    if (flagOf(values, 'live')) {
      const start = acquisitionsHelper(writer);
      const list = `[${channels.map((c) => String(c.signal)).join(', ')}]`;
      result.push(
        `${writer.running()}.push(${start}(${display}, ${list}, ${num(numberOf(values, 'noise', 0))}, ${num(numberOf(values, 'rate', 30))}));`,
      );
    }
    result.push(`${writer.use('oscilloscope')}(c, ${display});`);
    return result.join('\n');
  },
};

function spectraHelper(writer: CodeWriter): string {
  const display = writer.useType('SpectrumDisplay');
  return writer.helper(
    'startSpectra',
    lines(
      '// Delivers spectra of three carriers in noise again and again, as a measurement does. Returns what stops it.',
      `function startSpectra(${writer.parameter('display', display)}, ${writer.parameter('count', 'number')}, ${writer.parameter('rate', 'number')})${writer.type('() => void')} {`,
      '  const frequencies = new Float64Array(count);',
      '  const levels = new Float32Array(count);',
      `  const random = new ${writer.use('SeededRandom')}(2);`,
      '  const deliver = () => {',
      '    for (let i = 0; i < count; i++) {',
      '      const frequency = (i * 1e7) / (count - 1);',
      '      frequencies[i] = frequency;',
      '      let level = -70 + 6 * random.nextDouble();',
      '      for (const { center, height } of [{ center: 2e6, height: -12 }, { center: 4.5e6, height: -30 }, { center: 7e6, height: -22 }]) {',
      '        const distance = (frequency - center) / 8e4;',
      '        level = Math.max(level, height - distance * distance * 6 + random.nextDouble());',
      '      }',
      '      levels[i] = level;',
      '    }',
      '    display.setTrace(frequencies, levels);',
      '  };',
      '  deliver();',
      '  const timer = setInterval(deliver, Math.max(1, Math.trunc(1000 / rate)));',
      '  return () => {',
      '    clearInterval(timer);',
      '  };',
      '}',
    ),
  );
}

const spectrumSettings: readonly ParameterInfo[] = [
  { name: 'reference', label: 'Reference level in dBm', kind: 'number', default: 0 },
  { name: 'perDivision', label: 'dB per division', kind: 'number', default: 10, minimum: 0.01 },
  { name: 'maxHold', label: 'Max hold', kind: 'flag', default: false },
  { name: 'density', label: 'Density', kind: 'flag', default: true },
  { name: 'mask', label: 'Limit mask', kind: 'flag', default: true },
  {
    name: 'maskLevel',
    label: 'Mask above 3.2 MHz in dBm',
    kind: 'number',
    default: -25,
    description: 'The limit of the mask beyond the carrier at 2 MHz; below 3 MHz it stays at -5 dBm.',
  },
  { name: 'marker', label: 'Marker in Hz', kind: 'number', default: 2e6, description: 'A negative value for none.' },
  {
    name: 'axes',
    label: 'Axes with numbers',
    kind: 'flag',
    default: false,
    description:
      'The frequency below with its unit and the level in dBm on the left; without, the readings in the corners name them.',
  },
];

/**
 * @internal The settings of a spectrum display and its live spectra, as PrepareSpectrumCode and LiveSpectrumCode of
 * the .NET version; `rate` is the usual number of spectra per second.
 */
export function spectrumSetup(writer: CodeWriter, series: SeriesSpec, data: string, rate: number): string[] {
  const values = series.parameters;
  const level = num(numberOf(values, 'maskLevel', -25));
  const marker = numberOf(values, 'marker', 2e6);
  const result = [
    `${data}.setView(${data}.start, ${data}.stop, ${num(numberOf(values, 'reference', 0))}, ${num(numberOf(values, 'perDivision', 10))});`,
    `${data}.showsMaxHold = ${String(flagOf(values, 'maxHold'))};`,
    `${data}.showsDensity = ${String(flagOf(values, 'density', true))};`,
    flagOf(values, 'mask', true)
      ? `${data}.mask = new ${writer.use('FrequencyMask')}([0, 3e6, 3.2e6, 1e7], [-5, -5, ${level}, ${level}]);`
      : `${data}.mask = undefined;`,
    `${data}.markerFrequency = ${marker >= 0 ? num(marker) : 'undefined'};`,
  ];
  if (flagOf(values, 'axes')) {
    result.push(`${data}.showsAxes = true;`);
  }
  if (flagOf(values, 'live')) {
    const start = spectraHelper(writer);
    const count = Math.max(16, series.data.count);
    result.push(
      `${writer.running()}.push(${start}(${data}, ${String(count)}, ${num(numberOf(values, 'rate', rate))}));`,
    );
  }
  return result;
}

const spectrumType: ChartTypeInfo = {
  id: 'spectrum',
  name: 'Spectrum analyzer',
  category: 'instrument',
  shape: 'spectrum',
  defaultSample: 'noisyCarriers',
  ownsAxes: true,
  parameters: [
    ...spectrumSettings,
    {
      name: 'live',
      label: 'Live spectra',
      kind: 'flag',
      default: false,
      description: 'New spectra keep coming, as from a measurement.',
    },
    { name: 'rate', label: 'Spectra per second', kind: 'number', default: 30, minimum: 1, maximum: 200 },
  ],
  code(writer, series, data) {
    const result = spectrumSetup(writer, series, data, 30);
    result.push(`${writer.use('spectrum')}(c, ${data});`);
    return result.join('\n');
  },
};

interface Limit {
  readonly trace: number;
  readonly kind: 'minimum' | 'maximum';
  readonly from: number;
  readonly to: number;
  readonly level: number;
}

// The limits of the band pass: the pass band, the stop band below it and the reflection in the pass band; the failing
// ones are stricter in the stop band and wider in the reflection.
const limitsOf = (failing: boolean): Limit[] => [
  { trace: 0, kind: 'minimum', from: 1.45e9, to: 1.55e9, level: -1 },
  failing
    ? { trace: 0, kind: 'maximum', from: 1e9, to: 1.25e9, level: -40 }
    : { trace: 0, kind: 'maximum', from: 1e9, to: 1.15e9, level: -20 },
  failing
    ? { trace: 1, kind: 'maximum', from: 1.4e9, to: 1.6e9, level: -20 }
    : { trace: 1, kind: 'maximum', from: 1.47e9, to: 1.53e9, level: -20 },
];

const networkType: ChartTypeInfo = {
  id: 'network',
  name: 'Network analyzer',
  category: 'instrument',
  shape: 'network',
  defaultSample: 'filter',
  ownsAxes: true,
  parameters: [
    { name: 'minimum', label: 'Lowest level in dB', kind: 'number', default: -70 },
    { name: 'maximum', label: 'Highest level in dB', kind: 'number', default: 5 },
    { name: 'limits', label: 'Limit lines', kind: 'flag', default: true },
    {
      name: 'failing',
      label: 'Limits the filter fails',
      kind: 'flag',
      default: false,
      description: 'Stricter limits of the stop band and a wider one of the reflection, which the filter misses.',
    },
    {
      name: 'marker',
      label: 'Marker in Hz',
      kind: 'number',
      default: 1.5e9,
      description: 'A negative value for none.',
    },
    {
      name: 'secondMarker',
      label: 'Second marker in Hz',
      kind: 'number',
      default: -1,
      description: 'A negative value for none.',
    },
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const result: string[] = [];
    if (flagOf(values, 'limits', true)) {
      for (const limit of limitsOf(flagOf(values, 'failing'))) {
        result.push(
          `${data}.traces[${String(limit.trace)}]?.addLimit({ kind: ${str(limit.kind)}, startFrequency: ${num(limit.from)}, startLevel: ${num(limit.level)}, stopFrequency: ${num(limit.to)}, stopLevel: ${num(limit.level)} });`,
        );
      }
    }
    for (const marker of [numberOf(values, 'marker', 1.5e9), numberOf(values, 'secondMarker', -1)]) {
      if (marker >= 0) {
        result.push(`${data}.addMarker(${num(marker)});`);
      }
    }
    result.push(
      `${writer.use('networkAnalyzer')}(c, ${data}, 1e9, 2e9, ${num(numberOf(values, 'minimum', -70))}, ${num(numberOf(values, 'maximum', 5))});`,
      `c.addModifier(() => new ${writer.use('ZoomPanModifier')}());`,
      `c.addModifier(() => new ${writer.use('NetworkMarkerModifier')}(${data}));`,
    );
    return result.join('\n');
  },
};

function samplesHelper(writer: CodeWriter): string {
  const sweepData = writer.useType('SweepData');
  return writer.helper(
    'startSamples',
    lines(
      '// Writes the samples due since the start on a clock, so that the rate holds however the timer runs: two leads of',
      '// a heartbeat, a pulse wave and breathing for four channels, sines for others. Returns what stops it.',
      `function startSamples(${writer.parameter('data', sweepData)}, ${writer.parameter('rate', 'number')})${writer.type('() => void')} {`,
      '  const bell = (x = 0, center = 0, width = 0) => Math.exp(-((x - center) * (x - center)) / (2 * width * width));',
      '  const start = Number.isNaN(data.head) ? 0 : data.head + 1 / rate;',
      '  const begin = performance.now();',
      '  const values = new Float32Array(data.channels);',
      '  let written = 0;',
      '  const tick = () => {',
      '    for (const due = Math.trunc(((performance.now() - begin) / 1000) * rate); written < due; written++) {',
      '      const time = start + written / rate;',
      '      if (values.length === 4) {',
      '        const beat = ((time * 72) / 60) % 1;',
      '        const ecg = 0.12 * bell(beat, 0.18, 0.025) - 0.15 * bell(beat, 0.36, 0.008) + bell(beat, 0.39, 0.01) - 0.25 * bell(beat, 0.42, 0.01) + 0.3 * bell(beat, 0.62, 0.045);',
      '        const pulse = (beat + 0.85) % 1;',
      '        values[0] = ecg;',
      '        values[1] = ecg * 0.8 + 0.05 * Math.sin(time * 2 * Math.PI * 0.3);',
      '        values[2] = 0.9 * bell(pulse, 0.25, 0.07) + 0.3 * bell(pulse, 0.5, 0.06);',
      '        values[3] = Math.sin(time * 2 * Math.PI * 0.25);',
      '      } else {',
      '        for (let channel = 0; channel < values.length; channel++) {',
      '          values[channel] = Math.sin(2 * Math.PI * (channel + 1) * time);',
      '        }',
      '      }',
      '      data.append(time, values);',
      '    }',
      '  };',
      '  const timer = setInterval(tick, 10);',
      '  return () => {',
      '    clearInterval(timer);',
      '  };',
      '}',
    ),
  );
}

function rangesOf(text: string, count: number): [number, number][] {
  const parts = names(text);
  return Array.from({ length: count }, (_, c) => {
    const ends = (parts[c] ?? '').split('..').map((part) => part.trim());
    const from = Number(ends[0]);
    const to = Number(ends[1]);
    return ends.length === 2 && ends[0] !== '' && Number.isFinite(from) && Number.isFinite(to) && from < to
      ? [from, to]
      : [-1.5, 1.5];
  });
}

const monitorType: ChartTypeInfo = {
  id: 'monitor',
  name: 'Sweep monitor',
  category: 'instrument',
  shape: 'sweep',
  defaultSample: 'patient',
  ownsAxes: true,
  parameters: [
    { name: 'mode', label: 'Mode', kind: 'choice', default: 'Sweep', choices: ['Sweep', 'Stepping'] },
    { name: 'gap', label: 'Gap as share of the width', kind: 'number', default: 0.04, minimum: 0, maximum: 0.5 },
    {
      name: 'names',
      label: 'Names of the channels',
      kind: 'text',
      default: 'ECG, Pleth, Resp',
      description: 'One per channel, separated by commas.',
    },
    {
      name: 'ranges',
      label: 'Range per channel',
      kind: 'text',
      default: '',
      description: 'From..to per channel, separated by commas, such as -0.6..1.4; a missing one is -1.5..1.5.',
    },
    {
      name: 'live',
      label: 'Live samples',
      kind: 'flag',
      default: false,
      description: 'New samples keep coming after the newest one.',
    },
    { name: 'rate', label: 'Samples per second', kind: 'number', default: 1000, minimum: 1, maximum: 100_000 },
  ],
  code(writer, series, data) {
    const values = series.parameters;
    const given = rangesOf(textOf(values, 'ranges'), names(textOf(values, 'ranges')).length);
    const range = writer.use('DoubleRange');
    const listed = given.map(([from, to]) => `new ${range}(${num(from)}, ${num(to)})`);
    const result = [
      `${data}.mode = ${str(camel(textOf(values, 'mode', 'Sweep')))};`,
      `${data}.gapShare = ${num(numberOf(values, 'gap', 0.04))};`,
    ];
    if (flagOf(values, 'live')) {
      result.push(
        `${writer.running()}.push(${samplesHelper(writer)}(${data}, ${num(numberOf(values, 'rate', 1000))}));`,
      );
    }
    // Each channel takes the range the list gives it, the others -1.5 to 1.5.
    const ranges = `Array.from({ length: ${data}.channels }, (_, i) => [${listed.join(', ')}][i] ?? new ${range}(-1.5, 1.5))`;
    result.push(
      `${writer.use('sweep')}(c, ${data}, ${ranges}, [${names(textOf(values, 'names', 'ECG, Pleth, Resp'))
        .map(str)
        .join(', ')}]);`,
    );
    return result.join('\n');
  },
};

const digitalType: ChartTypeInfo = {
  id: 'digital',
  name: 'Digital channels',
  category: 'twoD',
  shape: 'digital',
  defaultSample: 'logicBus',
  parameters: [
    {
      name: 'channel',
      label: 'Channel',
      kind: 'integer',
      default: 0,
      minimum: 0,
      maximum: 15,
      description: 'The channel of the sample: CLK, CS, WR, D0 to D7, IRQ, ERR, PWR, LED, SYNC.',
    },
    {
      name: 'low',
      label: 'Low at',
      kind: 'number',
      default: 0,
      description: 'The value of the Y axis for the low level.',
    },
    {
      name: 'high',
      label: 'High at',
      kind: 'number',
      default: 1,
      description: 'The value of the Y axis for the high level.',
    },
    { name: 'thickness', label: 'Thickness', kind: 'number', default: 1, minimum: 0.5, maximum: 10 },
    { name: 'color', label: 'Color', kind: 'color', default: '', description: 'Empty for the usual green.' },
  ],
  code(writer, series, data, axes) {
    const values = series.parameters;
    const channel = Math.min(Math.max(Math.trunc(numberOf(values, 'channel', 0)), 0), 15);
    const source = writer.as(`${data}[${String(channel)}]`, writer.useType('DigitalTransitions'));
    const assignments = [
      ...(series.name.length > 0 ? [`name = ${str(series.name)}`] : []),
      `low = ${num(numberOf(values, 'low', 0))}`,
      `high = ${num(numberOf(values, 'high', 1))}`,
      `thickness = ${num(numberOf(values, 'thickness', 1))}`,
    ];
    const chosen = colorCode(values, 'color');
    if (chosen) {
      assignments.push(`color = ${chosen}`);
    }
    return lines(
      'c.addSeries(',
      '  (x, y) => {',
      `    const series = new ${writer.use('DigitalSeries')}(${source}, x, y);`,
      indent(assignments.map((line) => `series.${line};`).join('\n'), '    '),
      '    return series;',
      '  },',
      `  ${str(axes.x)},`,
      `  ${str(axes.y)},`,
      ');',
    );
  },
};

export { spectrumSettings };

/** The instruments and the digital channels. */
export const instrumentTypes: readonly ChartTypeInfo[] = [
  oscilloscopeType,
  spectrumType,
  networkType,
  monitorType,
  digitalType,
];
