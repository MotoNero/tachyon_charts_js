// The module the render worker runs: it holds the Canvas 2D device and draws the frames a RemoteRenderDevice sends, on
// an OffscreenCanvas the page handed over. createCanvas2dWorkerDevice starts it.
import { serveRenderRequests, type RenderEndpoint } from '@tachyon-charts/core';
import { createCanvas2dDevice } from './device';

serveRenderRequests(globalThis as unknown as RenderEndpoint, () => Promise.resolve(createCanvas2dDevice()));
