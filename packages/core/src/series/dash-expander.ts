// Cuts a line in pixels into its dashes, separated by gaps (DashExpander of the .NET version). Done on the CPU, so
// that all backends draw the same dashes with their plain line pipeline.
import { lineGap } from '../render/commands';
import type { PixelRect } from '../render/types';
import type { Vertices } from './vertices';

const f = Math.fround;
const margin = 16;

interface Walker {
  index: number;
  remaining: number;
  isDash: boolean;
  isOpen: boolean;
}

/** Writes the dashes of `line` into `output`; the pattern is in device-independent units. */
export function expandDashes(
  line: Vertices,
  pattern: readonly number[],
  scale: number,
  bounds: PixelRect,
  output: Vertices,
): void {
  output.clear();
  const first = f(f(pattern[0] as number) * scale);
  const state: Walker = { index: 0, remaining: first, isDash: true, isOpen: false };
  const segment = new Float32Array(4);
  for (let i = 1; i < line.count; i++) {
    if (line.isGap(i - 1) || line.isGap(i)) {
      closeDash(output, state);
      state.index = 0;
      state.remaining = first;
      state.isDash = true;
      continue;
    }
    segment[0] = line.x(i - 1);
    segment[1] = line.y(i - 1);
    segment[2] = line.x(i);
    segment[3] = line.y(i);
    if (!clip(segment, bounds)) {
      closeDash(output, state);
      continue;
    }
    walk(segment, pattern, scale, output, state);
  }
}

function walk(segment: Float32Array, pattern: readonly number[], scale: number, output: Vertices, state: Walker): void {
  const [fromX, fromY, toX, toY] = segment as unknown as [number, number, number, number];
  const dx = f(toX - fromX);
  const dy = f(toY - fromY);
  const length = f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
  let position = 0;
  while (f(length - position) > 0) {
    const step = Math.min(state.remaining, f(length - position));
    if (state.isDash) {
      if (!state.isOpen) {
        const t = f(position / length);
        output.add(lerp(fromX, toX, t), lerp(fromY, toY, t));
        state.isOpen = true;
      }
      const t = f(f(position + step) / length);
      output.add(lerp(fromX, toX, t), lerp(fromY, toY, t));
    }
    position = f(position + step);
    state.remaining = f(state.remaining - step);
    if (state.remaining <= 0) {
      state.index = (state.index + 1) % pattern.length;
      state.remaining = f(f(pattern[state.index] as number) * scale);
      if (state.isDash) {
        closeDash(output, state);
      }
      state.isDash = !state.isDash;
    }
  }
}

function lerp(from: number, to: number, t: number): number {
  return f(from + f(f(to - from) * t));
}

function closeDash(output: Vertices, state: Walker): void {
  if (state.isOpen) {
    output.add(lineGap, 0);
    state.isOpen = false;
  }
}

// Liang-Barsky against the bounds with a margin for caps.
function clip(segment: Float32Array, bounds: PixelRect): boolean {
  const [fromX, fromY, toX, toY] = segment as unknown as [number, number, number, number];
  const dx = f(toX - fromX);
  const dy = f(toY - fromY);
  const range = { enter: 0, leave: 1 };
  const inside =
    edge(-dx, f(fromX - f(bounds.x - margin)), range) &&
    edge(dx, f(f(f(bounds.x + bounds.width) + margin) - fromX), range) &&
    edge(-dy, f(fromY - f(bounds.y - margin)), range) &&
    edge(dy, f(f(f(bounds.y + bounds.height) + margin) - fromY), range);
  if (inside) {
    segment[0] = fromX + f(dx * range.enter);
    segment[1] = fromY + f(dy * range.enter);
    segment[2] = fromX + f(dx * range.leave);
    segment[3] = fromY + f(dy * range.leave);
  }
  return inside;
}

function edge(direction: number, distance: number, range: { enter: number; leave: number }): boolean {
  if (direction === 0) {
    return distance >= 0;
  }
  const position = f(distance / direction);
  if (direction < 0) {
    range.enter = Math.max(range.enter, position);
  } else {
    range.leave = Math.min(range.leave, position);
  }
  return range.enter <= range.leave;
}
