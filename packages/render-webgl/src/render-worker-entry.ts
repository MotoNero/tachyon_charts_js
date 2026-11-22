// The module the render worker runs: it holds the WebGL 2 device and draws the frames a RemoteRenderDevice sends, on
// an OffscreenCanvas the page handed over. createWebGl2WorkerDevice starts it.
import { serveRenderRequests, type RenderEndpoint } from '@tachyon-charts/core';
import { createWebGl2Device } from './device';

serveRenderRequests(globalThis as unknown as RenderEndpoint, () => Promise.resolve(createWebGl2Device()));
