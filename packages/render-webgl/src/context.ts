// What buffers, textures, targets and frames need of their device. They depend on this, not on the device itself,
// so that the device can create them without a circle of imports.
import type { DeviceCapabilities } from '@tachyon-charts/core';

export interface GlContext {
  readonly gl: WebGL2RenderingContext;
  readonly capabilities: DeviceCapabilities;
  /** The canvas of the context; surface targets show what is drawn on it. */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Draw calls issued so far. */
  drawCallCount: number;
  /** Bytes written to buffers and textures so far. */
  uploadedByteCount: number;
  /** Throws when the device is disposed or lost. */
  ensureUsable(): void;
}
