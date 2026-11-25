/** Version of the package `@tachyon-charts/3d`. */
export const version = '0.1.0-dev';

export { Chart3DBuilder, scene3D } from './chart3d-builder';
export { Orbit3DModifier } from './rendering/orbit-modifier';
export type { SceneAxes } from './scene/axis-box';
export { Bars3D, type Bars3DOptions, type GridPlace } from './scene/bars';
export { Bubbles3D, type Bubbles3DOptions, type BubbleSizeUnit } from './scene/bubbles';
export { Camera3D, type CameraProjection, type CameraView, type Ray3D } from './scene/camera';
export { Matrix3D, Point3D } from './scene/matrix';
export { BoxMap, Line3D, Points3D, Scatter3D, type Line3DOptions, type Scatter3DOptions } from './scene/points';
export { Scene3D, type SceneElement } from './scene/scene';
export { evenContours, Surface3D, type Contours3D, type Material3D, type Surface3DOptions } from './scene/surface';
