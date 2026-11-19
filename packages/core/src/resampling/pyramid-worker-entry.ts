// The module a worker for pyramids runs: new Worker(new URL('@tachyon-charts/core/pyramid-worker', import.meta.url),
// { type: 'module' }).
import { servePyramidRequests, type MessageEndpoint } from './pyramid-worker';

servePyramidRequests(globalThis as unknown as MessageEndpoint);
