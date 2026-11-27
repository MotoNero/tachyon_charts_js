// Models for the 3D pages: a large knot of tube, the pattern of an antenna, a map from measurements and a pipe bend
// from an STL file, made in code.
import {
  AntennaPattern3D,
  Chart3DBuilder,
  ClipPlane3D,
  MeasuredMap3D,
  ModelFile,
  ModelFileData,
  Point3D,
  PointCloud3D,
  PointFile,
  Points3D,
  Scatter3D,
  type PointCloudArrays,
} from '@tachyon-charts/3d';
import { Colormap, DoubleRange, SeededRandom } from '@tachyon-charts/core';

/** Temperature over speed and load from 160 measurements at uneven places, connected to a surface. */
export function measuredMap(chart: Chart3DBuilder): Chart3DBuilder {
  const count = 160;
  const random = new SeededRandom(4);
  const speed: number[] = [];
  const load: number[] = [];
  const temperature: number[] = [];
  for (let i = 0; i < count; i++) {
    speed.push(800 + 5200 * random.nextDouble());
    load.push(10 + 90 * random.nextDouble() * random.nextDouble());
    const a = (speed[i] as number) / 6000;
    const b = (load[i] as number) / 100;
    temperature.push(70 + 40 * a * b + 15 * Math.sin(a * 5) * b);
  }
  return chart
    .title('Temperature over speed and load')
    .xAxis(0, 6000, 'Speed in rpm')
    .yAxis(0, 100, 'Load in %')
    .zAxis(60, 120, 'Temperature in °C')
    .addMap(new MeasuredMap3D(speed, load, temperature));
}

/** The pattern of an antenna, measured every degree: a main lobe toward 30° azimuth and 20° up over side lobes. */
export function createAntenna(): AntennaPattern3D {
  const columns = 361;
  const rows = 181;
  const azimuths = Array.from({ length: columns }, (_, column) => column - 180);
  const elevations = Array.from({ length: rows }, (_, row) => row - 90);
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const gains = elevations.map((elevation) =>
    azimuths.map((azimuth) => {
      const a = (((azimuth - 30 + 540) % 360) - 180) / 40;
      const e = (elevation - 20) / 24;
      const main = 15 - 12 * (a * a + e * e);
      const side =
        -14 + 6 * Math.cos(radians(elevation)) * Math.cos(radians(5 * azimuth)) + 4 * Math.cos(radians(4 * elevation));
      return 10 * Math.log10(Math.pow(10, main / 10) + Math.pow(10, side / 10));
    }),
  );
  return new AntennaPattern3D(azimuths, elevations, gains);
}

// A knot that winds three times around and twice through a ring.
function knot(t: number): Point3D {
  const radius = 2 + Math.cos(3 * t);
  return new Point3D(radius * Math.cos(2 * t), radius * Math.sin(2 * t), Math.sin(3 * t));
}

function knotTangent(t: number): Point3D {
  return knot(t + 1e-4)
    .minus(knot(t - 1e-4))
    .normalized();
}

/**
 * Creates a smooth knot of tube with about a million triangles, from points shared by the triangles around them.
 * @param along - The number of steps along the knot.
 * @param around - The number of steps around the tube.
 */
export function createKnot(along = 4000, around = 125): ModelFileData {
  // Carry a frame along so that the tube does not twist, then spread the turn it has after one round over the whole
  // way, so that the end meets the start without a seam.
  const frames = new Array<Point3D>(along + 1);
  const firstTangent = knot(1e-3).minus(knot(0)).normalized();
  frames[0] = Point3D.cross(firstTangent, new Point3D(0, 0, 1)).normalized();
  for (let i = 1; i <= along; i++) {
    const tangent = knotTangent((2 * Math.PI * i) / along);
    const previous = frames[i - 1] as Point3D;
    frames[i] = previous.minus(tangent.times(Point3D.dot(previous, tangent))).normalized();
  }
  const start = knotTangent(0);
  const first = frames[0];
  const last = frames[along] as Point3D;
  const turn = Math.atan2(Point3D.dot(Point3D.cross(first, last), start), Point3D.dot(first, last));
  const positions = new Array<Point3D>(along * around);
  for (let i = 0; i < along; i++) {
    const t = (2 * Math.PI * i) / along;
    const middle = knot(t);
    const tangent = knotTangent(t);
    const frame = frames[i] as Point3D;
    const side = Point3D.cross(tangent, frame);
    for (let j = 0; j < around; j++) {
      const angle = (2 * Math.PI * j) / around - (turn * i) / along;
      positions[i * around + j] = middle.plus(
        frame
          .times(Math.cos(angle))
          .plus(side.times(Math.sin(angle)))
          .times(0.42),
      );
    }
  }
  const triangles = new Array<number>(along * around * 6);
  let at = 0;
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * around + j;
      const b = i * around + ((j + 1) % around);
      const c = ((i + 1) % along) * around + ((j + 1) % around);
      const d = ((i + 1) % along) * around + j;
      triangles[at++] = a;
      triangles[at++] = b;
      triangles[at++] = c;
      triangles[at++] = a;
      triangles[at++] = c;
      triangles[at++] = d;
    }
  }
  return new ModelFileData(positions, triangles);
}

