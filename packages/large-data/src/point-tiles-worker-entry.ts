// The module a point tiles worker runs; PointTiles starts it.
import type { ColumnEndpoint } from './column-worker';
import { servePointTiles } from './point-tiles-worker';

servePointTiles(globalThis as unknown as ColumnEndpoint);
