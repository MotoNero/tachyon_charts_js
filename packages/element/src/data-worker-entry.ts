// The module of the data worker <tachyon-chart> starts on cross-origin isolated pages: it builds the pyramids of the
// series from their values in shared memory, so that the main thread does not scan millions of values.
import { servePyramidRequests, type MessageEndpoint } from '@tachyon-charts/core';

servePyramidRequests(globalThis as unknown as MessageEndpoint);