// The pipe bend with flanges, made as a binary STL file and read back like one from disk.
const leg = 40;
const bend = 60;
const outer = 15;
const inner = 12;
const flange = 25;
const flangeThickness = 5;

/** The length of the pipe along its middle, in mm. */
export const pipeLength = 2 * leg + (bend * Math.PI) / 2;

// The middle of the pipe: along x, a quarter circle upward, then along z.
function middle(s: number): Point3D {
  if (s <= leg) {
    return new Point3D(s, 0, 0);
  }
  const angle = (s - leg) / bend;
  if (angle <= Math.PI / 2) {
    return new Point3D(leg + bend * Math.sin(angle), 0, bend - bend * Math.cos(angle));
  }
  return new Point3D(leg + bend, 0, bend + (s - leg - (bend * Math.PI) / 2));
}

function tangent(s: number): Point3D {
  const angle = Math.min(Math.max((s - leg) / bend, 0), Math.PI / 2);
  return new Point3D(Math.cos(angle), 0, Math.sin(angle));
}

function along(place: Point3D): number {
  if (place.x <= leg) {
    return place.x;
  }
  if (place.z <= bend) {
    return leg + bend * Math.atan2(place.x - leg, bend - place.z);
  }
  return leg + (bend * Math.PI) / 2 + (place.z - bend);
}

function ring(s: number, radius: number, step: number, around: number): Point3D {
  const angle = (2 * Math.PI * step) / around;
  const up = new Point3D(0, 1, 0);
  const side = Point3D.cross(tangent(s), up);
  return middle(s).plus(
    up
      .times(Math.cos(angle))
      .plus(side.times(Math.sin(angle)))
      .times(radius),
  );
}

// A band of triangles between two rings around the middle.
function band(
  corners: Point3D[],
  s0: number,
  r0: number,
  s1: number,
  r1: number,
  around: number,
  outward: boolean,
  steps = 1,
): void {
  for (let k = 0; k < steps; k++) {
    const a = s0 + ((s1 - s0) * k) / steps;
    const b = s0 + ((s1 - s0) * (k + 1)) / steps;
    for (let j = 0; j < around; j++) {
      const p0 = ring(a, r0, j, around);
      const p1 = ring(a, r0, j + 1, around);
      const q0 = ring(b, r1, j, around);
      const q1 = ring(b, r1, j + 1, around);
      if (outward) {
        corners.push(p0, q1, p1, p0, q0, q1);
      } else {
        corners.push(p0, p1, q1, p0, q1, q0);
      }
    }
  }
}

/** Creates the pipe bend as the bytes of a binary STL file. */
export function createPipeStl(around = 96): Uint8Array<ArrayBuffer> {
  const length = pipeLength;
  const bendSteps = 48;
  // Places along the middle, with the outer radius there: a flange at each end, the bend in fine steps.
  const stations: [number, number][] = [
    [0, flange],
    [flangeThickness, flange],
    [flangeThickness, outer],
    [leg, outer],
  ];
  for (let i = 1; i <= bendSteps; i++) {
    stations.push([leg + (((bend * Math.PI) / 2) * i) / bendSteps, outer]);
  }
  stations.push([length - flangeThickness, outer], [length - flangeThickness, flange], [length, flange]);
  const corners: Point3D[] = [];
  for (let i = 0; i + 1 < stations.length; i++) {
    const [s0, r0] = stations[i] as [number, number];
    const [s1, r1] = stations[i + 1] as [number, number];
    band(corners, s0, r0, s1, r1, around, true);
  }
  band(corners, 0, inner, length, inner, around, false, bendSteps + 2);
  band(corners, 0, inner, 0, flange, around, true);
  band(corners, length, flange, length, inner, around, true);
  const count = corners.length / 3;
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  new TextEncoder().encodeInto('pipe bend, made in code', bytes);
  view.setUint32(80, count, true);
  corners.forEach((corner, i) => {
    const at = 84 + Math.trunc(i / 3) * 50 + 12 + (i % 3) * 12;
    view.setFloat32(at, corner.x, true);
    view.setFloat32(at + 4, corner.y, true);
    view.setFloat32(at + 8, corner.z, true);
  });
  return bytes;
}

/**
 * The temperature of the wall at a place in mm: hot water enters at the first flange and cools down, with a hot spot
 * on the outside of the bend.
 */
export function pipeTemperature(place: Point3D): number {
  const spot = middle(leg + (bend * Math.PI) / 4).plus(
    new Point3D(Math.sin(Math.PI / 4), 0, -Math.cos(Math.PI / 4)).times(outer),
  );
  const distance = place.minus(spot).length;
  return 92 - (34 * along(place)) / pipeLength + 26 * Math.exp((-distance * distance) / 500);
}

