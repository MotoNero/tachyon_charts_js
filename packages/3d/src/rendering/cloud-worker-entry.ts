// The module a worker for a large cloud runs: it takes one job and says its portions, see cloud-work.ts.
import { runCloudJob, type CloudJob, type CloudMessage } from './cloud-work';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<CloudJob>) => void) | null;
  postMessage(message: CloudMessage, transfer: Transferable[]): void;
};

scope.onmessage = (event) => {
  try {
    runCloudJob(event.data, (message, transfer) => {
      scope.postMessage(message, transfer);
    });
  } catch (error) {
    scope.postMessage({ kind: 'failed', message: error instanceof Error ? error.message : String(error) }, []);
  }
};
