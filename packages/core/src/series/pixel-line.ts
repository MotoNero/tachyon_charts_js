// A line in pixels for series that reduce their data themselves, such as a line over a file larger than memory: the
// extremes of each pixel column, or points, go into vertices, and from there to the GPU as LineSeries draws them.
import type { SeriesFrame } from '../pipeline/chart-series';
import type { CommandList, PolylineStyle } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { Rgba8 } from '../render/types';
import { VertexBuffer, Vertices } from './vertices';

const f = Math.fround;

/**
 * Adds the extremes of each pixel column as a vertical stroke, joined to the next column at the nearer end. A column
 * whose minimum is above its maximum, or whose top is not finite, interrupts the line.
 */
export function addMinMaxColumns(line: Vertices, minima: Float64Array, maxima: Float64Array, frame: SeriesFrame): void {
  let isOpen = false;
  let last = 0;
  for (let column = 0; column < minima.length; column++) {
    const minimum = minima[column] as number;
    const maximum = maxima[column] as number;
    if (minimum > maximum) {
      line.addGap();
      isOpen = false;
      continue;
    }
    const x = f(f(frame.bounds.x + column) + 0.5);
    const top = frame.y.toPixel(maximum);
    const bottom = frame.y.toPixel(minimum);
    if (!Number.isFinite(top)) {
      line.addGap();
      isOpen = false;
      continue;
    }
    const high = f(top);
    const low = f(Number.isFinite(bottom) ? bottom : frame.bounds.y + frame.bounds.height);
    // The end nearer to the last column first; two variables, since an array here would cost one per column.
    const highFirst = isOpen && Math.abs(f(last - high)) < Math.abs(f(last - low));
    const first = highFirst ? high : low;
    const second = highFirst ? low : high;
    if (first === second) {
      line.add(x, first);
    } else {
      line.add(f(x - 0.5), first);
      line.add(f(x + 0.5), second);
    }
    last = second;
    isOpen = true;
  }
}

/**
 * A line a series builds in pixels each time its data or view changes: from the extremes of pixel columns
 * ({@link PixelLine.columns}, {@link PixelLine.addColumns}) or from points ({@link PixelLine.addPoint}). It uploads the
 * vertices once per change and draws them with the style of a LineSeries.
 */
export class PixelLine {
  private readonly vertices = new Vertices();
  private readonly gpu = new VertexBuffer();
  private minima = new Float64Array(0);
  private maxima = new Float64Array(0);
  private style: PolylineStyle | undefined;
  private uploadPending = false;

  /** The number of vertices, gaps included. */
  get count(): number {
    return this.vertices.count;
  }

  /** Starts a new line. */
  clear(): void {
    this.vertices.clear();
    this.uploadPending = true;
  }

  /**
   * The arrays of extremes for `width` pixel columns, to fill before {@link PixelLine.addColumns}; reused while the
   * width stays.
   */
  columns(width: number): { readonly minima: Float64Array; readonly maxima: Float64Array } {
    const count = Math.max(Math.ceil(width), 1);
    if (this.minima.length !== count) {
      this.minima = new Float64Array(count);
      this.maxima = new Float64Array(count);
    }
    return { minima: this.minima, maxima: this.maxima };
  }

  /** Adds the extremes of the columns: each a vertical stroke, joined to the next at the nearer end. */
  addColumns(frame: SeriesFrame): void {
    addMinMaxColumns(this.vertices, this.minima, this.maxima, frame);
  }

  /** Adds a point in pixels; a value that is not finite interrupts the line. */
  addPoint(x: number, y: number): void {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.vertices.add(f(x), f(y));
    } else {
      this.vertices.addGap();
    }
  }

  /** Ends the line; call after the last point or column. */
  end(): void {
    this.vertices.endRun();
  }

  /** Uploads the line after a change and takes the style for the next draw. */
  prepare(device: RenderDevice, frame: SeriesFrame, color: Rgba8, thickness: number): void {
    if (this.uploadPending && this.vertices.count > 0) {
      this.gpu
        .ensure(device, this.vertices.count * 8)
        .write(0, this.vertices.data.subarray(0, this.vertices.count * 2));
    }
    this.uploadPending = false;
    this.style = {
      widthInPixels: f(thickness * frame.dpiScale),
      color,
      clip: frame.bounds,
      ...(frame.glowRadius > 0 ? { glowRadius: f(frame.glowRadius), glowIntensity: f(frame.glowIntensity) } : {}),
    };
  }

  /** Draws the line. */
  draw(commands: CommandList): void {
    const buffer = this.gpu.buffer;
    if (this.vertices.count >= 2 && buffer && this.style) {
      commands.drawPolyline(buffer, 0, this.vertices.count, this.style);
    }
  }

  /** Frees the GPU buffer; the next prepare after a clear creates it again. */
  dispose(): void {
    this.gpu.dispose();
    this.uploadPending = true;
  }
}
