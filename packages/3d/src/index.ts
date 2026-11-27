/** Version of the package `@tachyon-charts/3d`. */
export const version = '0.1.0-dev';

export { Chart3DBuilder, scene3D } from './chart3d-builder';
export { Orbit3DModifier } from './rendering/orbit-modifier';
export { PointerPick3D } from './rendering/pick-labels';
export type { SceneAxes } from './scene/axis-box';
export { Bars3D, type Bars3DOptions, type GridPlace } from './scene/bars';
export { Bubbles3D, type Bubbles3DOptions, type BubbleSizeUnit } from './scene/bubbles';
export { PointFile, PointFileError, type PointFileReaders, type ReadProgress } from './files/point-file';
export { ModelFile, ModelFileData, ModelFileError, type ModelMeshOptions } from './files/model-file';
export { AntennaPattern3D, type AntennaCut, type AntennaLobe, type AntennaPattern3DOptions } from './scene/antenna';
export { ClipPlane3D, type ClipPlane3DOptions, type CutCurve } from './scene/clip-plane';
export { Shapes3D } from './scene/shapes';
export { CutCurveFeed, type CutMarker, type CutScene } from './scene/cut-feed';
export { MeasuredMap3D, type MeasuredMap3DOptions } from './scene/measured-map';
export { TransferFunction3D, type TransferPoint3D } from './scene/transfer';
export {
  describeGpuFit,
  Volume3D,
  VolumeData,
  type Volume3DOptions,
  type VolumeGpuFit,
  type VolumeHit,
  type VolumeMode,
  type VolumeValues,
} from './scene/volume';
export {
  PointCloud3D,
  type PointCloud3DOptions,
  type PointCloudArrays,
  type PointCloudLoad,
} from './scene/point-cloud';
export { Pie3D, type Pie3DOptions } from './scene/pie';
export type { Pick3D, Pick3DFinder, PickReach } from './scene/picking';
export { Mesh3D, type ColorScale3D, type Mesh3DOptions, type Vertex3D } from './scene/mesh';
export { Camera3D, type CameraProjection, type CameraView, type Ray3D } from './scene/camera';
export { Matrix3D, Point3D } from './scene/matrix';
export { BoxMap, Line3D, Points3D, Scatter3D, type Line3DOptions, type Scatter3DOptions } from './scene/points';
export { Scene3D, type SceneElement } from './scene/scene';
export { Waterfall3D, type Waterfall3DOptions, type WaterfallStyle } from './scene/waterfall';
export { evenContours, Surface3D, type Contours3D, type Material3D, type Surface3DOptions } from './scene/surface';
