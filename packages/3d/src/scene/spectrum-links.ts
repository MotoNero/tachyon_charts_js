// What a spectrum display holds in its waterfall, as SpectrumLinks of the .NET version: the mask as a red fence across
// the depth, and the markers as orange frames across the box, numbered at the level of the newest trace.
import { scopeVerticalDivisions, DoubleRange, type Rgba8, type SpectrumDisplay } from '@tachyon-charts/core';
import { Point3D } from './matrix';
import type { BoxMap } from './points';
import type { Waterfall3D } from './waterfall';

/** @internal The color of the mask, as in the spectrum. */
export const maskColor: Rgba8 = { r: 240, g: 80, b: 70, a: 255 };
/** @internal The color of the markers, as in the spectrum. */
export const markerColor: Rgba8 = { r: 255, g: 160, b: 50, a: 255 };

/** @internal The levels that the spectrum shows, from the bottom to the reference. */
export function spectrumLevels(display: SpectrumDisplay): DoubleRange {
  return new DoubleRange(display.referenceLevel - display.perDivision * scopeVerticalDivisions, display.referenceLevel);
}

/** @internal The frequencies of all markers of a display, the first one first. */
export function markerFrequencies(display: SpectrumDisplay): number[] {
  return [display.markerPoint.frequency, ...display.extraMarkers];
}

/** @internal The top of the post of a marker, where its number goes. */
export function markerTop(waterfall: Waterfall3D, display: SpectrumDisplay, frequency: number): Point3D {
  const level = display.readPoint(frequency).level;
  return new Point3D(frequency, waterfall.y.min, Number.isFinite(level) ? level : display.referenceLevel);
}

/** @internal Adds the lines of the mask and the markers of a waterfall of a spectrum, as pairs of ends with colors. */
export function addSpectrumLines(
  waterfall: Waterfall3D,
  display: SpectrumDisplay,
  map: BoxMap,
  floor: number,
  top: number,
  add: (x: number, y: number, z: number, color: Rgba8) => void,
): void {
  const front = waterfall.y.min;
  const back = waterfall.y.max;
  const line = (a: Point3D, b: Point3D, color: Rgba8): void => {
    const from = map.toBox(a);
    const to = map.toBox(b);
    if (Number.isFinite(from.x + from.z + to.x + to.z)) {
      add(Math.fround(from.x), Math.fround(from.y), Math.fround(Math.min(Math.max(from.z, -1), 1)), color);
      add(Math.fround(to.x), Math.fround(to.y), Math.fround(Math.min(Math.max(to.z, -1), 1)), color);
    }
  };
  const mask = display.mask;
  if (mask) {
    const frequencies = mask.frequencies;
    const levels = mask.levels;
    for (let i = 0; i < frequencies.length; i++) {
      const frequency = frequencies[i] as number;
      const level = levels[i] as number;
      if (i > 0) {
        const before = frequencies[i - 1] as number;
        const below = levels[i - 1] as number;
        line(new Point3D(before, front, below), new Point3D(frequency, front, level), maskColor);
        line(new Point3D(before, back, below), new Point3D(frequency, back, level), maskColor);
      }
      line(new Point3D(frequency, front, level), new Point3D(frequency, back, level), maskColor);
    }
  }
  // Each marker is a frame across the box, so that the surface never hides it.
  for (const frequency of markerFrequencies(display)) {
    line(new Point3D(frequency, front, floor), new Point3D(frequency, back, floor), markerColor);
    line(new Point3D(frequency, back, floor), new Point3D(frequency, back, top), markerColor);
    line(new Point3D(frequency, back, top), new Point3D(frequency, front, top), markerColor);
    line(new Point3D(frequency, front, top), new Point3D(frequency, front, floor), markerColor);
  }
}
