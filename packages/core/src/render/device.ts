// The rendering interface: a device creates GPU resources and starts frames; a command list records one frame.
// Charts draw only through it, so that WebGPU, WebGL 2 and Canvas 2D are interchangeable.
import type { CommandList } from './commands';
import type { Disposable, GpuBuffer, GpuTexture } from './resources';
import type { BufferDesc, DeviceCapabilities, PixelSize, SurfaceHandle, TextureDesc } from './types';

/**
 * Thrown when a device stops working, for example after a driver reset. It is no error of the caller: the owner
 * creates a new device and builds all resources again.
 */
export class DeviceLostError extends Error {
  /**
   * @param message - What happened, as far as the backend knows.
   */
  constructor(message = 'The render device was lost.') {
    super(message);
    this.name = 'DeviceLostError';
  }
}

/** A surface frames are drawn into. */
export interface RenderTarget extends Disposable {
  /** The size in physical pixels. */
  readonly size: PixelSize;
  /** Physical pixels per CSS pixel. */
  readonly dpiScale: number;
}

/** A target that is not on screen; its content can be read back. */
export interface OffscreenRenderTarget extends RenderTarget {
  /**
   * Copies the content to the CPU once all submitted frames are done.
   * @returns The pixels, four bytes each (red, green, blue, alpha), rows top first, without padding.
   */
  readPixels(): Promise<Uint8Array>;
}

/** A target on a canvas; submitting a frame shows it. */
export interface SurfaceRenderTarget extends RenderTarget {
  /** Adapts the target to a new size or scale. A canvas without size gets no frames; callers stop drawing. */
  resize(size: PixelSize, dpiScale: number): void;
}

/**
 * Creates GPU resources and starts frames. A device and its resources belong to one thread (the main thread or one
 * worker). Disposing is idempotent; any other member of a disposed object throws. Disposing a device makes its
 * resources unusable, but they must still be disposed.
 */
export interface RenderDevice extends Disposable {
  /** What the device supports. */
  readonly capabilities: DeviceCapabilities;
  /** Whether the device stopped working. A lost device stays lost. */
  readonly isLost: boolean;
  /** Why the device was lost, once it is. */
  readonly lostReason: string | undefined;
  /**
   * Calls the listener once when the device is lost, at once if it already is.
   * @returns A function that removes the listener.
   */
  onLost(listener: (reason: string) => void): () => void;
  /** Makes the device behave as if it were lost, as a test hook. */
  simulateLoss(): void;
  /** Creates a buffer in GPU memory. */
  createBuffer(desc: BufferDesc): GpuBuffer;
  /** Creates a texture. */
  createTexture(desc: TextureDesc): GpuTexture;
  /** Creates a target that is not on screen and can be read back. */
  createOffscreenTarget(size: PixelSize, dpiScale: number): OffscreenRenderTarget;
  /** Creates a target that shows its frames on a surface, such as a canvas. */
  createSurfaceTarget(surface: SurfaceHandle, size: PixelSize, dpiScale: number): SurfaceRenderTarget;
  /**
   * Starts a frame. The next frame may reuse the returned object, so that frames do not allocate; do not keep it
   * after {@link CommandList.submit}.
   */
  beginFrame(target: RenderTarget): CommandList;
  /** Draw calls issued so far, a diagnostic counter. */
  readonly drawCallCount: number;
  /** Bytes written to buffers and textures so far, a diagnostic counter. */
  readonly uploadedByteCount: number;
  /** Resolves when all submitted work is done. */
  whenIdle(): Promise<void>;
}
