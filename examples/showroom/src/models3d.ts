// Models for the 3D pages: a large knot of tube made in code.
import { ModelFileData, Point3D } from '@tachyon-charts/3d';

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
