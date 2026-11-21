// The texts of the showroom, as SampleText of the .NET samples: English is the key, each further language a table.
import { chartText } from '@tachyon-charts/core';

const german: Readonly<Record<string, string>> = {
  Lines: 'Linien',
  Line: 'Linie',
  Spline: 'Spline',
  'Step line': 'Stufenlinie',
  'A million points': 'Eine Million Punkte',
  'Data from a worker': 'Daten aus einem Worker',
  'Many charts': 'Viele Diagramme',
  'Line from a large file': 'Linie aus einer großen Datei',
  'The first visit writes a test file of 1 GB': 'Der erste Besuch schreibt eine Testdatei von 1 GB',
  '250 million values, five spikes among them': '250 Millionen Werte, fünf Ausreißer darunter',
  Pyramid: 'Pyramide',
  'kept from before': 'von früher aufbewahrt',
  Refining: 'Wird verfeinert',
  'Time in s': 'Zeit in s',
  'Every chart streams 100 000 points per second | Wheel: zoom | Drag: pan | Double click: all':
    'Jedes Diagramm streamt 100 000 Punkte je Sekunde | Rad: Zoom | Ziehen: Pan | Doppelklick: alles',
  'Shared memory': 'Geteilter Speicher',
  'Transferred blocks': 'Übertragene Blöcke',
  'Points and areas': 'Punkte und Flächen',
  Scatter: 'Punktwolke',
  Area: 'Fläche',
  'Stacked area': 'Gestapelte Fläche',
  Band: 'Band',
  Bars: 'Balken',
  'Stacked bars': 'Gestapelte Balken',
  'Horizontal bars': 'Waagerechte Balken',
  Axes: 'Achsen',
  'Logarithmic axis': 'Log-Achse',
  Categories: 'Kategorien',
  'Time axis': 'Zeitachse',
  'Axes in the origin': 'Achsen im Ursprung',
  Look: 'Aussehen',
  Themes: 'Themes',
  Theme: 'Theme',
  Language: 'Sprache',
  'Of the page': 'Der Seite',
  'Light or dark, as the system': 'Hell oder dunkel wie das System',
  'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all':
    'Rad: Zoom | Ziehen: Pan | Strg+Ziehen: in Rechteck zoomen | Doppelklick: alles',
  'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all | Pointer: values':
    'Rad: Zoom | Ziehen: Pan | Strg+Ziehen: in Rechteck zoomen | Doppelklick: alles | Zeiger: Werte',
  'Wheel: zoom | Drag: pan | Ctrl+drag: zoom into a rectangle | Double click: all | Pointer: values | Zoom in: days, hours, minutes':
    'Rad: Zoom | Ziehen: Pan | Strg+Ziehen: in Rechteck zoomen | Doppelklick: alles | Zeiger: Werte | Hineinzoomen: Tage, Stunden, Minuten',
  'Wheel: zoom | Drag: pan, the axes stay at zero or at the nearest edge | Double click: all':
    'Rad: Zoom | Ziehen: Pan, die Achsen bleiben bei null oder am nächsten Rand | Doppelklick: alles',
  'Choose a theme at the top | Pointer: values': 'Oben ein Theme wählen | Zeiger: Werte',
  'Drawn in the render worker': 'Gezeichnet im Render-Worker',
  'Drawn on the main thread': 'Gezeichnet im Hauptthread',
  Sine: 'Sinus',
  'Noisy wave': 'Verrauschte Welle',
  Temperature: 'Temperatur',
  'Temperature in Berlin, over the change to summer time': 'Temperatur in Berlin, über die Umstellung auf Sommerzeit',
  'Theme preview': 'Theme-Vorschau',
  Time: 'Zeit',
  Signal: 'Signal',
  Markers: 'Marker',
  Jan: 'Jan',
  Feb: 'Feb',
  Mar: 'Mär',
  Apr: 'Apr',
  May: 'Mai',
  Jun: 'Jun',
  Jul: 'Jul',
  Aug: 'Aug',
  Sep: 'Sep',
  Oct: 'Okt',
  Nov: 'Nov',
  Dec: 'Dez',
};

/** The text in the language of the charts; English, the key, where a translation is missing. */
export function t(english: string): string {
  return chartText.language === 'german' ? (german[english] ?? english) : english;
}
