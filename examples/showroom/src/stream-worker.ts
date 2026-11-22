// The worker of the page "Data from a worker": it streams a noisy signal of four million points into the chart, in
// chunks of 20 000 points every 20 ms, through shared memory or in transferred blocks, whichever the page allows.
import { acceptDataLink, type DataEndpoint } from '@tachyon-charts/core';

const total = 4_000_000;
const chunk = 20_000;
const scope = globalThis as unknown as DataEndpoint;

async function stream(): Promise<void> {
  const writer = await acceptDataLink(scope);
  const x = new Float64Array(chunk);
  const y = new Float64Array(chunk);
  let written = 0;
  let level = 0;
  const timer = setInterval(() => {
    for (let i = 0; i < chunk; i++) {
      const t = (written + i) / 1000;
      level += (Math.random() - 0.5) * 0.02;
      x[i] = t;
      y[i] = Math.sin(t * 0.7) + 0.3 * Math.sin(t * 13.1) + level + (Math.random() - 0.5) * 0.1;
    }
    writer.append(x, y);
    written += chunk;
    if (written >= total) {
      clearInterval(timer);
      writer.flush();
    }
  }, 20);
}

void stream();
