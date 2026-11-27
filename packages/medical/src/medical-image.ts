// Images and volumes of medical scanners, as ImageSpacing, PatientOrientation and MedicalVolume of the .NET version:
// values with their spacing in millimetres and their directions in the patient, without any data about the patient.
import { Point3D, type VolumeData } from '@tachyon-charts/3d';

/** The distance between the middles of neighbouring pixels in millimetres. */
export interface ImageSpacing {
  /** From one row to the next. */
  readonly row: number;
  /** From one column to the next. */
  readonly column: number;
}

/** The directions of an image in the patient: x to the left, y backwards, z upwards (LPS). */
export class PatientOrientation {
  /**
   * @param across - The direction along a row, to the right in the picture.
   * @param down - The direction along a column, downwards in the picture.
   */
  constructor(
    /** The direction along a row. */
    readonly across: Point3D,
    /** The direction along a column. */
    readonly down: Point3D,
  ) {}

  /** The direction from one slice to the next: across × down, of length 1. */
  get normal(): Point3D {
    const cross = Point3D.cross(this.across, this.down);
    return cross.length > 0 ? cross.normalized() : cross;
  }
}

/** A window of values shown from black to white: its centre and width, as on a scanner. */
export class MedicalWindow {
  /**
   * @param name - The name, such as Brain.
   * @param center - The value in the middle.
   * @param width - The width of the values from black to white.
   */
  constructor(
    /** The name. */
    readonly name: string,
    /** The value in the middle. */
    readonly center: number,
    /** The width from black to white. */
    readonly width: number,
  ) {}

  /** The value shown black. */
  get minimum(): number {
    return this.center - this.width / 2;
  }

  /** The value shown white. */
  get maximum(): number {
    return this.center + this.width / 2;
  }

  /** Whether another window has the same name, centre and width. */
  equals(other: MedicalWindow): boolean {
    return this.name === other.name && this.center === other.center && this.width === other.width;
  }
}

/** The usual windows of CT in Hounsfield units. */
export const CtWindowPresets = {
  /** Brain: centre 40, width 80. */
  brain: new MedicalWindow('Brain', 40, 80),
  /** Bone: centre 400, width 1800. */
  bone: new MedicalWindow('Bone', 400, 1800),
  /** Lung: centre -600, width 1500. */
  lung: new MedicalWindow('Lung', -600, 1500),
} as const;

/** @internal Throws unless the spacing is finite and positive. */
export function checkSpacing(spacing: ImageSpacing): void {
  if (!(Number.isFinite(spacing.row) && spacing.row > 0 && Number.isFinite(spacing.column) && spacing.column > 0)) {
    throw new RangeError('Pixel spacing must be finite and positive.');
  }
}

/** @internal Throws unless the orientation has two finite, independent directions. */
export function checkOrientation(orientation: PatientOrientation): void {
  const across = orientation.across.length;
  const down = orientation.down.length;
  if (
    !Number.isFinite(across) ||
    !Number.isFinite(down) ||
    across === 0 ||
    down === 0 ||
    orientation.normal.length === 0
  ) {
    throw new RangeError('The orientation needs two finite, independent directions.');
  }
}

/** A volume of a scanner: its values with the spacing of its voxels and its place and directions in the patient. */
export class MedicalVolume {
  /** The spacing of the voxels in millimetres: x across a row, y down a column, z from slice to slice. */
  readonly voxelSpacing: Point3D;

  /**
   * @param data - The values, slice after slice.
   * @param inPlane - The spacing of the pixels of a slice.
   * @param sliceSpacing - The distance between slices in millimetres.
   * @param origin - The place of the first voxel in the patient, in millimetres.
   * @param orientation - The directions of a slice in the patient.
   * @param windowCenter - The centre of the window the file suggests, if any.
   * @param windowWidth - The width of that window, if any.
   * @param modality - The kind of scanner, such as CT or MR, if known.
   * @throws RangeError when a spacing, the origin or the orientation is not usable.
   */
  constructor(
    /** The values, slice after slice. */
    readonly data: VolumeData,
    inPlane: ImageSpacing,
    sliceSpacing: number,
    /** The place of the first voxel in the patient. */
    readonly origin: Point3D,
    /** The directions of a slice in the patient. */
    readonly orientation: PatientOrientation,
    /** The centre of the window the file suggests. */
    readonly windowCenter?: number,
    /** The width of the window the file suggests. */
    readonly windowWidth?: number,
    /** The kind of scanner. */
    readonly modality?: string,
  ) {
    checkSpacing(inPlane);
    if (!(Number.isFinite(sliceSpacing) && sliceSpacing > 0)) {
      throw new RangeError('Slice spacing must be finite and positive.');
    }
    if (![origin.x, origin.y, origin.z].every(Number.isFinite)) {
      throw new RangeError('The origin must be finite.');
    }
    checkOrientation(orientation);
    this.voxelSpacing = new Point3D(inPlane.column, inPlane.row, sliceSpacing);
  }
}
