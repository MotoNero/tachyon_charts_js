// The module a recorder worker runs; ColumnRecorder starts it.
import { serveRecording } from './recorder-worker';

serveRecording(globalThis as unknown as Worker);
