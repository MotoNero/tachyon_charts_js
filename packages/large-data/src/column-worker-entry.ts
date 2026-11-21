// The module a column worker runs; LargeColumn starts it.
import { serveColumn, type ColumnEndpoint } from './column-worker';

serveColumn(globalThis as unknown as ColumnEndpoint);
