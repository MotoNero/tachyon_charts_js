// Synthetic CT volumes without patient data, as MedicalPhantoms of the .NET version: a head and a chest built from
// shapes in millimetres with a fixed noise, so that every run gives the same values as the .NET version.
import { Point3D, VolumeData } from '@tachyon-charts/3d';
import { MedicalVolume, PatientOrientation } from './medical-image';

const headSide = 256;
const headDepth = 192;
const headSpacing = 0.75;
const headSliceSpacing = 1.0;
const thoraxWidth = 384;
const thoraxHeight = 288;
const thoraxDepth = 200;
const thoraxSpacing = 1.0;
const thoraxSliceSpacing = 1.5;
const intercept = -1024;
const axial = new PatientOrientation(new Point3D(1, 0, 0), new Point3D(0, 1, 0));

let head: Uint16Array | undefined;
let thorax: Uint16Array | undefined;

/** Synthetic CT volumes without patient data: a head and a chest. */
export const MedicalPhantoms = {
  /** A head of 256 × 256 × 192 voxels of 0.75 × 0.75 × 1 mm, in Hounsfield units, built once. */
  head(): MedicalVolume {
    head ??= createHead();
    return new MedicalVolume(
      new VolumeData(head, headSide, headSide, headDepth, 1, intercept),
      { row: headSpacing, column: headSpacing },
      headSliceSpacing,
      Point3D.zero,
      axial,
      40,
      80,
      'CT',
    );
  },

  /** A chest of 384 × 288 × 200 voxels of 1 × 1 × 1.5 mm with lungs, vessels, ribs, spine and heart, built once. */
  thorax(): MedicalVolume {
    thorax ??= createThorax();
    return new MedicalVolume(
      new VolumeData(thorax, thoraxWidth, thoraxHeight, thoraxDepth, 1, intercept),
      { row: thoraxSpacing, column: thoraxSpacing },
      thoraxSliceSpacing,
      Point3D.zero,
      axial,
      40,
      400,
      'CT',
    );
  },
};

// All places in millimetres from the middle of the head; x to the left, y backwards, z upwards.
function createHead(): Uint16Array {
  const values = new Uint16Array(headSide * headSide * headDepth);
  const middle = ((headSide - 1) * headSpacing) / 2;
  const height = ((headDepth - 1) * headSliceSpacing) / 2;
  for (let slice = 0; slice < headDepth; slice++) {
    const z = slice * headSliceSpacing - height;
    for (let row = 0; row < headSide; row++) {
      const y = row * headSpacing - middle;
      for (let column = 0; column < headSide; column++) {
        const x = column * headSpacing - middle;
        values[(slice * headSide + row) * headSide + column] = store(headValue(x, y, z) + noise(column, row, slice, 5));
      }
    }
  }
  return values;
}

// Each shape lies inside the one before; once a place is fully outside one, the blends after it change nothing.
function headValue(x: number, y: number, z: number): number {
  const edge = headSpacing;
  const outside = edge / 2;
  let distance = ellipsoid(x, y, z, 0, 0, 0, 72, 90, 82);
  if (distance >= outside) {
    return -1000;
  }
  let hu = blend(-1000, 35, distance, edge);
  distance = ellipsoid(x, y, z, 0, 0, 0, 68, 86, 78);
  if (distance >= outside) {
    return hu;
  }
  hu = blend(hu, 1150 + 80 * Math.sin(x * 0.21 + z * 0.17), distance, edge);
  distance = ellipsoid(x, y, z, 0, 0, 0, 62.5, 80.5, 72.5);
  if (distance >= outside) {
    return hu;
  }
  hu = blend(hu, 8, distance, edge);
  distance = ellipsoid(x, y, z, 0, 0, 0, 61, 79, 71);
  if (distance >= outside) {
    return hu;
  }
  hu = blend(hu, 40 + 2 * Math.sin(x * 0.4 + y * 0.3), distance, edge);
  // White matter folds in and out under the grey matter.
  const folds = 3.5 * Math.sin(Math.atan2(y, x) * 9) * Math.sin(Math.atan2(z, Math.sqrt(x * x + y * y)) * 7);
  hu = blend(hu, 27, ellipsoid(x, y, z, 0, 4, 4, 48, 62, 52) + folds, edge);
  hu = blend(hu, 8, Math.min(ellipsoid(x, y, z, -9, -2, 8, 6, 26, 12), ellipsoid(x, y, z, 9, -2, 8, 6, 26, 12)), edge);
  return blend(hu, 68, ellipsoid(x, y, z, -34, -14, 2, 9, 9, 9), edge);
}

