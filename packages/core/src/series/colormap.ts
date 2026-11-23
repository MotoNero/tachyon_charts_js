// The tables of colors of rasters and color axes, as Colormap of the .NET version: the built-in maps of
// shared/colormaps.json and the nearest color of a position.
import { builtInColormapEntries } from '../generated/colormaps';
import { parseColor, type Rgba8 } from '../render/types';

/** A table of colors from low to high values. */
export class Colormap {
  /**
   * @param name - The name.
   * @param entries - The colors from the lowest value to the highest, at least two.
   */
  constructor(
    /** The name. */
    readonly name: string,
    /** The colors from the lowest value to the highest. */
    readonly entries: readonly Rgba8[],
  ) {
    if (entries.length < 2) {
      throw new RangeError('A colormap needs at least two colors.');
    }
  }

  /** The names of the built-in colormaps, those of the .NET version: Viridis, Inferno, Magma, Plasma, Turbo, Grayscale. */
  static get builtInNames(): readonly string[] {
    return Object.keys(builtInColormapEntries);
  }

  /**
   * A built-in colormap by its name, in any case.
   * @throws RangeError for an unknown name.
   */
  static builtIn(name: string): Colormap {
    const key = Object.keys(builtInColormapEntries).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const text = key === undefined ? undefined : builtInColormapEntries[key];
    if (key === undefined || text === undefined) {
      throw new RangeError(`There is no colormap "${name}".`);
    }
    const entries: Rgba8[] = [];
    for (let at = 0; at < text.length; at += 9) {
      entries.push(parseColor(text.slice(at, at + 9)));
    }
    return new Colormap(key, entries);
  }

  /** The color at a position from 0 to 1, the nearest of the table; NaN gives the first color. */
  sample(position: number): Rgba8 {
    const last = this.entries.length - 1;
    const index = Number.isNaN(position) ? 0 : Math.floor(Math.min(Math.max(position, 0), 1) * last + 0.5);
    return this.entries[index] as Rgba8;
  }

  /** The colors as bytes, red, green, blue and alpha, for a texture one row high. */
  toBytes(): Uint8Array {
    const bytes = new Uint8Array(this.entries.length * 4);
    this.entries.forEach((color, i) => {
      bytes.set([color.r, color.g, color.b, color.a], i * 4);
    });
    return bytes;
  }
}
