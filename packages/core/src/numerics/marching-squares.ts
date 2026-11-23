// Isolines of a grid of samples, as MarchingSquares of the .NET version, the reference of its contour shader: one
// unit is the distance of two samples, the points are floats as there.

const f = Math.fround;

/**
 * Finds the pieces of the isolines of all levels in a grid, `width` samples per row, row 0 at the bottom.
 * @param segments - Receives four floats per piece: x and y of its start, x and y of its end.
 * @throws RangeError when the number of values does not match the grid.
 */
export function marchingSquares(
  values: Float32Array,
  width: number,
  height: number,
  levels: Float32Array,
  segments: number[],
): void {
  if (values.length !== width * height) {
    throw new RangeError(`A grid of ${String(width)} × ${String(height)} takes ${String(width * height)} values.`);
  }
  for (let y = 0; y + 1 < height; y++) {
    for (let x = 0; x + 1 < width; x++) {
      // The corners run around the cell: A at the origin, B to the right, C opposite, D above A.
      const a = values[y * width + x] as number;
      const b = values[y * width + x + 1] as number;
      const c = values[(y + 1) * width + x + 1] as number;
      const d = values[(y + 1) * width + x] as number;
      if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) {
        continue;
      }
      for (const level of levels) {
        march(x, y, a, b, c, d, level, segments);
      }
    }
  }
}

// The two edges of each case; 5 and 10 have two opposite corners, which the middle connects.
const edgesOf: readonly (readonly [number, number] | undefined)[] = [
  undefined,
  [3, 0],
  [0, 1],
  [3, 1],
  [1, 2],
  undefined,
  [0, 2],
  [3, 2],
  [3, 2],
  [0, 2],
  undefined,
  [1, 2],
  [3, 1],
  [0, 1],
  [3, 0],
  undefined,
];

function march(
  x: number,
  y: number,
  a: number,
  b: number,
  c: number,
  d: number,
  level: number,
  segments: number[],
): void {
  const mask = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
  const cell = { x, y, a, b, c, d };
  const edges = edgesOf[mask];
  if (edges) {
    add(cell, edges[0], edges[1], level, segments);
  } else if (mask === 5 || mask === 10) {
    const centerIsHigh = f(f(f(f(a + b) + c) + d) / 4) >= level;
    if ((mask === 5) === centerIsHigh) {
      add(cell, 0, 1, level, segments);
      add(cell, 2, 3, level, segments);
    } else {
      add(cell, 3, 0, level, segments);
      add(cell, 1, 2, level, segments);
    }
  }
}

interface Cell {
  readonly x: number;
  readonly y: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

function add(cell: Cell, first: number, second: number, level: number, segments: number[]): void {
  edgePoint(cell, first, level, segments);
  edgePoint(cell, second, level, segments);
}

function edgePoint(cell: Cell, edge: number, level: number, segments: number[]): void {
  const { x, y, a, b, c, d } = cell;
  switch (edge) {
    case 0:
      segments.push(f(x + f(f(level - a) / f(b - a))), y);
      break;
    case 1:
      segments.push(x + 1, f(y + f(f(level - b) / f(c - b))));
      break;
    case 2:
      segments.push(f(x + f(f(level - d) / f(c - d))), y + 1);
      break;
    default:
      segments.push(x, f(y + f(f(level - a) / f(d - a))));
  }
}