// x to the left, y backwards, both from the middle of the slice; z downwards from the top of the chest, in millimetres.
function createThorax(): Uint16Array {
  const values = new Uint16Array(thoraxWidth * thoraxHeight * thoraxDepth);
  const middleX = ((thoraxWidth - 1) * thoraxSpacing) / 2;
  const middleY = ((thoraxHeight - 1) * thoraxSpacing) / 2;
  const length = (thoraxDepth - 1) * thoraxSliceSpacing;
  const vessels = new VesselTree(length);
  for (let slice = 0; slice < thoraxDepth; slice++) {
    // The slices count upwards in the patient, so the last one is the top of the chest.
    const z = length - slice * thoraxSliceSpacing;
    for (let row = 0; row < thoraxHeight; row++) {
      const y = row * thoraxSpacing - middleY;
      for (let column = 0; column < thoraxWidth; column++) {
        const x = column * thoraxSpacing - middleX;
        values[(slice * thoraxHeight + row) * thoraxWidth + column] = store(
          thoraxValue(x, y, z, length, vessels) + noise(column, row, slice, 8),
        );
      }
    }
  }
  return values;
}

function thoraxValue(x: number, y: number, z: number, length: number, vessels: VesselTree): number {
  const edge = thoraxSpacing;
  const body = ellipse(x, y, 0, 0, 177, 95);
  // Outside the body every shape after it lies farther out still.
  if (body >= edge / 2) {
    return -1000;
  }
  let hu = blend(-1000, -100, body, edge);
  hu = blend(hu, 45 + 6 * Math.sin(x * 0.02 + z * 0.015), ellipse(x, y, 0, 0, 164, 88), edge);
  hu = lung(x, y, z, -1, length, vessels, hu);
  hu = lung(x, y, z, 1, length, vessels, hu);
  // Ribs: slabs of bone inside the wall, one every 27 mm, open at the back where the spine is.
  const wall = Math.max(ellipse(x, y, 0, 0, 158, 85), -ellipse(x, y, 0, 0, 150, 80.6));
  const slab = Math.abs((((z % 27) + 27) % 27) - 13.5) - 5;
  hu = blend(hu, 900, Math.max(Math.max(wall, slab), y - 65), edge);
  // Spine: a body with a dense rim around the spinal canal, behind; the sternum in front.
  hu = blend(hu, 1100, ellipse(x, y, 0, 65, 25, 17), edge);
  hu = blend(hu, 350, ellipse(x, y, 0, 65, 21, 14), edge);
  hu = blend(hu, 15, ellipse(x, y, 0, 72, 9.6, 5.8), edge);
  hu = blend(hu, 600, Math.max(Math.abs(x) - 11.5, Math.abs(y + 79) - 7), edge);
  // The heart sits low and to the left with blood inside, pressing into the left lung; the aorta descends beside the spine.
  const heartZ = length * 0.7;
  hu = blend(hu, 45, ellipsoid(x, y, z, 23, -11.5, heartZ, 52, 35, length * 0.35), edge);
  hu = blend(hu, 180, ellipsoid(x, y, z, 23, -11.5, heartZ, 31, 20, length * 0.21), edge);
  return blend(hu, 200, ellipse(x, y, -23, 40, 13.4, 10), edge);
}

// A dome from the apex near the top to the diaphragm, which rises under the heart; vessels branch from the hilum.
function lung(
  x: number,
  y: number,
  z: number,
  side: number,
  length: number,
  vessels: VesselTree,
  around: number,
): number {
  const edge = thoraxSpacing;
  const centre = side * 86;
  const across = Math.min(Math.max((x - centre) / 63, -1.5), 1.5);
  const shape = Math.max(
    ellipsoid(x, y, z, centre, -3, length * 0.5, 63, 66, length * 0.45),
    z - length * (0.9 - 0.12 * across * across),
  );
  if (shape > 2 * edge) {
    return around;
  }
  let inside = blend(-860 + 20 * Math.sin(x * 0.03 + y * 0.025 + z * 0.02), 35, vessels.distance(x, y, z), edge);
  if (side < 0) {
    inside = blend(inside, 40, ellipsoid(x, y, z, -96, -14, length * 0.4, 6.5, 5.5, 6), edge);
  }
  return blend(around, inside, shape, edge);
}

// Blends towards a value inside a shape: fully more than half a voxel inside, not at all half a voxel outside.
function blend(outside: number, inside: number, distance: number, voxel: number): number {
  const share = Math.min(Math.max(0.5 - distance / voxel, 0), 1);
  return outside + (inside - outside) * share;
}

// About the distance in millimetres from the surface of an ellipsoid, negative inside: its implicit value over its slope.
function ellipsoid(
  x: number,
  y: number,
  z: number,
  cx: number,
  cy: number,
  cz: number,
  a: number,
  b: number,
  c: number,
): number {
  const u = (x - cx) / a;
  const v = (y - cy) / b;
  const w = (z - cz) / c;
  const r = Math.sqrt(u * u + v * v + w * w);
  const slope = Math.sqrt((u / a) * (u / a) + (v / b) * (v / b) + (w / c) * (w / c));
  return r > 1e-9 && slope > 1e-12 ? ((r - 1) * r) / slope : -Math.min(a, b, c);
}

function ellipse(x: number, y: number, cx: number, cy: number, a: number, b: number): number {
  return ellipsoid(x, y, 0, cx, cy, 0, a, b, Number.POSITIVE_INFINITY);
}

