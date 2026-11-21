// The worker of the page "Line from a large file": on the first visit it writes a test file of 250 million float32
// values (1 GB) into the origin private file system: a slow wave with noise and five spikes hidden among the values.
import { ColumnFileWriter, opfsFile, syncHandleSink, type SyncAccessHandle } from '@tachyon-charts/large-data';

const scope = globalThis as unknown as Worker;

/** The rows of the five spikes. */
const spikes = [12_345_678, 61_000_003, 123_456_789, 187_654_321, 240_000_017];

scope.addEventListener('message', (event: MessageEvent<{ path: string; count: number }>) => {
  void (async () => {
    const { path, count } = event.data;
    const handle = (await opfsFile(path, true)) as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> };
    const writer = new ColumnFileWriter(syncHandleSink(await handle.createSyncAccessHandle()), {
      type: 'float32',
      xStart: 0,
      xStep: 1e-6,
    });
    // A table of the wave and a small generator of noise: cheaper than a sine per value.
    const wave = Float32Array.from({ length: 4096 }, (_, i) => Math.sin((i / 4096) * Math.PI * 2));
    let seed = 1;
    const chunk = new Float32Array(1 << 22);
    for (let first = 0; first < count; first += chunk.length) {
      const size = Math.min(chunk.length, count - first);
      for (let i = 0; i < size; i++) {
        const row = first + i;
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        chunk[i] =
          (wave[(row >>> 14) & 4095] as number) +
          0.25 * (wave[(row >>> 6) & 4095] as number) +
          (seed / 4_294_967_296 - 0.5) * 0.2;
      }
      for (const spike of spikes) {
        if (spike >= first && spike < first + size) {
          chunk[spike - first] = spike % 2 === 0 ? 4 : -4;
        }
      }
      await writer.append(size === chunk.length ? chunk : chunk.subarray(0, size));
      scope.postMessage({ progress: (first + size) / count });
    }
    await writer.close();
    scope.postMessage({ done: true });
  })();
});
