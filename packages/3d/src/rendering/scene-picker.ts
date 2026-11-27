// Finds what lies under the pointer, on the CPU, so that a frame never waits for the GPU, as ScenePicker of the .NET
// version. Lines, scatters and small clouds are searched point by point; a large cloud through the leaves of its
// octree, front ones first.
import type { Bubbles3D } from '../scene/bubbles';
import type { Ray3D } from '../scene/camera';
import type { CloudLeaves } from '../scene/cloud-tree';
import { Point3D } from '../scene/matrix';
import type { Mesh3D } from '../scene/mesh';
import {
  findInGrid,
  hitHeights,
  limit1,
  limitToBox,
  limitToPlane,
  MeshTree,
  nearestNode,
  pieceDistance,
  rayAt,
  reachAt,
  type Pick3D,
  type PickReach,
} from '../scene/picking';
import { gridPlace } from '../scene/bars';
import type { PointCloud3D } from '../scene/point-cloud';
import { BoxMap } from '../scene/points';
import type { Scene3D } from '../scene/scene';

const cloudSearch = 60_000;
const cloudLeafSearch = 4096;
const boxLow = new Point3D(-1, -1, -1);
const boxHigh = new Point3D(1, 1, 1);

interface MeshEntry {
  readonly mesh: Mesh3D;
  readonly tree: MeshTree;
  readonly source: object;
}

interface BubbleEntry {
  /** Center in the box and size per bubble: four floats each, a negative size in screen pixels. */
  readonly places: Float32Array;
  /** The number of the bubble behind each place. */
  readonly numbers: Int32Array;
}

/** @internal The octree of a large cloud as the picker reads it. */
export interface CloudOrder {
  readonly leaves: CloudLeaves;
  readonly order: Int32Array;
  readonly leafCount: number;
}

function across(low: number, high: number, index: number, count: number): number {
  return low + ((high - low) * index) / (count - 1);
}

/** @internal Finds what lies on a ray through the box. */
export class ScenePicker {
  private readonly meshes = new Map<Mesh3D, MeshEntry>();
  private readonly bubbles = new Map<Bubbles3D, BubbleEntry>();
  private readonly clouds = new Map<PointCloud3D, CloudOrder>();

  constructor(private readonly scene: Scene3D) {}

  /** Takes over a surface of triangles as it lies in the box. */
  addMesh(mesh: Mesh3D, positions: readonly Point3D[], indices: Uint32Array, source: object): void {
    this.meshes.set(mesh, { mesh, tree: new MeshTree(positions, indices), source });
  }

  /** Takes over the bubbles of an object as they lie in the box. */
  addBubbles(bubbles: Bubbles3D, places: Float32Array, numbers: Int32Array): void {
    this.bubbles.set(bubbles, { places, numbers });
  }

  /** Takes over the octree of a large cloud. */
  addCloud(cloud: PointCloud3D, order: CloudOrder): void {
    this.clouds.set(cloud, order);
  }

  /** Forgets all, as after new ranges of the axes. */
  clear(): void {
    this.meshes.clear();
    this.bubbles.clear();
    this.clouds.clear();
  }

