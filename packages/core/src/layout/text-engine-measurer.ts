// Measures labels with the text engine of the chart (TextEngineMeasurer of the .NET version).
import type { TextMeasurer } from '../axes/axis';
import type { TextEngine, TextFont } from '../text/engine';

/** Measures labels with a text engine at one size and font. */
export class TextEngineMeasurer implements TextMeasurer {
  private textSize = 0;
  /** The font; the default font of the engine when left out. */
  font: TextFont | undefined;

  constructor(
    private readonly engine: TextEngine,
    size: number,
  ) {
    this.size = size;
  }

  /** The size of the text in device-independent units. */
  get size(): number {
    return this.textSize;
  }

  set size(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`The text size must be positive and finite, not ${String(value)}.`);
    }
    this.textSize = value;
  }

  /** {@inheritDoc TextMeasurer.lineHeight} */
  get lineHeight(): number {
    return this.engine.lineHeight(this.textSize, this.font);
  }

  /** {@inheritDoc TextMeasurer.measureWidth} */
  measureWidth(text: string): number {
    return this.engine.measureWidth(text, this.textSize, this.font);
  }
}
