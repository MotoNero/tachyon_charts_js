// One animation frame loop for all charts of a page, as the render thread of a device in the .NET version: each frame
// it lets every chart draw what changed, and charts of a render worker go to the worker as one batch. A worker that is
// two batches behind skips a frame for all its charts alike, so that no chart starves while others draw.
import { RemoteRenderDevice, type RenderDevice } from '@tachyon-charts/core';

/** A chart in the loop: it draws when it changed, on its device. */
export interface LoopMember {
  /** Draws a frame when the chart changed. */
  draw(): void;
  /** The device the chart draws on, once it has one. */
  device(): RenderDevice | undefined;
}

const members = new Set<LoopMember>();
const held = new Set<RemoteRenderDevice>();
const behind = new Set<RemoteRenderDevice>();
let handle = 0;

function tick(): void {
  handle = requestAnimationFrame(tick);
  for (const member of members) {
    const device = member.device();
    if (device instanceof RemoteRenderDevice && !held.has(device) && !behind.has(device)) {
      if (device.pendingBatches > 1) {
        behind.add(device);
      } else {
        device.hold();
        held.add(device);
      }
    }
  }
  for (const member of members) {
    const device = member.device();
    if (!(device instanceof RemoteRenderDevice && behind.has(device))) {
      member.draw();
    }
  }
  for (const device of held) {
    device.release();
  }
  held.clear();
  behind.clear();
}

/** Adds a chart to the loop; the loop runs while it has charts. */
export function joinFrameLoop(member: LoopMember): void {
  members.add(member);
  if (handle === 0) {
    handle = requestAnimationFrame(tick);
  }
}

/** Takes a chart out of the loop. */
export function leaveFrameLoop(member: LoopMember): void {
  members.delete(member);
  if (members.size === 0 && handle !== 0) {
    cancelAnimationFrame(handle);
    handle = 0;
  }
}
