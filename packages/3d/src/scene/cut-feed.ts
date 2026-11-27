// A 2D data source on the cut of a plane through a surface, as CutCurveFeed of the .NET version: when the plane moves
// or the surface changes, the curve follows in the next frame of the 3D chart. A 2D chart shows the source as a line
// and needs nothing of 3D.
import { DataSource } from '@tachyon-charts/core';
import type { ClipPlane3D, CutCurve } from './clip-plane';
import { Point3D } from './matrix';
import { BoxMap } from './points';
import type { SceneAxes } from './axis-box';
import type { Pick3D } from './picking';
import type { Surface3D } from './surface';

/** A marker of the 3D chart as the 2D chart of a cut shows it: its number, its place along the cut and its value. */
export interface CutMarker {
  /** The number of the marker, from 1. */
  readonly number: number;
  /** The place along the cut. */
  readonly along: number;
  /** The value of the marker. */
  readonly value: number;
}

/** The scene a cut belongs to: its axes and markers. */
export interface CutScene extends SceneAxes {
  /** The markers. */
  readonly markers: readonly Pick3D[];
  /** Grows with every change of the content. */
  readonly version: number;
  /** Sets a marker. */
  addMarker(marker: Pick3D): void;
  /** Removes a marker. */
  removeMarker(index: number): void;
  /** Removes the newest marker. */
  removeLastMarker(): void;
}

interface Cut {
  readonly curve: CutCurve;
  readonly along: number[];
}

/** Keeps a 2D data source on the cut of a plane through a surface. */
export class CutCurveFeed {
  /**
   * The curve: over the first axis for a plane across the second axis, over the second axis for a plane across the
   * first one, and over the way along the cut otherwise.
   */
  readonly data = new DataSource();
  private seen = '';
  private cut: Cut = { curve: { along: [], x: [], y: [], values: [] }, along: [] };
  private cutVersion = 0;
  /** @internal The scene the cut belongs to. */
  scene: CutScene | undefined;

  /**
   * @param plane - The plane; it should stand upright.
   * @param surface - The surface it cuts.
   */
  constructor(
    /** The plane. */
    readonly plane: ClipPlane3D,
    /** The surface. */
    readonly surface: Surface3D,
  ) {}

  /** Grows when the markers or the cut change. */
  get version(): number {
    return this.cutVersion + (this.scene?.markers.length ?? 0) + (this.scene?.version ?? 0);
  }

  /**
   * The markers of the 3D chart, placed on the cut: a marker beside the plane shows where the cut passes nearest to
   * it, with its own value.
   */
  get markers(): CutMarker[] {
    const curve = this.cut.curve;
    const found: CutMarker[] = [];
    (this.scene?.markers ?? []).forEach((marker, i) => {
      const position = marker.position;
      let nearest = -1;
      let distance = Infinity;
      for (let j = 0; j < this.cut.along.length; j++) {
        const dx = (curve.x[j] as number) - position.x;
        const dy = (curve.y[j] as number) - position.y;
        if (dx * dx + dy * dy < distance) {
          nearest = j;
          distance = dx * dx + dy * dy;
        }
      }
      if (nearest >= 0) {
        // Along an axis the marker keeps its own place, between the samples of the cut.
        let along = this.cut.along[nearest] as number;
        if (this.cut.along === curve.x) {
          along = position.x;
        } else if (this.cut.along === curve.y) {
          along = position.y;
        }
        found.push({ number: i + 1, along, value: position.z });
      }
    });
    return found;
  }

  /** Sets a marker on the cut, which the 3D chart shows too; false where the cut has no value. */
  addMarker(along: number): boolean {
    const scene = this.scene;
    const place = this.find(along);
    if (!scene || !place) {
      return false;
    }
    const map = new BoxMap(scene.xAxis, scene.yAxis, scene.zAxis);
    scene.addMarker({ position: place, source: this.surface, box: map.toBox(place) });
    return true;
  }

  /** Removes the marker next to a place along the cut, within a reach; false when none is that near. */
  removeMarkerNear(along: number, reach: number): boolean {
    let nearest = -1;
    let distance = reach;
    for (const marker of this.markers) {
      if (Math.abs(marker.along - along) <= distance) {
        nearest = marker.number - 1;
        distance = Math.abs(marker.along - along);
      }
    }
    if (nearest < 0 || !this.scene) {
      return false;
    }
    this.scene.removeMarker(nearest);
    return true;
  }

  /** Removes the newest marker. */
  removeNewestMarker(): void {
    this.scene?.removeLastMarker();
  }

  /** @internal Brings the curve up to date; true when it changed. */
  update(scene: CutScene): boolean {
    const version = [this.plane.version, this.surface.version, scene.xAxis.version, scene.yAxis.version].join(' ');
    if (version === this.seen) {
      return false;
    }
    this.seen = version;
    const curve = this.plane.cutSurface(this.surface, scene);
    const normal = this.plane.normal;
    let along = curve.along;
    if (Math.abs(normal.x) < 1e-9) {
      along = curve.x;
    } else if (Math.abs(normal.y) < 1e-9) {
      along = curve.y;
    }
    this.data.clear();
    this.data.append(along, curve.values);
    this.cut = { curve, along };
    this.cutVersion++;
    return true;
  }

  // The place on the cut, or undefined where it has no value.
  private find(along: number): Point3D | undefined {
    const places = this.cut.along;
    const curve = this.cut.curve;
    for (let i = 1; i < places.length; i++) {
      const a = places[i - 1] as number;
      const b = places[i] as number;
      if (along < Math.min(a, b) || along > Math.max(a, b)) {
        continue;
      }
      const share = Math.max(a, b) > Math.min(a, b) ? (along - a) / (b - a) : 0;
      const value =
        (curve.values[i - 1] as number) + share * ((curve.values[i] as number) - (curve.values[i - 1] as number));
      if (Number.isFinite(value)) {
        return new Point3D(
          (curve.x[i - 1] as number) + share * ((curve.x[i] as number) - (curve.x[i - 1] as number)),
          (curve.y[i - 1] as number) + share * ((curve.y[i] as number) - (curve.y[i - 1] as number)),
          value,
        );
      }
    }
    return undefined;
  }
}
