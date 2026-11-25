// The camera that looks at the axis box from a direction and distance, as Camera3D of the .NET version.
import { Matrix3D, Point3D } from './matrix';

/** How the camera projects: with perspective or parallel. */
export type CameraProjection = 'perspective' | 'orthographic';

/** The views the camera can jump to. */
export type CameraView = 'default' | 'front' | 'side' | 'top';

const fieldOfView = Math.PI / 4;
// The width to height at and above which the box with its labels fits across. A narrower picture keeps that width of
// view and sees more above and below, so that the box does not reach out at the sides.
const fittingAspect = 1.2;
const maximumElevation = 89.5;
const minimumDistance = 0.5;
const maximumDistance = 20;
const maximumShift = 2;
const boxRadius = 1.8;
const defaultAzimuth = -55;
const defaultElevation = 25;
const defaultDistance = 4.9;

interface State {
  readonly azimuth: number;
  readonly elevation: number;
  readonly distance: number;
  readonly target: Point3D;
  readonly projection: CameraProjection;
}

/** A ray from the eye into the scene. */
export interface Ray3D {
  /** Where the ray starts. */
  readonly start: Point3D;
  /** Its direction, length 1. */
  readonly direction: Point3D;
}

// The remainder as Math.IEEERemainder: the quotient rounded to the nearest whole number, ties to even.
function ieeeRemainder(x: number, y: number): number {
  const quotient = x / y;
  const floor = Math.floor(quotient);
  const rest = quotient - floor;
  const rounded = rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
  return x - rounded * y;
}

function toDirection(azimuth: number, elevation: number): Point3D {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return new Point3D(Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e));
}

/** Looks at the axis box: turned by azimuth and elevation in degrees, from a distance, onto a target. */
export class Camera3D {
  private state: State = {
    azimuth: defaultAzimuth,
    elevation: defaultElevation,
    distance: defaultDistance,
    target: Point3D.zero,
    projection: 'perspective',
  };
  private changes = 0;

  /** The angle around the upward axis in degrees. */
  get azimuth(): number {
    return this.state.azimuth;
  }

  /** The angle above the floor in degrees. */
  get elevation(): number {
    return this.state.elevation;
  }

  /** The distance from the target, in units of the box, which reaches from -1 to 1. */
  get distance(): number {
    return this.state.distance;
  }

  /** The point the camera looks at. */
  get target(): Point3D {
    return this.state.target;
  }

  /** How the camera projects. */
  get projection(): CameraProjection {
    return this.state.projection;
  }

  set projection(value: CameraProjection) {
    this.change({ ...this.state, projection: value });
  }

  /** Where the eye is. */
  get eye(): Point3D {
    const state = this.state;
    return state.target.plus(toDirection(state.azimuth, state.elevation).times(state.distance));
  }

  /** Grows with every change. */
  get version(): number {
    return this.changes;
  }

  /** Turns the camera by degrees; the elevation stays below the poles. */
  orbit(azimuth: number, elevation: number): void {
    if (Number.isFinite(azimuth) && Number.isFinite(elevation)) {
      const state = this.state;
      this.change({
        ...state,
        azimuth: ieeeRemainder(state.azimuth + azimuth, 360),
        elevation: Math.min(Math.max(state.elevation + elevation, -maximumElevation), maximumElevation),
      });
    }
  }

  /** Moves the target across the view, in shares of the distance. */
  pan(right: number, up: number): void {
    if (Number.isFinite(right) && Number.isFinite(up)) {
      const state = this.state;
      const back = toDirection(state.azimuth, state.elevation);
      const side = Point3D.cross(new Point3D(0, 0, 1), back).normalized();
      const top = Point3D.cross(back, side);
      const target = state.target.plus(side.times(right).plus(top.times(up)).times(state.distance));
      const clamp = (value: number): number => Math.min(Math.max(value, -maximumShift), maximumShift);
      this.change({ ...state, target: new Point3D(clamp(target.x), clamp(target.y), clamp(target.z)) });
    }
  }

  /** Moves closer below 1 and away above. */
  zoom(factor: number): void {
    if (Number.isFinite(factor) && factor > 0) {
      const state = this.state;
      this.change({
        ...state,
        distance: Math.min(Math.max(state.distance * factor, minimumDistance), maximumDistance),
      });
    }
  }

  /** Jumps to a view, at the usual distance onto the middle of the box. */
  show(view: CameraView): void {
    let azimuth = defaultAzimuth;
    let elevation = defaultElevation;
    if (view === 'front') {
      [azimuth, elevation] = [-90, 0];
    } else if (view === 'side') {
      [azimuth, elevation] = [0, 0];
    } else if (view === 'top') {
      [azimuth, elevation] = [-90, maximumElevation];
    }
    this.change({ ...this.state, azimuth, elevation, distance: defaultDistance, target: Point3D.zero });
  }

  /** @internal The ray through a place in normalized device coordinates. */
  createRay(aspect: number, x: number, y: number): Ray3D {
    const matrix = this.createMatrix(aspect);
    const start = matrix.unproject(x, y, 0);
    return { start, direction: matrix.unproject(x, y, 1).minus(start).normalized() };
  }

  /** @internal The projection and view of a picture of a width to height. */
  createMatrix(aspect: number): Matrix3D {
    const state = this.state;
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    const eye = state.target.plus(toDirection(state.azimuth, state.elevation).times(state.distance));
    const view = Matrix3D.lookAt(eye, state.target, new Point3D(0, 0, 1));
    const near = Math.max(state.distance - boxRadius - state.target.length, state.distance * 0.01);
    const far = state.distance + boxRadius + state.target.length;
    const widen = Math.max(1, fittingAspect / safeAspect);
    const projection =
      state.projection === 'perspective'
        ? Matrix3D.perspective(2 * Math.atan(Math.tan(fieldOfView / 2) * widen), safeAspect, near, far)
        : Matrix3D.orthographic(2 * state.distance * Math.tan(fieldOfView / 2) * widen, safeAspect, near, far);
    return projection.times(view);
  }

  private change(state: State): void {
    const current = this.state;
    if (
      state.azimuth !== current.azimuth ||
      state.elevation !== current.elevation ||
      state.distance !== current.distance ||
      !state.target.equals(current.target) ||
      state.projection !== current.projection
    ) {
      this.state = state;
      this.changes++;
    }
  }
}
