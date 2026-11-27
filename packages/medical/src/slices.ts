// The three planes through a volume, as MedicalMprSliceBuffer of the .NET version: axial from above, coronal from the
// front and sagittal from the side, the head at the top, each with its spacing and directions in the patient.
import { Point3D, type VolumeData } from '@tachyon-charts/3d';
import { MedicalImageDisplay } from './image-display';
import { PatientOrientation, type ImageSpacing, type MedicalVolume } from './medical-image';

/** A plane through a volume: axial, coronal or sagittal. */
export type MedicalMprPlane = 'axial' | 'coronal' | 'sagittal';

/** A slice of a volume: its values row after row from the top, its size, spacing and directions. */
export interface MedicalSlice {
  /** The plane. */
  readonly plane: MedicalMprPlane;
  /** The values, row after row from the top. */
  readonly values: Float32Array;
  /** The columns. */
  readonly width: number;
  /** The rows. */
  readonly height: number;
  /** The spacing of the pixels in millimetres. */
  readonly spacing: ImageSpacing;
  /** The directions of the slice in the patient. */
  readonly orientation: PatientOrientation;
  /** The index of the slice in the volume. */
  readonly index: number;
}

/** @internal The size, spacing and directions of the slices of a plane. */
export function sliceShape(
  volume: MedicalVolume,
  plane: MedicalMprPlane,
): { width: number; height: number; spacing: ImageSpacing; orientation: PatientOrientation } {
  const data = volume.data;
  const spacing = volume.voxelSpacing;
  const orientation = volume.orientation;
  const up = orientation.normal.times(-1);
  switch (plane) {
    case 'axial':
      return { width: data.width, height: data.height, spacing: { row: spacing.y, column: spacing.x }, orientation };
    case 'coronal':
      return {
        width: data.width,
        height: data.depth,
        spacing: { row: spacing.z, column: spacing.x },
        orientation: new PatientOrientation(orientation.across, up),
      };
    default:
      return {
        width: data.height,
        height: data.depth,
        spacing: { row: spacing.z, column: spacing.y },
        orientation: new PatientOrientation(orientation.down, up),
      };
  }
}

/** @internal The slice of a plane nearest to a place in millimetres from the first voxel. */
export function sliceIndex(volume: MedicalVolume, plane: MedicalMprPlane, position: Point3D): number {
  const data = volume.data;
  const spacing = volume.voxelSpacing;
  switch (plane) {
    case 'axial':
      return nearest(position.z, spacing.z, data.depth);
    case 'coronal':
      return nearest(position.y, spacing.y, data.height);
    default:
      return nearest(position.x, spacing.x, data.width);
  }
}

function nearest(position: number, spacing: number, count: number): number {
  if (!Number.isFinite(position)) {
    throw new RangeError('The position must be finite.');
  }
  const voxel = position / spacing;
  if (voxel <= 0) {
    return 0;
  }
  if (voxel >= count - 1) {
    return count - 1;
  }
  return Math.floor(voxel + 0.5);
}

/** @internal A value of a slice: axial as stored, coronal and sagittal with the top of the volume at the top. */
export function sliceValue(
  data: VolumeData,
  plane: MedicalMprPlane,
  index: number,
  column: number,
  row: number,
): number {
  switch (plane) {
    case 'axial':
      return data.at(column, row, index);
    case 'coronal':
      return data.at(column, index, data.depth - 1 - row);
    default:
      return data.at(index, column, data.depth - 1 - row);
  }
}

/** The slices of a volume. */
export const MedicalSlices = {
  /**
   * The slice of a plane through a place in millimetres from the first voxel.
   * @throws RangeError when the place is not finite.
   */
  cut(volume: MedicalVolume, plane: MedicalMprPlane, position: Point3D): MedicalSlice {
    const shape = sliceShape(volume, plane);
    const index = sliceIndex(volume, plane, position);
    const values = new Float32Array(shape.width * shape.height);
    for (let row = 0; row < shape.height; row++) {
      for (let column = 0; column < shape.width; column++) {
        values[row * shape.width + column] = sliceValue(volume.data, plane, index, column, row);
      }
    }
    return { plane, values, index, ...shape };
  },

  /** The slice of a plane as an image to show, in the window of the volume. */
  display(volume: MedicalVolume, plane: MedicalMprPlane, position: Point3D): MedicalImageDisplay {
    const slice = MedicalSlices.cut(volume, plane, position);
    return new MedicalImageDisplay(
      slice.values,
      slice.width,
      slice.height,
      slice.spacing,
      slice.orientation,
      volume.modality?.toUpperCase() === 'CT' ? 'HU' : 'value',
      { center: volume.windowCenter, width: volume.windowWidth },
    );
  },
};
