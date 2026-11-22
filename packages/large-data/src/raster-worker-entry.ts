// The module a raster worker runs; LargeRaster starts it.
import type { ColumnEndpoint } from './column-worker';
import { serveRaster } from './raster-worker';

serveRaster(globalThis as unknown as ColumnEndpoint);