  /** The nearest thing on a ray, or undefined. */
  find(ray: Ray3D, reach: PickReach): Pick3D | undefined {
    const span: [number, number] = [0, Infinity];
    if (!limitToBox(ray, boxLow, boxHigh, span)) {
      return undefined;
    }
    for (const plane of this.scene.planes) {
      if (plane.hides && !limitToPlane(ray, plane, span)) {
        return undefined;
      }
    }
    const near = span[0];
    const state = { far: span[1], best: undefined as Pick3D | undefined };
    const scene = this.scene;
    const map = new BoxMap(scene.xAxis, scene.yAxis, scene.zAxis);
    for (const surface of scene.surfaces) {
      const data = surface.data;
      const place = gridPlace(scene, surface.x, surface.y, data.width, data.height);
      const transform = scene.zAxis.createTransform(-1, 2);
      const sign = scene.zAxis.isHorizontal ? 1 : -1;
      const height = (column: number, row: number): number => {
        const value = data.at(column, row);
        return Number.isFinite(value) ? sign * transform.toPixel(value) : Number.NaN;
      };
      const hit = findInGrid(ray, place, near, state.far, (i, j, from, to) =>
        hitHeights(ray, place, height, i, j, from, to),
      );
      if (hit) {
        state.far = hit.distance;
        const [column, row] = nearestNode(place, rayAt(ray, hit.distance));
        state.best = {
          position: new Point3D(
            across(surface.x.min, surface.x.max, column, data.width),
            across(surface.y.min, surface.y.max, row, data.height),
            data.at(column, row),
          ),
          source: surface,
          box: rayAt(ray, hit.distance),
        };
      }
    }
    for (const waterfall of scene.waterfalls) {
      const data = waterfall.data;
      const first = data.totalRows - data.rows;
      const place = gridPlace(scene, waterfall.x, waterfall.y, data.columns, data.rows);
      const transform = scene.zAxis.createTransform(-1, 2);
      const sign = scene.zAxis.isHorizontal ? 1 : -1;
      const height = (column: number, row: number): number => {
        const value = data.read(first + row, column);
        return Number.isFinite(value) ? sign * transform.toPixel(value) : Number.NaN;
      };
      const hit = findInGrid(ray, place, near, state.far, (i, j, from, to) =>
        hitHeights(ray, place, height, i, j, from, to),
      );
      if (hit) {
        const [column, row] = nearestNode(place, rayAt(ray, hit.distance));
        const value = data.read(first + row, column);
        if (Number.isFinite(value)) {
          state.far = hit.distance;
          state.best = {
            position: new Point3D(
              across(waterfall.x.min, waterfall.x.max, column, data.columns),
              across(waterfall.y.min, waterfall.y.max, row, data.rows),
              value,
            ),
            source: waterfall,
            box: rayAt(ray, hit.distance),
          };
        }
      }
    }
    for (const bars of scene.bars) {
      const data = bars.data;
      const place = bars.cells(scene);
      const halfX = (Math.abs(place.stepX) * bars.width) / 2;
      const halfY = (Math.abs(place.stepY) * bars.width) / 2;
      const hit = findInGrid(ray, place, near, state.far, (i, j, from, to) => {
        const [low, high] = bars.ends(data.at(i, j), map);
        if (high <= low) {
          return undefined;
        }
        const x = place.left + (i + 0.5) * place.stepX;
        const y = place.front + (j + 0.5) * place.stepY;
        const cell: [number, number] = [from, to];
        return limit1(ray.start.x, ray.direction.x, x - halfX, x + halfX, cell) &&
          limit1(ray.start.y, ray.direction.y, y - halfY, y + halfY, cell) &&
          limit1(ray.start.z, ray.direction.z, low, high, cell)
          ? cell[0]
          : undefined;
      });
      if (hit) {
        state.far = hit.distance;
        const x = bars.x.min + ((hit.column + 0.5) * (bars.x.max - bars.x.min)) / data.width;
        const y = bars.y.min + ((hit.row + 0.5) * (bars.y.max - bars.y.min)) / data.height;
        state.best = {
          position: new Point3D(x, y, data.at(hit.column, hit.row)),
          source: bars,
          box: rayAt(ray, hit.distance),
        };
      }
    }
    for (const entry of this.meshes.values()) {
      const hit = entry.tree.find(ray, near, state.far);
      if (hit) {
        state.far = hit.distance;
        const [a, b, c] = entry.tree.corners(hit.triangle);
        const vertices = entry.mesh.vertices;
        const w = 1 - hit.u - hit.v;
        const pa = (vertices[a] as { position: Point3D }).position;
        const pb = (vertices[b] as { position: Point3D }).position;
        const pc = (vertices[c] as { position: Point3D }).position;
        const values = entry.mesh.values;
        state.best = {
          position: pa.times(w).plus(pb.times(hit.u)).plus(pc.times(hit.v)),
          source: entry.source,
          box: rayAt(ray, hit.distance),
          ...(values
            ? { value: (values[a] as number) * w + (values[b] as number) * hit.u + (values[c] as number) * hit.v }
            : {}),
        };
      }
    }
    this.findOnBubbles(ray, reach, near, state);
    for (const line of scene.lines) {
      this.findOnPoints(ray, reach, near, state, line.points, line, true, map);
    }
    for (const scatter of scene.scatters) {
      this.findOnPoints(ray, reach, near, state, scatter.points, scatter, false, map);
    }
    for (const cloud of scene.clouds) {
      this.findOnCloud(ray, reach, near, state, cloud, map);
    }
    for (const volume of scene.volumes) {
      const found =
        (volume.showsSlices ? volume.findOnSlice(ray, scene, near, state.far) : undefined) ??
        volume.findInside(ray, scene, near, state.far);
      if (found) {
        state.far = found.distance;
        state.best = {
          position: volume.toData(found.place),
          source: volume,
          box: found.box,
          value: volume.data.at(found.place[0], found.place[1], found.place[2]),
        };
      }
    }
    return state.best;
  }

