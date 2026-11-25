// The box from -1 to 1 the scene lies in: the walls behind it seen from the eye, their grid and frame, and the edges
// for the labels, as AxisBox3D of the .NET version.
import type { Axis, AxisTick, TextMeasurer } from '@tachyon-charts/core';
import type { Matrix3D } from './matrix';
import { Point3D } from './matrix';

/** The three axes of a scene. */
export interface SceneAxes {
  /** The axis from left to right. */
  readonly xAxis: Axis;
  /** The axis from front to back. */
  readonly yAxis: Axis;
  /** The upward axis. */
  readonly zAxis: Axis;
}

/** @internal The side of the box each wall lies on: -1 or 1 for X, Y and Z. */
export interface BoxWalls {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** @internal An edge of the box the labels of an axis follow, with the direction away from the box. */
export interface LabelEdge {
  readonly start: Point3D;
  readonly end: Point3D;
  readonly outward: Point3D;
}

/** @internal The length the ticks of an axis of the box are made for, in units of the fixed measure. */
export const tickLength = 260;
const characterWidth = 7;
const textHeight = 14;

// The same width for every character, so that the box has the same ticks whatever the font.
const fixedMeasurer: TextMeasurer = {
  lineHeight: textHeight,
  measureWidth: (text: string) => text.length * characterWidth,
};

/** @internal The walls behind the box, seen from the eye. */
export function selectWalls(eye: Point3D): BoxWalls {
  return { x: eye.x >= 0 ? -1 : 1, y: eye.y >= 0 ? -1 : 1, z: eye.z >= 0 ? -1 : 1 };
}

/** @internal The labeled ticks of an axis of the box. */
export function boxTicks(axis: Axis): readonly AxisTick[] {
  return axis.generateTicks(tickLength, fixedMeasurer).major;
}

/** @internal A value of an axis as a place in the box, from -1 to 1. */
export function toBox(axis: Axis, value: number): number {
  const place = axis.createTransform(-1, 2).toPixel(value);
  return axis.isHorizontal ? place : -place;
}

/** @internal The places of the ticks of an axis in the box. */
export function tickPlaces(axis: Axis): number[] {
  return boxTicks(axis).map((tick) => toBox(axis, tick.value));
}

function addLine(lines: number[], from: Point3D, to: Point3D): void {
  lines.push(Math.fround(from.x), Math.fround(from.y), Math.fround(from.z));
  lines.push(Math.fround(to.x), Math.fround(to.y), Math.fround(to.z));
}

function addRectangle(lines: number[], corner: Point3D, side: Point3D, other: Point3D): void {
  addLine(lines, corner, corner.plus(side));
  addLine(lines, corner.plus(side), corner.plus(side).plus(other));
  addLine(lines, corner.plus(side).plus(other), corner.plus(other));
  addLine(lines, corner.plus(other), corner);
}

/** @internal Adds the grid of the three walls and their frames, as pairs of points of X, Y and Z. */
export function addBoxLines(
  grid: number[],
  frame: number[],
  walls: BoxWalls,
  x: readonly number[],
  y: readonly number[],
  z: readonly number[],
): void {
  for (const value of x) {
    addLine(grid, new Point3D(value, -1, walls.z), new Point3D(value, 1, walls.z));
    addLine(grid, new Point3D(value, walls.y, -1), new Point3D(value, walls.y, 1));
  }
  for (const value of y) {
    addLine(grid, new Point3D(-1, value, walls.z), new Point3D(1, value, walls.z));
    addLine(grid, new Point3D(walls.x, value, -1), new Point3D(walls.x, value, 1));
  }
  for (const value of z) {
    addLine(grid, new Point3D(walls.x, -1, value), new Point3D(walls.x, 1, value));
    addLine(grid, new Point3D(-1, walls.y, value), new Point3D(1, walls.y, value));
  }
  addRectangle(frame, new Point3D(-1, -1, walls.z), new Point3D(2, 0, 0), new Point3D(0, 2, 0));
  addRectangle(frame, new Point3D(walls.x, -1, -1), new Point3D(0, 2, 0), new Point3D(0, 0, 2));
  addRectangle(frame, new Point3D(-1, walls.y, -1), new Point3D(2, 0, 0), new Point3D(0, 0, 2));
}

/** @internal The edge of the X labels: on the floor, on the side away from the Y wall. */
export function xEdge(walls: BoxWalls): LabelEdge {
  return {
    start: new Point3D(-1, -walls.y, walls.z),
    end: new Point3D(1, -walls.y, walls.z),
    outward: new Point3D(0, -walls.y, 0),
  };
}

/** @internal The edge of the Y labels: on the floor, on the side away from the X wall. */
export function yEdge(walls: BoxWalls): LabelEdge {
  return {
    start: new Point3D(-walls.x, -1, walls.z),
    end: new Point3D(-walls.x, 1, walls.z),
    outward: new Point3D(-walls.x, 0, 0),
  };
}

/** @internal The edge of the Z labels: the upright edge further left on the screen. */
export function zEdge(walls: BoxWalls, matrix: Matrix3D): LabelEdge {
  const first = new Point3D(-walls.x, walls.y, 0);
  const second = new Point3D(walls.x, -walls.y, 0);
  const corner = matrix.project(first).x <= matrix.project(second).x ? first : second;
  return {
    start: corner.withZ(-1),
    end: corner.withZ(1),
    outward: new Point3D(corner.x, corner.y, 0).normalized(),
  };
}

/** @internal Shows each span only where it keeps a gap from the last shown one. */
export function keepApart(spans: readonly (readonly [number, number])[], gap: number, shown: boolean[]): void {
  let lastStart = Number.NaN;
  let lastEnd = Number.NaN;
  spans.forEach(([a, b], i) => {
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    const isShown = Number.isNaN(lastStart) || start >= lastEnd + gap || end <= lastStart - gap;
    shown[i] = isShown;
    if (isShown) {
      lastStart = start;
      lastEnd = end;
    }
  });
}
