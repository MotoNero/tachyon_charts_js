// A growing list of points in pixels, x and y as float32 pairs, as the line shader takes them.
import { lineGap } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { GpuBuffer } from '../render/resources';
import { BufferUsage } from '../render/types';

const f = Math.fround;

/** Points in pixels with gaps between runs; the array grows and is kept between frames. */
export class Vertices {
  data = new Float32Array(512);
  count = 0;
  private runLength = 0;

  clear(): void {
    this.count = 0;
    this.runLength = 0;
  }

  x(index: number): number {
    return this.data[index * 2] as number;
  }

  y(index: number): number {
    return this.data[index * 2 + 1] as number;
  }

  add(x: number, y: number): void {
    if (this.count * 2 === this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.count * 2] = x;
    this.data[this.count * 2 + 1] = y;
    this.count++;
    this.runLength++;
  }

  /** Interrupts the line, once after a run. */
  addGap(): void {
    if (this.runLength > 0) {
      this.endRun();
      this.add(lineGap, 0);
      this.runLength = 0;
    }
  }

  /** A point between two gaps has no segment; a segment of no length shows it as a dot. */
  endRun(): void {
    if (this.runLength === 1) {
      this.add(this.x(this.count - 1), this.y(this.count - 1));
    }
  }

  /** Whether the point at an index is a gap. */
  isGap(index: number): boolean {
    return this.x(index) >= lineGap;
  }
}

/** Replaces the straight runs between gaps by monotone curves that stay between neighboring values. */
export function smoothRuns(line: Vertices, target: Vertices): void {
  target.clear();
  let start = 0;
  for (let i = 0; i <= line.count; i++) {
    if (i === line.count || line.isGap(i)) {
      addSpline(line, start, i, target);
      if (i < line.count) {
        target.add(line.x(i), line.y(i));
      }
      start = i + 1;
    }
  }
}

const steps = 8;

function secant(line: Vertices, index: number): number {
  const width = f(line.x(index + 1) - line.x(index));
  return width > 0 ? f(f(line.y(index + 1) - line.y(index)) / width) : 0;
}

function slope(line: Vertices, start: number, end: number, index: number): number {
  if (index === start) {
    return secant(line, start);
  }
  if (index === end - 1) {
    return secant(line, index - 1);
  }
  const before = secant(line, index - 1);
  const after = secant(line, index);
  return f(before * after) <= 0 ? 0 : f(f(f(2 * before) * after) / f(before + after));
}

function addSpline(line: Vertices, start: number, end: number, curve: Vertices): void {
  if (end - start < 3) {
    for (let i = start; i < end; i++) {
      curve.add(line.x(i), line.y(i));
    }
    return;
  }
  curve.add(line.x(start), line.y(start));
  for (let i = start; i < end - 1; i++) {
    const [startX, startY, endY] = [line.x(i), line.y(i), line.y(i + 1)];
    const width = f(line.x(i + 1) - startX);
    const startSlope = slope(line, start, end, i);
    const endSlope = slope(line, start, end, i + 1);
    for (let step = 1; step <= steps; step++) {
      const t = f(step / steps);
      const square = f(t * t);
      const cube = f(square * t);
      const a = f(f(f(f(2 * cube) - f(3 * square)) + 1) * startY);
      const b = f(f(f(f(cube - f(2 * square)) + t) * width) * startSlope);
      const c = f(f(f(-2 * cube) + f(3 * square)) * endY);
      const d = f(f(f(cube - square) * width) * endSlope);
      curve.add(f(startX + f(t * width)), f(f(f(a + b) + c) + d));
    }
  }
}

/** Keeps a vertex buffer on the GPU that grows when needed. */
export class VertexBuffer {
  buffer: GpuBuffer | undefined;

  ensure(device: RenderDevice, byteCount: number): GpuBuffer {
    if (!this.buffer || this.buffer.sizeInBytes < byteCount) {
      this.buffer?.dispose();
      this.buffer = device.createBuffer({ sizeInBytes: Math.max(byteCount, 4096), usage: BufferUsage.vertex });
    }
    return this.buffer;
  }

  dispose(): void {
    this.buffer?.dispose();
    this.buffer = undefined;
  }
}