// A fixed, even spread of noise from the place alone, so that every call gives the same volume.
function noise(x: number, y: number, z: number, amount: number): number {
  let hash = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, 0x5bd1e995) >>> 0;
  hash = (hash ^ (hash >>> 15)) >>> 0;
  const first = (hash & 0xffff) / 65535;
  const second = (hash >>> 16) / 65535;
  return (first + second - 1) * amount;
}

function store(hu: number): number {
  // Math.Round of .NET rounds halves to even.
  const value = hu - intercept;
  const floor = Math.floor(value);
  const rounded = value - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
  return Math.min(Math.max(rounded, 0), 65535);
}

interface Piece {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly radius: number;
}

class VesselTree {
  private static readonly cell = 16;
  private readonly pieces: Piece[] = [];
  private readonly cells = new Map<string, number[]>();

  constructor(length: number) {
    for (const side of [-1, 1]) {
      const hilum = new Point3D(side * 45, 0, 0.5 * length);
      for (const [dx, dy, dz] of [
        [0.4, 0, -1],
        [1, 0.2, 0],
        [0.4, 0.1, 1],
        [0.5, -1, 0.2],
        [0.5, 1, 0.2],
      ] as const) {
        this.grow(hilum, new Point3D(side * dx, dy, dz), 40, 6, 6);
      }
    }
    this.pieces.forEach((_, i) => {
      this.addToCells(i);
    });
  }

  distance(x: number, y: number, z: number): number {
    const near = this.cells.get(`${String(index(x))},${String(index(y))},${String(index(z))}`);
    if (!near) {
      return VesselTree.cell;
    }
    let best = VesselTree.cell;
    for (const i of near) {
      const piece = this.pieces[i] as Piece;
      const qx = x - piece.sx;
      const qy = y - piece.sy;
      const qz = z - piece.sz;
      const dd = piece.dx * piece.dx + piece.dy * piece.dy + piece.dz * piece.dz;
      const along = Math.min(Math.max((qx * piece.dx + qy * piece.dy + qz * piece.dz) / dd, 0), 1);
      const ex = qx - piece.dx * along;
      const ey = qy - piece.dy * along;
      const ez = qz - piece.dz * along;
      best = Math.min(best, Math.sqrt(ex * ex + ey * ey + ez * ez) - piece.radius);
    }
    return best;
  }

  // Two children per piece, turned apart by about 35° around the direction at a fixed but varied angle, each shorter
  // and thinner, down to vessels of about half a millimetre.
  private grow(start: Point3D, direction: Point3D, length: number, radius: number, levels: number): void {
    const unit = direction.times(1 / direction.length);
    const end = start.plus(unit.times(length));
    this.pieces.push({
      sx: start.x,
      sy: start.y,
      sz: start.z,
      dx: end.x - start.x,
      dy: end.y - start.y,
      dz: end.z - start.z,
      radius,
    });
    if (levels === 0) {
      return;
    }
    // Two directions across the piece.
    const helper = Math.abs(unit.z) < 0.9 ? new Point3D(0, 0, 1) : new Point3D(1, 0, 0);
    let first = Point3D.cross(unit, helper);
    first = first.times(1 / first.length);
    const second = Point3D.cross(unit, first);
    const turn = spread(end) * Math.PI * 2;
    const across = first.times(Math.cos(turn)).plus(second.times(Math.sin(turn)));
    const bend = 0.7;
    this.grow(end, unit.plus(across.times(bend)), length * 0.78, radius * 0.68, levels - 1);
    this.grow(end, unit.minus(across.times(bend * 0.8)), length * 0.72, radius * 0.62, levels - 1);
  }

  // Every cell the box around a piece touches, widened by its radius and a little more.
  private addToCells(i: number): void {
    const piece = this.pieces[i] as Piece;
    const reach = piece.radius + 2;
    const ex = piece.sx + piece.dx;
    const ey = piece.sy + piece.dy;
    const ez = piece.sz + piece.dz;
    for (let cx = index(Math.min(piece.sx, ex) - reach); cx <= index(Math.max(piece.sx, ex) + reach); cx++) {
      for (let cy = index(Math.min(piece.sy, ey) - reach); cy <= index(Math.max(piece.sy, ey) + reach); cy++) {
        for (let cz = index(Math.min(piece.sz, ez) - reach); cz <= index(Math.max(piece.sz, ez) + reach); cz++) {
          const key = `${String(cx)},${String(cy)},${String(cz)}`;
          let list = this.cells.get(key);
          if (!list) {
            list = [];
            this.cells.set(key, list);
          }
          list.push(i);
        }
      }
    }
  }
}

function index(value: number): number {
  return Math.floor(value / 16);
}

// A share from 0 to 1 that depends only on a place, so the tree is the same in every process.
function spread(place: Point3D): number {
  let hash =
    (Math.imul(Math.trunc(place.x * 16), 73856093) ^
      Math.imul(Math.trunc(place.y * 16), 19349663) ^
      Math.imul(Math.trunc(place.z * 16), 83492791)) >>>
    0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, 0x5bd1e995) >>> 0;
  hash = (hash ^ (hash >>> 15)) >>> 0;
  return (hash & 0xffffff) / 0x1000000;
}
