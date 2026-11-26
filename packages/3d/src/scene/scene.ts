// What a 3D chart shows: three axes, the camera and the elements, as Scene3D of the .NET version. The elements come
// part by part; a scene without them shows the axis box.
import { DoubleRange, NumericAxis, type Axis } from '@tachyon-charts/core';
import { Camera3D } from './camera';
import type { Bars3D } from './bars';
import type { Bubbles3D } from './bubbles';
import type { Line3D, Scatter3D } from './points';
import type { Surface3D } from './surface';
import type { Waterfall3D } from './waterfall';

/** An element of a scene with a version that grows with each change of its content. */
export interface SceneElement {
  /** Grows with each change. */
  readonly version: number;
}

/** @internal A numeric axis of the box, along the bottom so that its values run as in the .NET version. */
export function createBoxAxis(id: string, minimum = 0, maximum = 1, title?: string): NumericAxis {
  const axis = new NumericAxis(id, 'bottom');
  axis.visibleRange = new DoubleRange(minimum, maximum);
  axis.title = title;
  return axis;
}

/** The content of a 3D chart: the axes of the box, the camera and the elements inside. */
export class Scene3D {
  /** The camera. */
  readonly camera = new Camera3D();
  /** The axis from left to right on the floor. */
  xAxis: Axis = createBoxAxis('x3d');
  /** The axis from front to back on the floor. */
  yAxis: Axis = createBoxAxis('y3d');
  /** The upward axis. */
  zAxis: Axis = createBoxAxis('z3d');
  private readonly elementList: SceneElement[] = [];
  private readonly surfaceList: Surface3D[] = [];
  private readonly waterfallList: Waterfall3D[] = [];
  private readonly lineList: Line3D[] = [];
  private readonly scatterList: Scatter3D[] = [];
  private readonly barList: Bars3D[] = [];
  private readonly bubbleList: Bubbles3D[] = [];
  private axesShown = true;
  private changes = 0;

  /** Whether the box shows its walls, grid and labels; true by default. */
  get showsAxes(): boolean {
    return this.axesShown;
  }

  set showsAxes(value: boolean) {
    this.axesShown = value;
    this.changes++;
  }

  /** The height fields. */
  get surfaces(): readonly Surface3D[] {
    return this.surfaceList;
  }

  /** The waterfalls. */
  get waterfalls(): readonly Waterfall3D[] {
    return this.waterfallList;
  }

  /** Adds a waterfall. */
  addWaterfall(waterfall: Waterfall3D): void {
    this.waterfallList.push(waterfall);
    this.addElement(waterfall);
  }

  /** Adds a height field. */
  addSurface(surface: Surface3D): void {
    this.surfaceList.push(surface);
    this.addElement(surface);
  }

  /** The lines. */
  get lines(): readonly Line3D[] {
    return this.lineList;
  }

  /** The scatters. */
  get scatters(): readonly Scatter3D[] {
    return this.scatterList;
  }

  /** The columns. */
  get bars(): readonly Bars3D[] {
    return this.barList;
  }

  /** The bubbles. */
  get bubbles(): readonly Bubbles3D[] {
    return this.bubbleList;
  }

  /** Adds bubbles. */
  addBubbles(bubbles: Bubbles3D): void {
    this.bubbleList.push(bubbles);
    this.addElement(bubbles);
  }

  /** Adds columns. */
  addBars(bars: Bars3D): void {
    this.barList.push(bars);
    this.addElement(bars);
  }

  /** Adds a line. */
  addLine(line: Line3D): void {
    this.lineList.push(line);
    this.addElement(line);
  }

  /** Adds a scatter. */
  addScatter(scatter: Scatter3D): void {
    this.scatterList.push(scatter);
    this.addElement(scatter);
  }

  /** @internal The elements of the scene. */
  get elements(): readonly SceneElement[] {
    return this.elementList;
  }

  /** Grows with every change of the content, the ranges included, but not with the camera. */
  get version(): number {
    // Ranges belong to the content: a chart group moves them from outside.
    let version = this.changes + this.xAxis.version + this.yAxis.version + this.zAxis.version;
    for (const element of this.elementList) {
      version += element.version;
    }
    return version;
  }

  /** @internal Adds an element. */
  addElement(element: SceneElement): void {
    this.elementList.push(element);
    this.changes++;
  }
}
