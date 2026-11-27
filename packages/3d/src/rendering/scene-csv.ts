// The data of a scene as CSV, as SceneCsv of the .NET version: one line per point with object, x, y, z and value, for
// markers, lines, points, surfaces, maps, meshes, waterfalls, clouds of up to five million points, antenna patterns
// (azimuth, elevation and gain in x, y and z), columns and bubbles. Only what lies inside the axes goes in; volumes and
// larger clouds stay out, as no table program opens hundreds of millions of values.
import type { DoubleRange } from '@tachyon-charts/core';
import type { Points3D } from '../scene/points';
import type { Scene3D } from '../scene/scene';

/** @internal The largest cloud that goes into the table. */
export const mostCloudPoints = 5_000_000;

function across(low: number, high: number, index: number, count: number): number {
  return low + ((high - low) * index) / (count - 1);
}

function inside(range: DoubleRange, value: number): boolean {
  return value >= Math.min(range.min, range.max) && value <= Math.max(range.min, range.max);
}

/** @internal Writes the table of a scene. */
export function sceneToCsv(scene: Scene3D): string {
  const lines = ['object,x,y,z,value'];
  const xRange = scene.xAxis.visibleRange;
  const yRange = scene.yAxis.visibleRange;
  const zRange = scene.zAxis.visibleRange;
  const row = (name: string, x: number, y: number, z: number, value: number, everywhere = false): void => {
    if (everywhere || (inside(xRange, x) && inside(yRange, y) && inside(zRange, z))) {
      lines.push(`${name},${String(x)},${String(y)},${String(z)},${Number.isNaN(value) ? '' : String(value)}`);
    }
  };
  const points = (name: string, list: Points3D): void => {
    for (let i = 0; i < list.count; i++) {
      const point = list.read(i);
      row(name, point.x, point.y, point.z, Number.NaN);
    }
  };
  scene.markers.forEach((marker, i) => {
    const p = marker.position;
    row(`marker ${String(i + 1)}`, p.x, p.y, p.z, marker.value ?? Number.NaN);
  });
  scene.lines.forEach((line, i) => {
    points(`line ${String(i + 1)}`, line.points);
  });
  scene.scatters.forEach((scatter, i) => {
    points(`points ${String(i + 1)}`, scatter.points);
  });
  scene.surfaces.forEach((surface, i) => {
    const data = surface.data;
    for (let r = 0; r < data.height; r++) {
      for (let c = 0; c < data.width; c++) {
        const value = data.at(c, r);
        row(
          `surface ${String(i + 1)}`,
          across(surface.x.min, surface.x.max, c, data.width),
          across(surface.y.min, surface.y.max, r, data.height),
          value,
          value,
        );
      }
    }
  });
  scene.maps.forEach((map, i) => {
    for (let j = 0; j < map.x.length; j++) {
      row(`map ${String(i + 1)}`, map.x[j] as number, map.y[j] as number, map.z[j] as number, map.z[j] as number);
    }
  });
  scene.meshes.forEach((mesh, i) => {
    for (const vertex of mesh.vertices) {
      const p = vertex.position;
      row(`mesh ${String(i + 1)}`, p.x, p.y, p.z, p.z);
    }
  });
  scene.waterfalls.forEach((waterfall, i) => {
    const data = waterfall.data;
    const first = data.totalRows - data.rows;
    for (let r = 0; r < data.rows; r++) {
      const y = across(waterfall.y.min, waterfall.y.max, r, data.rows);
      for (let c = 0; c < data.columns; c++) {
        const value = data.read(first + r, c);
        if (!Number.isNaN(value)) {
          row(`waterfall ${String(i + 1)}`, across(waterfall.x.min, waterfall.x.max, c, data.columns), y, value, value);
        }
      }
    }
  });
  scene.clouds.forEach((cloud, i) => {
    // Clouds that still load or are too large for a table stay out.
    if (cloud.isLoaded && cloud.count <= mostCloudPoints) {
      for (let j = 0; j < cloud.count; j++) {
        row(`cloud ${String(i + 1)}`, cloud.x[j] as number, cloud.y[j] as number, cloud.z[j] as number, Number.NaN);
      }
    }
  });
  scene.antennas.forEach((antenna, i) => {
    // An antenna pattern has its own coordinates: the angles and the gain, not places in the box.
    antenna.elevations.forEach((elevation, e) => {
      antenna.azimuths.forEach((azimuth, a) => {
        const gain = (antenna.gains[e] as readonly number[])[a] as number;
        row(`antenna ${String(i + 1)}`, azimuth, elevation, gain, gain, true);
      });
    });
  });
  scene.bars.forEach((bars, i) => {
    const data = bars.data;
    for (let r = 0; r < data.height; r++) {
      for (let c = 0; c < data.width; c++) {
        const value = data.at(c, r);
        const x = bars.x.min + ((c + 0.5) * (bars.x.max - bars.x.min)) / data.width;
        const y = bars.y.min + ((r + 0.5) * (bars.y.max - bars.y.min)) / data.height;
        row(`columns ${String(i + 1)}`, x, y, value, value);
      }
    }
  });
  scene.bubbles.forEach((bubbles, i) => {
    // The value of a bubble is its own value, or else its diameter.
    for (let j = 0; j < bubbles.count; j++) {
      row(
        `bubbles ${String(i + 1)}`,
        bubbles.x[j] as number,
        bubbles.y[j] as number,
        bubbles.z[j] as number,
        bubbles.values?.[j] ?? (bubbles.diameters[j] as number),
      );
    }
  });
  return `${lines.join('\r\n')}\r\n`;
}
