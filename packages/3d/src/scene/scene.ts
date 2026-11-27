// What a 3D chart shows: three axes, the camera and the elements, as Scene3D of the .NET version. The elements come
// part by part; a scene without them shows the axis box.
import { DoubleRange, NumericAxis, type Axis } from '@tachyon-charts/core';
import { Camera3D } from './camera';
import type { Bars3D } from './bars';
import type { Bubbles3D } from './bubbles';
import type { Mesh3D } from './mesh';
import type { AntennaPattern3D } from './antenna';
import type { ClipPlane3D } from './clip-plane';
import type { CutCurveFeed } from './cut-feed';
import type { Pick3D } from './picking';
import type { PointCloud3D } from './point-cloud';
import type { Volume3D } from './volume';
import type { MeasuredMap3D } from './measured-map';
import type { Pie3D } from './pie';
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
  private readonly meshList: Mesh3D[] = [];
  private readonly pieList: Pie3D[] = [];
  private readonly antennaList: AntennaPattern3D[] = [];
  private readonly mapList: MeasuredMap3D[] = [];
  private readonly planeList: ClipPlane3D[] = [];
  private readonly cloudList: PointCloud3D[] = [];
  private readonly volumeList: Volume3D[] = [];
  private readonly feedList: CutCurveFeed[] = [];
  private axesShown = true;
  private cursorPlace: number | undefined;
  private markerList: Pick3D[] = [];
  /** Called when a marker is set, by a click or in code. */
  onMarkerAdded: ((marker: Pick3D) => void) | undefined;
  private changes = 0;

  /**
   * The place of the cursor of a chart group on the first axis, shown as a thin frame across the box; undefined for
   * none.
   */
  get cursor(): number | undefined {
    return this.cursorPlace;
  }

  set cursor(value: number | undefined) {
    if (value !== this.cursorPlace) {
      this.cursorPlace = value;
      this.changes++;
    }
  }

  /** The markers, set by a click or in code; the newest last. */
  get markers(): readonly Pick3D[] {
    return this.markerList;
  }

  /** Sets a marker. */
  addMarker(marker: Pick3D): void {
    this.markerList = [...this.markerList, marker];
    this.changes++;
    this.onMarkerAdded?.(marker);
  }

  /** Removes the marker at a place of the list; outside of it nothing happens. */
  removeMarker(index: number): void {
    if (index >= 0 && index < this.markerList.length) {
      this.markerList = this.markerList.filter((_, i) => i !== index);
      this.changes++;
    }
  }

  /** Removes the newest marker. */
  removeLastMarker(): void {
    this.removeMarker(this.markerList.length - 1);
  }

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

  /** The meshes. */
  get meshes(): readonly Mesh3D[] {
    return this.meshList;
  }

  /** Adds a mesh. */
  addMesh(mesh: Mesh3D): void {
    this.meshList.push(mesh);
    this.addElement(mesh);
  }

  /** The curves that follow cuts through surfaces, as data for 2D charts. */
  get feeds(): readonly CutCurveFeed[] {
    return this.feedList;
  }

  /** Adds a curve that follows a cut through a surface, as data for a 2D chart. */
  addCut(feed: CutCurveFeed): void {
    this.feedList.push(feed);
    feed.scene = this;
    this.changes++;
  }

  /** The volumes. */
  get volumes(): readonly Volume3D[] {
    return this.volumeList;
  }

  /** Adds a volume; with its slices shown, their planes join the scene, so that their outlines move them. */
  addVolume(volume: Volume3D): void {
    this.volumeList.push(volume);
    this.addElement(volume);
    if (volume.showsSlices) {
      this.addPlane(volume.sliceX);
      this.addPlane(volume.sliceY);
      this.addPlane(volume.sliceZ);
    }
  }

  /** The very large clouds of points. */
  get clouds(): readonly PointCloud3D[] {
    return this.cloudList;
  }

  /** Adds a very large cloud of points. */
  addCloud(cloud: PointCloud3D): void {
    this.cloudList.push(cloud);
    this.addElement(cloud);
  }

  /** The planes that cut the scene. */
  get planes(): readonly ClipPlane3D[] {
    return this.planeList;
  }

  /**
   * Adds a plane that cuts the scene; at most four hide what lies beyond them.
   * @throws RangeError for a fifth plane that hides.
   */
  addPlane(plane: ClipPlane3D): void {
    if (plane.hides && this.planeList.filter((other) => other.hides).length >= 4) {
      throw new RangeError('At most four planes can hide parts of a scene.');
    }
    this.planeList.push(plane);
    this.addElement(plane);
  }

  /** The maps from measured points. */
  get maps(): readonly MeasuredMap3D[] {
    return this.mapList;
  }

  /** Adds a map from measured points. */
  addMap(map: MeasuredMap3D): void {
    this.mapList.push(map);
    this.addElement(map);
  }

  /** The antenna patterns. */
  get antennas(): readonly AntennaPattern3D[] {
    return this.antennaList;
  }

  /** Adds an antenna pattern. */
  addAntenna(antenna: AntennaPattern3D): void {
    this.antennaList.push(antenna);
    this.addElement(antenna);
  }

  /** The pies. */
  get pies(): readonly Pie3D[] {
    return this.pieList;
  }

  /** Adds a pie. */
  addPie(pie: Pie3D): void {
    this.pieList.push(pie);
    this.addElement(pie);
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
