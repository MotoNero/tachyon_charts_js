/** Version of the package @tachyon-charts/render-webgpu. */
export const version = '0.1.0-dev';

export { createWebGpuDevice, WebGpuDevice, type WebGpuDeviceOptions } from './device';
export { WebGpuFrame } from './frame';
export { WebGpuBuffer, WebGpuTexture } from './resources';
export { WebGpuOffscreenTarget, WebGpuSurfaceTarget, WebGpuTarget } from './targets';
export { PipelineCache } from './pipelines';