  // A bubble in pixels has the radius of so many pixels at its distance.
  private findOnBubbles(
    ray: Ray3D,
    reach: PickReach,
    near: number,
    state: { far: number; best: Pick3D | undefined },
  ): void {
    for (const [bubbles, entry] of this.bubbles) {
      let found = -1;
      const places = entry.places;
      for (let i = 0; i < entry.numbers.length; i++) {
        const at = i * 4;
        const offset = ray.start.minus(
          new Point3D(places[at] as number, places[at + 1] as number, places[at + 2] as number),
        );
        const along = Point3D.dot(offset, ray.direction);
        const size = places[at + 3] as number;
        const radius = size > 0 ? size : ((-size / 2) * reachAt(reach, -along)) / 6;
        const miss = Point3D.dot(offset, offset) - along * along;
        if (miss > radius * radius) {
          continue;
        }
        const distance = -along - Math.sqrt(radius * radius - miss);
        if (distance >= near && distance <= state.far) {
          state.far = distance;
          found = i;
        }
      }
      if (found >= 0) {
        const number = entry.numbers[found] as number;
        const value = bubbles.values?.[number];
        state.best = {
          position: new Point3D(bubbles.x[number] as number, bubbles.y[number] as number, bubbles.z[number] as number),
          source: bubbles,
          box: rayAt(ray, state.far),
          ...(value === undefined ? {} : { value }),
        };
      }
    }
  }

  // The point or line piece nearest along the ray within the reach of the pointer.
  private findOnPoints(
    ray: Ray3D,
    reach: PickReach,
    near: number,
    state: { far: number; best: Pick3D | undefined },
    points: { readonly count: number; read(index: number): Point3D },
    source: object,
    isLine: boolean,
    map: BoxMap,
  ): void {
    let before: { data: Point3D; box: Point3D } | undefined;
    for (let i = 0; i < points.count; i++) {
      const data = points.read(i);
      const box = map.toBox(data);
      if (!Number.isFinite(box.x + box.y + box.z)) {
        before = undefined;
        continue;
      }
      if (isLine) {
        if (before) {
          const hit = pieceDistance(ray, before.box, box);
          if (hit.along >= near && hit.along <= state.far && hit.distance <= reachAt(reach, hit.along)) {
            state.far = hit.along;
            const nearest = hit.share < 0.5 ? before : { data, box };
            state.best = { position: nearest.data, source, box: nearest.box };
          }
        }
        before = { data, box };
      } else {
        const along = Point3D.dot(box.minus(ray.start), ray.direction);
        if (along >= near && along <= state.far && box.minus(rayAt(ray, along)).length <= reachAt(reach, along)) {
          state.far = along;
          state.best = { position: data, source, box };
        }
      }
    }
  }

  // A small cloud point by point; a large one through the leaves on the ray, front ones first, until a leaf has a point
  // near the ray.
  private findOnCloud(
    ray: Ray3D,
    reach: PickReach,
    near: number,
    state: { far: number; best: Pick3D | undefined },
    cloud: PointCloud3D,
    map: BoxMap,
  ): void {
    const test = (point: number): boolean => {
      const data = new Point3D(cloud.x[point] as number, cloud.y[point] as number, cloud.z[point] as number);
      const box = map.toBox(data);
      const along = Point3D.dot(box.minus(ray.start), ray.direction);
      if (along >= near && along <= state.far && box.minus(rayAt(ray, along)).length <= reachAt(reach, along)) {
        state.far = along;
        state.best = { position: data, source: cloud, box };
        return true;
      }
      return false;
    };
    const octree = this.clouds.get(cloud);
    if (!octree) {
      if (cloud.count <= 1_000_000) {
        for (let i = 0; i < cloud.count; i++) {
          test(i);
        }
      }
      return;
    }
    const margin = reachAt(reach, state.far);
    const leaves: [number, number][] = [];
    const bounds = octree.leaves.bounds;
    for (let i = 0; i < octree.leafCount; i++) {
      const a = map.toBox(
        new Point3D(bounds[i * 6] as number, bounds[i * 6 + 1] as number, bounds[i * 6 + 2] as number),
      );
      const b = map.toBox(
        new Point3D(bounds[i * 6 + 3] as number, bounds[i * 6 + 4] as number, bounds[i * 6 + 5] as number),
      );
      const span: [number, number] = [near, state.far];
      const low = new Point3D(Math.min(a.x, b.x) - margin, Math.min(a.y, b.y) - margin, Math.min(a.z, b.z) - margin);
      const high = new Point3D(Math.max(a.x, b.x) + margin, Math.max(a.y, b.y) + margin, Math.max(a.z, b.z) + margin);
      if (limitToBox(ray, low, high, span)) {
        leaves.push([span[0], i]);
      }
    }
    leaves.sort((p, q) => p[0] - q[0]);
    let left = cloudSearch;
    for (const [, index] of leaves) {
      const first = octree.leaves.first[index] as number;
      const count = Math.min(octree.leaves.count[index] as number, left, cloudLeafSearch);
      left -= count;
      let isFound = false;
      for (let place = first; place < first + count; place++) {
        isFound = test(octree.order[place] as number) || isFound;
      }
      if (isFound || left <= 0) {
        return;
      }
    }
  }
}