/** Places of sensors along the inner side of the pipe, in mm. */
export function pipeSensors(count: number): Point3D[] {
  return Array.from({ length: count }, (_, i) => {
    const s = flangeThickness + 6 + ((pipeLength - 2 * flangeThickness - 12) * i) / (count - 1);
    return middle(s).plus(Point3D.cross(tangent(s), new Point3D(0, 1, 0)).times(outer + 3));
  });
}

/** A pipe bend read from an STL file, colored by the temperature of its wall, with sensors and cut open by a plane. */
export function pipeModel(chart: Chart3DBuilder): Chart3DBuilder {
  const model = ModelFile.readStl(createPipeStl());
  const mesh = model.toValueMesh(
    model.positions.map(pipeTemperature),
    Colormap.builtIn('turbo'),
    new DoubleRange(55, 115),
    { gloss: 0.3 },
    '°C',
  );
  model.addToScale(chart.title('Pipe bend, wall temperature in °C'), mesh);
  const sensors = pipeSensors(9);
  const points = new Points3D(sensors.length);
  for (const place of sensors) {
    points.append(place.x, place.y - 1, place.z, { r: 255, g: 255, b: 255, a: 255 }, 10);
  }
  return chart.addScatter(new Scatter3D(points)).addPlane(new ClipPlane3D(new Point3D(0, 1, 0), -0.05));
}

/**
 * The points of a scanned landscape: hills and ripples over -1 to 1, colored by height. A fixed number of parts with a
 * random generator each, so that the points are those of the .NET version.
 */
export function createLandscape(count: number, report: (share: number) => void = () => undefined): PointCloudArrays {
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const z = new Float64Array(count);
  const colors = new Uint8Array(count * 4);
  const viridis = Colormap.builtIn('viridis');
  const parts = 32;
  for (let part = 0; part < parts; part++) {
    const random = new SeededRandom(part);
    const end = Math.trunc((count * (part + 1)) / parts);
    for (let i = Math.trunc((count * part) / parts); i < end; i++) {
      const a = random.nextDouble() * 2 - 1;
      const b = random.nextDouble() * 2 - 1;
      const height =
        0.45 * Math.sin(a * 4) * Math.cos(b * 3) + 0.15 * Math.sin((a + b) * 11) + 0.02 * random.nextDouble();
      x[i] = a;
      y[i] = b;
      z[i] = height;
      const color = viridis.sample((height + 0.65) / 1.3);
      colors.set([color.r, color.g, color.b, color.a], i * 4);
    }
    report((part + 1) / parts);
  }
  return { x, y, z, colors };
}

/** A scanned landscape of a number of points; a large one forms after the first picture. */
export function landscape(chart: Chart3DBuilder, count: number): Chart3DBuilder {
  const cloud =
    count <= PointCloud3D.previewLimit
      ? new PointCloud3D(createLandscape(count))
      : new PointCloud3D((report) => Promise.resolve().then(() => createLandscape(count, report)));
  return chart.title('Scanned landscape').xAxis(-1, 1, 'x').yAxis(-1, 1, 'y').zAxis(-1, 1, 'z').addCloud(cloud);
}

/** The landscape as a LAS file of format 2 with colors of 16 bits, as a scanner writes it: millimeters from an origin. */
export function landscapeLas(count: number): Blob {
  const points = createLandscape(count);
  const record = 26;
  const offset = 227;
  const bytes = new Uint8Array(offset + count * record);
  const view = new DataView(bytes.buffer);
  bytes.set([76, 65, 83, 70], 0);
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, offset, true);
  view.setUint32(96, offset, true);
  view.setUint8(104, 2);
  view.setUint16(105, record, true);
  view.setUint32(107, count, true);
  for (let i = 0; i < 3; i++) {
    view.setFloat64(131 + i * 8, 0.001, true);
    view.setFloat64(155 + i * 8, 0, true);
  }
  const colors = points.colors as Uint8Array;
  for (let i = 0; i < count; i++) {
    const at = offset + i * record;
    view.setInt32(at, Math.round((points.x[i] as number) * 1000), true);
    view.setInt32(at + 4, Math.round((points.y[i] as number) * 1000), true);
    view.setInt32(at + 8, Math.round((points.z[i] as number) * 1000), true);
    view.setUint16(at + 20, (colors[i * 4] as number) * 257, true);
    view.setUint16(at + 22, (colors[i * 4 + 1] as number) * 257, true);
    view.setUint16(at + 24, (colors[i * 4 + 2] as number) * 257, true);
  }
  return new Blob([bytes]);
}

/** A cloud read from a LAS file, with the progress of reading above the box. */
export function cloudFromLas(chart: Chart3DBuilder, file: Blob): Chart3DBuilder {
  return chart
    .title('Scanned landscape')
    .xAxis(-1, 1, 'x')
    .yAxis(-1, 1, 'y')
    .zAxis(-1, 1, 'z')
    .addCloud(new PointCloud3D((report) => PointFile.read(file, 'landscape.las', report)));
}
