// One animation frame loop for all charts of a page, as the render thread of a device in the .NET version: each frame
// it lets every chart draw what changed, and charts of a render worker go to the worker as one batch. A worker that is
// two batches behind skips a frame for all its charts alike, so that no chart starves while others draw. After a
// second without a frame the loop looks only ten times a second, until input or a new frame wakes it again.
import { RemoteRenderDevice, type RenderDevice } from '@tachyon-charts/core';

/** A chart in the loop: it draws when it changed, on its device. */
export interface LoopMember {
  /** Draws a frame when the chart changed; returns whether it drew. */
  draw(): boolean;
  /** The device the chart draws on, once it has one. */
  device(): RenderDevice | undefined;
}

// Frames without a change before the loop slows down, and the pause between looks then.
const idleFrames = 60;
const idlePause = 100;

const members = new Set<LoopMember>();
const held = new Set<RemoteRenderDevice>();
const behind = new Set<RemoteRenderDevice>();
let frame = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let quietFrames = 0;

function tick(): void {
  frame = 0;
  timer = undefined;
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
  let drew = behind.size > 0;
  for (const member of members) {
    const device = member.device();
    if (!(device instanceof RemoteRenderDevice && behind.has(device)) && member.draw()) {
      drew = true;
    }
  }
  for (const device of held) {
    device.release();
  }
  held.clear();
  behind.clear();
  quietFrames = drew ? 0 : quietFrames + 1;
  schedule();
}

function schedule(): void {
  if (members.size === 0 || frame !== 0 || timer !== undefined) {
    return;
  }
  if (quietFrames < idleFrames) {
    frame = requestAnimationFrame(tick);
  } else {
    timer = setTimeout(tick, idlePause);
  }
}

/** Adds a chart to the loop; the loop runs while it has charts. */
export function joinFrameLoop(member: LoopMember): void {
  members.add(member);
  wakeFrameLoop();
}

/** Takes a chart out of the loop. */
export function leaveFrameLoop(member: LoopMember): void {
  members.delete(member);
  if (members.size === 0) {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = 0;
    timer = undefined;
  }
}

/** Draws at the next animation frame again, such as after input or a change the loop cannot see coming. */
export function wakeFrameLoop(): void {
  quietFrames = 0;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  schedule();
}
