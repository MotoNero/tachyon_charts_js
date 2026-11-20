// The module the render worker runs: it holds the WebGPU device and draws the frames a RemoteRenderDevice sends, on an
// OffscreenCanvas the page handed over. createWebGpuWorkerDevice starts it.
import { serveRenderRequests, type RenderEndpoint } from '@tachyon-charts/core';
import { createWebGpuDevice } from './device';

serveRenderRequests(globalThis as unknown as RenderEndpoint, () => createWebGpuDevice());
