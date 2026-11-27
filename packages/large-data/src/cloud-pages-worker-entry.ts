// The module a cloud pages worker runs; buildCloudPagesInWorker starts it.
import type { ColumnEndpoint } from './column-worker';
import { serveCloudPages } from './cloud-pages-worker';

serveCloudPages(globalThis as unknown as ColumnEndpoint);
